#!/usr/bin/env node
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import process from 'node:process';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptBackup, encryptBackup, readBackupPassphrase } from './backup-crypto.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArgs(process.argv.slice(2));
if (!options.output) {
  throw new Error(
    'usage: node scripts/backup-postgres.mjs --output /secure/path/backup.dump [--verify-restore] [--encrypt --passphrase-file /secure/path/key] [--keep-days N --keep-last N] [--force]',
  );
}

const outputPath = resolveOutput(options.output);
if (isInside(root, outputPath)) throw new Error('backup_output_must_be_outside_repository');
const existingOutputParent = await nearestExistingRealPath(dirname(outputPath));
if (existingOutputParent && isInside(root, existingOutputParent)) {
  throw new Error('backup_output_must_be_outside_repository');
}
if (options.composeEnvFile !== '/dev/null') {
  const envPath = resolve(options.composeEnvFile);
  await assertSecureExternalFile(envPath, 'compose_env_file');
  options.composeEnvFile = envPath;
}
if (options.passphraseFile) {
  options.passphraseFile = await assertSecureExternalFile(
    resolve(options.passphraseFile),
    'backup_passphrase_file',
  );
}

const composeCommand = [
  'compose',
  '--env-file',
  options.composeEnvFile,
  ...(process.env.COMPOSE_PROJECT_NAME ? ['-p', process.env.COMPOSE_PROJECT_NAME] : []),
  '-f',
  'compose.yaml',
];
const user = options.postgresUser ?? process.env.POSTGRES_USER ?? 'mnemosyne';
const database = options.postgresDatabase ?? process.env.POSTGRES_DB ?? 'mnemosyne';
const temporaryOutputPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}.dump`;
const temporaryEncryptedPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}.enc`;
const temporaryDecryptedPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}.dump`;
const temporaryManifestPath = `${outputPath}.tmp-${process.pid}-${randomUUID()}.manifest.json`;
const manifestPath = `${outputPath}.manifest.json`;
const lockPath = `${outputPath}.lock`;
let lockHandle;
let publishedArtifact = false;
let previousArtifactPath;
let previousManifestPath;

try {
  const replacedExisting = await ensureOutputAvailable(outputPath, options.force);
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  lockHandle = await acquireLock(lockPath);
  if (replacedExisting) {
    previousArtifactPath = `${outputPath}.previous-${process.pid}-${randomUUID()}`;
    previousManifestPath = `${manifestPath}.previous-${process.pid}-${randomUUID()}`;
    await rename(outputPath, previousArtifactPath);
    if (await exists(manifestPath)) await rename(manifestPath, previousManifestPath);
  }
  const sourceCounts = await readDatabaseCounts(user, database);
  await runDockerToFile(
    [
      ...composeCommand,
      'exec',
      '-T',
      'postgres',
      'pg_dump',
      '-U',
      user,
      '-d',
      database,
      '--format=custom',
      '--no-owner',
      '--no-privileges',
    ],
    temporaryOutputPath,
  );
  const archiveVerification = await verifyArchive(
    temporaryOutputPath,
    user,
    sourceCounts,
    options.verifyRestore,
  );
  let artifactPath = temporaryOutputPath;
  let encrypted = false;
  if (options.encrypt) {
    if (!options.passphraseFile) throw new Error('backup_passphrase_file_required');
    const passphrase = await readBackupPassphrase(options.passphraseFile);
    const encryptedPayload = await encryptBackup(await readFile(temporaryOutputPath), passphrase);
    await writeFile(temporaryEncryptedPath, encryptedPayload, { mode: 0o600, flag: 'wx' });
    await writeFile(temporaryDecryptedPath, await decryptBackup(encryptedPayload, passphrase), {
      mode: 0o600,
      flag: 'wx',
    });
    const encryptedVerification = await verifyArchive(
      temporaryDecryptedPath,
      user,
      sourceCounts,
      options.verifyRestore,
    );
    artifactPath = temporaryEncryptedPath;
    encrypted = true;
    archiveVerification.restoreVerified = encryptedVerification.restoreVerified;
    archiveVerification.restoredCounts = encryptedVerification.restoredCounts;
    archiveVerification.countsMatch = encryptedVerification.countsMatch;
  }
  await syncFile(artifactPath);
  const artifactBytes = (await stat(artifactPath)).size;
  const artifactSha256 = await sha256File(artifactPath);
  await rename(artifactPath, outputPath);
  publishedArtifact = true;
  await chmod(outputPath, 0o600);
  const manifest = {
    schemaVersion: 1,
    tool: 'mnemosyne-postgres-backup',
    createdAt: new Date().toISOString(),
    database: { user, name: database },
    artifact: {
      file: basename(outputPath),
      bytes: artifactBytes,
      sha256: artifactSha256,
      encrypted,
      format: encrypted ? 'mnemosyne-aes-256-gcm' : 'pg_dump-custom',
    },
    verification: {
      archiveVerified: true,
      restoreVerified: archiveVerification.restoreVerified,
      countsMatch: archiveVerification.countsMatch,
      sourceCounts,
      restoredCounts: archiveVerification.restoredCounts,
    },
  };
  await writeFile(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  await syncFile(temporaryManifestPath);
  await rename(temporaryManifestPath, manifestPath);
  if (previousArtifactPath) await rm(previousArtifactPath, { force: true });
  if (previousManifestPath) await rm(previousManifestPath, { force: true });
  try {
    await pruneBackups({
      directory: dirname(outputPath),
      currentPath: outputPath,
      keepDays: options.keepDays,
      keepLast: options.keepLast,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`PostgreSQL backup retention failed: ${message.slice(0, 300)}\n`);
  }
  process.stdout.write(
    `PostgreSQL backup written: ${outputPath}${archiveVerification.restoreVerified ? ' (restore verified)' : ''}\n`,
  );
} catch (error) {
  if (previousArtifactPath) {
    await rm(outputPath, { force: true });
    try {
      await rename(previousArtifactPath, outputPath);
      if (previousManifestPath && (await exists(previousManifestPath))) {
        await rename(previousManifestPath, manifestPath);
      }
    } catch {
      await rm(previousArtifactPath, { force: true });
    }
  } else if (publishedArtifact) {
    await rm(manifestPath, { force: true });
  }
  throw error;
} finally {
  await rm(temporaryOutputPath, { force: true });
  await rm(temporaryEncryptedPath, { force: true });
  await rm(temporaryDecryptedPath, { force: true });
  await rm(temporaryManifestPath, { force: true });
  if (lockHandle) {
    await lockHandle.close().catch(() => undefined);
    await rm(lockPath, { force: true });
  }
}

async function ensureOutputAvailable(path, force) {
  let existing;
  try {
    existing = await lstat(path);
  } catch {
    return false;
  }
  if (existing.isSymbolicLink() || existing.isDirectory())
    throw new Error('backup_output_not_regular_file');
  if (!force) throw new Error('backup_output_exists_use_force');
  return true;
}

async function acquireLock(path) {
  try {
    const handle = await open(path, 'wx', 0o600);
    await handle.writeFile(`${process.pid}\n`);
    return handle;
  } catch {
    throw new Error('backup_already_running');
  }
}

async function assertSecureExternalFile(path, label) {
  const parent = await realpath(dirname(path)).catch(() => resolve(dirname(path)));
  const resolvedParent = await realpath(parent).catch(() => parent);
  if (isInside(root, resolvedParent) || isInside(root, path)) {
    throw new Error(`${label}_must_be_outside_repository`);
  }
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label}_must_be_regular_file`);
  if ((info.mode & 0o077) !== 0) throw new Error(`${label}_permissions_too_open`);
  return path;
}

