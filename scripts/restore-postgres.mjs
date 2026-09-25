#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptBackup, readBackupPassphrase } from './backup-crypto.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const options = parseArgs(process.argv.slice(2));
if (!options.input || !options.targetDatabase || !options.confirm) {
  throw new Error(
    'usage: node scripts/restore-postgres.mjs --input /secure/path/backup.dump --target-database mnemosyne_restore --confirm [--passphrase-file /secure/path/key]',
  );
}
if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(options.targetDatabase)) {
  throw new Error('restore_target_database_invalid');
}

const inputPath = resolve(options.input);
const manifestPath = `${inputPath}.manifest.json`;
await assertRegularFile(inputPath, 'restore_input');
await assertRegularFile(manifestPath, 'restore_manifest');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
if (
  manifest?.tool !== 'mnemosyne-postgres-backup' ||
  manifest?.verification?.archiveVerified !== true
) {
  throw new Error('restore_manifest_invalid');
}
if (manifest.artifact?.file !== basename(inputPath)) throw new Error('restore_manifest_mismatch');
if (manifest.artifact.sha256 !== (await sha256File(inputPath))) {
  throw new Error('restore_checksum_mismatch');
}
const composeEnvFile = await resolveComposeEnvFile(options.composeEnvFile);
const composeCommand = [
  'compose',
  '--env-file',
  composeEnvFile,
  ...(process.env.COMPOSE_PROJECT_NAME ? ['-p', process.env.COMPOSE_PROJECT_NAME] : []),
  '-f',
  'compose.yaml',
];
const user = options.postgresUser ?? process.env.POSTGRES_USER ?? 'mnemosyne';
const sourceDatabase =
  options.postgresDatabase ?? manifest.database?.name ?? process.env.POSTGRES_DB ?? 'mnemosyne';
if (options.targetDatabase === sourceDatabase)
  throw new Error('restore_target_must_differ_from_source');
const containerPath = `/tmp/mnemosyne-restore-${process.pid}-${randomSuffix()}.dump`;
const temporaryDecryptedPath = `${inputPath}.tmp-${process.pid}-${randomSuffix()}.dump`;
let createdTarget = false;
let completed = false;

try {
  let restoreInput = inputPath;
  if (manifest.artifact.encrypted) {
    if (!options.passphraseFile) throw new Error('restore_passphrase_file_required');
    const passphraseFile = await assertSecureExternalFile(
      resolve(options.passphraseFile),
      'restore_passphrase_file',
    );
    const decrypted = await decryptBackup(
      await readFile(inputPath),
      await readBackupPassphrase(passphraseFile),
    );
    await writeFile(temporaryDecryptedPath, decrypted, { mode: 0o600, flag: 'wx' });
    restoreInput = temporaryDecryptedPath;
  }
  runDockerText([...composeCommand, 'cp', restoreInput, `postgres:${containerPath}`]);
  runDockerText([
    ...composeCommand,
    'exec',
    '-T',
    'postgres',
    'pg_restore',
    '--list',
    containerPath,
  ]);
  runDockerText([
    ...composeCommand,
    'exec',
    '-T',
    'postgres',
    'createdb',
    '-U',
    user,
    options.targetDatabase,
  ]);
  createdTarget = true;
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
    user,
    '-d',
    options.targetDatabase,
    containerPath,
  ]);
  const counts = readCounts(user, options.targetDatabase);
  const expected = manifest.verification.sourceCounts;
  const countsMatch =
    !expected || JSON.stringify(sorted(counts)) === JSON.stringify(sorted(expected));
  if (!countsMatch) {
    process.stderr.write('PostgreSQL restored counts differ from the recorded source counts\n');
  }
  completed = true;
  process.stdout.write(`PostgreSQL restore completed: ${options.targetDatabase}\n`);
} catch (error) {
  if (createdTarget && !completed) {
    try {
      runDockerText([
        ...composeCommand,
        'exec',
        '-T',
        'postgres',
        'dropdb',
        '--if-exists',
        '-U',
        user,
        options.targetDatabase,
      ]);
    } catch {
      void 0;
    }
  }
  throw error;
} finally {
  try {
    runDockerText([...composeCommand, 'exec', '-T', 'postgres', 'rm', '-f', containerPath]);
  } finally {
    await rm(temporaryDecryptedPath, { force: true });
  }
}

async function resolveComposeEnvFile(path) {
  if (path === '/dev/null') return path;
  return assertSecureExternalFile(resolve(path), 'compose_env_file');
}

async function assertSecureExternalFile(path, label) {
  if (isInside(root, path)) throw new Error(`${label}_must_be_outside_repository`);
  const parent = await nearestExistingRealPath(dirname(path));
  if (parent && isInside(root, parent)) {
    throw new Error(`${label}_must_be_outside_repository`);
  }
  await assertRegularFile(path, label);
  const info = await lstat(path);
  if ((info.mode & 0o077) !== 0) throw new Error(`${label}_permissions_too_open`);
  return path;
}

async function assertRegularFile(path, label) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label}_must_be_regular_file`);
}

function readCounts(postgresUser, database) {
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
  return JSON.parse(
    runDockerText([
      ...composeCommand,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      postgresUser,
      '-d',
      database,
      '-At',
      '-c',
      `SELECT json_build_object(${query})::text`,
    ]).trim(),
  );
}

function sorted(value) {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
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
    throw new Error(`postgres_restore_command_failed:${detail.slice(0, 500)}`, { cause: error });
  }
}

async function sha256File(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function randomSuffix() {
  return randomUUID().replaceAll('-', '').slice(0, 16);
}

function parseArgs(args) {
  let input;
  let targetDatabase;
  let confirm = false;
  let passphraseFile;
  let composeEnvFile = '/dev/null';
  let postgresUser;
  let postgresDatabase;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--input' || argument === '-i') {
      input = requiredValue(args, ++index, 'restore_input_required');
    } else if (argument === '--target-database') {
      targetDatabase = requiredValue(args, ++index, 'restore_target_database_required');
    } else if (argument === '--confirm') {
      confirm = true;
    } else if (argument === '--passphrase-file') {
      passphraseFile = requiredValue(args, ++index, 'restore_passphrase_file_required');
    } else if (argument === '--compose-env-file') {
      composeEnvFile = requiredValue(args, ++index, 'restore_compose_env_file_required');
    } else if (argument === '--postgres-user') {
      postgresUser = requiredValue(args, ++index, 'restore_postgres_user_required');
    } else if (argument === '--postgres-database') {
      postgresDatabase = requiredValue(args, ++index, 'restore_postgres_database_required');
    } else {
      throw new Error(`unknown_restore_argument:${argument}`);
    }
  }
  return {
    input,
    targetDatabase,
    confirm,
    passphraseFile,
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