async function readDatabaseCounts(postgresUser, postgresDatabase) {
  const query = [
    'sessions',
    'events',
    'memories',
    'memory_revisions',
    'conflicts',
    'jobs',
    'job_attempts',
    'forget_ledger',
    'corpus_state',
  ]
    .map((table) => `'${table}', (SELECT count(*) FROM ${table})`)
    .join(', ');
  const output = runDockerText([
    ...composeCommand,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    postgresUser,
    '-d',
    postgresDatabase,
    '-At',
    '-c',
    `SELECT json_build_object(${query})::text`,
  ]).trim();
  const counts = JSON.parse(output);
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) {
    throw new Error('postgres_counts_invalid');
  }
  return counts;
}

async function verifyArchive(path, postgresUser, sourceCounts, restoreIt) {
  const containerPath = `/tmp/mnemosyne-backup-${process.pid}-${randomUUID()}.dump`;
  let failure;
  let restoredCounts;
  let countsMatch = true;
  try {
    runDockerText([...composeCommand, 'cp', path, `postgres:${containerPath}`]);
    runDockerText([
      ...composeCommand,
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '--list',
      containerPath,
    ]);
    if (restoreIt) {
      const databaseName = `mnemosyne_backup_verify_${process.pid}_${Date.now()}`;
      let created = false;
      try {
        runDockerText([
          ...composeCommand,
          'exec',
          '-T',
          'postgres',
          'createdb',
          '-U',
          postgresUser,
          databaseName,
        ]);
        created = true;
        runDockerText([
          ...composeCommand,
          'exec',
          '-T',
          'postgres',
          'pg_restore',
          '--exit-on-error',
          '--single-transaction',
          '--no-owner',
          '--no-privileges',
          '-U',
          postgresUser,
          '-d',
          databaseName,
          containerPath,
        ]);
        restoredCounts = readDatabaseCountsIn(postgresUser, databaseName);
        countsMatch =
          JSON.stringify(sortedCounts(restoredCounts)) ===
          JSON.stringify(sortedCounts(sourceCounts));
        if (!countsMatch) {
          process.stderr.write('PostgreSQL counts changed while the backup was running\n');
        }
      } finally {
        if (created) {
          try {
            runDockerText([
              ...composeCommand,
              'exec',
              '-T',
              'postgres',
              'dropdb',
              '--if-exists',
              '-U',
              postgresUser,
              databaseName,
            ]);
          } catch (error) {
            failure ??= error;
          }
        }
      }
    }
  } catch (error) {
    failure ??= error;
  }
  try {
    runDockerText([...composeCommand, 'exec', '-T', 'postgres', 'rm', '-f', containerPath]);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  return { restoreVerified: restoreIt, restoredCounts, countsMatch };
}

function readDatabaseCountsIn(postgresUser, postgresDatabase) {
  const query = [
    'sessions',
    'events',
    'memories',
    'memory_revisions',
    'conflicts',
    'jobs',
    'job_attempts',
    'forget_ledger',
    'corpus_state',
  ]
    .map((table) => `'${table}', (SELECT count(*) FROM ${table})`)
    .join(', ');
  const output = runDockerText([
    ...composeCommand,
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    postgresUser,
    '-d',
    postgresDatabase,
    '-At',
    '-c',
    `SELECT json_build_object(${query})::text`,
  ]).trim();
  return JSON.parse(output);
}

function sortedCounts(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function pruneBackups({ directory, currentPath, keepDays, keepLast }) {
  if (keepDays === undefined && keepLast === undefined) return;
  const entries = await readdir(directory, { withFileTypes: true });
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.manifest.json')) continue;
    const manifestFile = join(directory, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    } catch {
      continue;
    }
    if (
      manifest?.tool !== 'mnemosyne-postgres-backup' ||
      manifest?.artifact?.file !== entry.name.slice(0, -'.manifest.json'.length) ||
      manifest?.verification?.archiveVerified !== true
    ) {
      continue;
    }
    const artifactPath = join(directory, manifest.artifact.file);
    if (artifactPath === currentPath) continue;
    const artifactInfo = await lstat(artifactPath).catch(() => undefined);
    if (!artifactInfo?.isFile() || artifactInfo.isSymbolicLink()) continue;
    candidates.push({ manifestFile, artifactPath, createdAt: Date.parse(manifest.createdAt) });
  }
  candidates.sort((left, right) => right.createdAt - left.createdAt);
  const cutoff = keepDays === undefined ? undefined : Date.now() - keepDays * 24 * 60 * 60 * 1_000;
  for (const [index, candidate] of candidates.entries()) {
    const oldEnough = cutoff === undefined || candidate.createdAt < cutoff;
    const outsideKeepLast = keepLast === undefined || index >= keepLast;
    if (!oldEnough || !outsideKeepLast) continue;
    if (
      (await sha256File(candidate.artifactPath)) !==
      (await readManifestHash(candidate.manifestFile))
    ) {
      continue;
    }
    await rm(candidate.artifactPath, { force: true });
    await rm(candidate.manifestFile, { force: true });
  }
}

async function readManifestHash(path) {
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  return manifest.artifact.sha256;
}

async function sha256File(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function syncFile(path) {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function runDockerText(args) {
  try {
    return execFileSync('docker', args, {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`postgres_backup_command_failed:${detail.slice(0, 500)}`, { cause: error });
  }
}

function runDockerToFile(args, destination) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, {
      cwd: root,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    let stderr = '';
    let childClosed = false;
    let outputClosed = false;
    let childCode;
    let childSignal;
    let childError;
    let outputError;
    const settle = () => {
      if (!childClosed || !outputClosed) return;
      if (childError) {
        reject(childError);
      } else if (outputError) {
        reject(outputError);
      } else if (childCode !== 0) {
        const detail = `${childSignal ?? ''} ${stderr}`.trim().slice(0, 500);
        reject(new Error(`postgres_backup_command_failed:${detail}`));
      } else {
        resolve();
      }
    };
    child.on('error', (error) => {
      childError = error;
      childClosed = true;
      settle();
    });
    child.on('close', (code, signal) => {
      childClosed = true;
      childCode = code;
      childSignal = signal;
      settle();
    });
    output.on('error', (error) => {
      outputError = error;
      child.kill('SIGTERM');
      outputClosed = true;
      settle();
    });
    output.on('close', () => {
      outputClosed = true;
      settle();
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 8_192) stderr += chunk.toString();
    });
    child.stdout.pipe(output);
  });
}

function parseArgs(args) {
  let output;
  let force = false;
  let verifyRestore = false;
  let encrypt = false;
  let passphraseFile;
  let keepDays;
  let keepLast;
  let composeEnvFile = '/dev/null';
  let postgresUser;
  let postgresDatabase;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output' || argument === '-o') {
      output = requiredValue(args, ++index, 'backup_output_required');
    } else if (argument === '--verify-restore') {
      verifyRestore = true;
    } else if (argument === '--encrypt') {
      encrypt = true;
    } else if (argument === '--passphrase-file') {
      passphraseFile = requiredValue(args, ++index, 'backup_passphrase_file_required');
    } else if (argument === '--keep-days') {
      keepDays = positiveInteger(
        requiredValue(args, ++index, 'backup_keep_days_invalid'),
        'backup_keep_days_invalid',
      );
    } else if (argument === '--keep-last') {
      keepLast = positiveInteger(
        requiredValue(args, ++index, 'backup_keep_last_invalid'),
        'backup_keep_last_invalid',
      );
    } else if (argument === '--compose-env-file') {
      composeEnvFile = requiredValue(args, ++index, 'backup_compose_env_file_required');
    } else if (argument === '--postgres-user') {
      postgresUser = requiredValue(args, ++index, 'backup_postgres_user_required');
    } else if (argument === '--postgres-database') {
      postgresDatabase = requiredValue(args, ++index, 'backup_postgres_database_required');
    } else if (argument === '--force') {
      force = true;
    } else {
      throw new Error(`unknown_backup_argument:${argument}`);
    }
  }
  if (keepLast !== undefined && keepLast < 1) throw new Error('backup_keep_last_invalid');
  return {
    output,
    force,
    verifyRestore,
    encrypt,
    passphraseFile,
    keepDays,
    keepLast,
    composeEnvFile,
    postgresUser,
    postgresDatabase,
  };
}

function requiredValue(args, index, code) {
  const value = args[index];
  if (value === undefined || value.startsWith('-')) throw new Error(code);
  return value;
}

function positiveInteger(value, code) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(code);
  return parsed;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function nearestExistingRealPath(path) {
  let candidate = path;
  while (true) {
    try {
      return await realpath(candidate);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return undefined;
      candidate = parent;
    }
  }
}

function isInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

function resolveOutput(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}
