#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeCommand = [
  'compose',
  '--env-file',
  '/dev/null',
  ...(process.env.COMPOSE_PROJECT_NAME ? ['-p', process.env.COMPOSE_PROJECT_NAME] : []),
  '-f',
  'compose.yaml',
];
const options = parseArgs(process.argv.slice(2));
if (!options.output) {
  throw new Error(
    'usage: node scripts/backup-postgres.mjs --output /secure/path/backup.dump [--verify-restore] [--force]',
  );
}
if (isInside(root, resolveOutput(options.output))) {
  throw new Error('backup_output_must_be_outside_repository');
}

const outputPath = resolveOutput(options.output);
const temporaryOutputPath = `${outputPath}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
const user = process.env.POSTGRES_USER ?? 'mnemosyne';
const database = process.env.POSTGRES_DB ?? 'mnemosyne';

try {
  if (!options.force && (await exists(outputPath))) {
    throw new Error('backup_output_exists_use_force');
  }
  await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
  const dump = runDockerBuffer([
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
  ]);
  if (dump.byteLength === 0) throw new Error('postgres_backup_empty');
  await writeFile(temporaryOutputPath, dump, { mode: 0o600 });
  await rename(temporaryOutputPath, outputPath);
  await chmod(outputPath, 0o600);
  await verifyArchive(outputPath, user, options.verifyRestore);
  process.stdout.write(
    `PostgreSQL backup written: ${outputPath}${options.verifyRestore ? ' (restore verified)' : ''}\n`,
  );
} catch (error) {
  await rm(temporaryOutputPath, { force: true });
  throw error;
}

async function verifyArchive(path, postgresUser, restoreIt) {
  const containerPath = `/tmp/mnemosyne-backup-${process.pid}-${randomUUID()}.dump`;
  runDockerText([...composeCommand, 'cp', path, `postgres:${containerPath}`]);
  try {
    runDockerText([
      ...composeCommand,
      'exec',
      '-T',
      'postgres',
      'pg_restore',
      '--list',
      containerPath,
    ]);
    if (!restoreIt) return;
    const databaseName = `mnemosyne_backup_verify_${process.pid}_${Date.now()}`;
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
    try {
      runDockerText([
        ...composeCommand,
        'exec',
        '-T',
        'postgres',
        'pg_restore',
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '-U',
        postgresUser,
        '-d',
        databaseName,
        containerPath,
      ]);
      const counts = runDockerText([
        ...composeCommand,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        postgresUser,
        '-d',
        databaseName,
        '-At',
        '-c',
        "SELECT (SELECT count(*) FROM corpus_state)::text || ':' || (SELECT count(*) FROM forget_ledger)::text",
      ]).trim();
      if (!/^\d+:\d+$/u.test(counts)) throw new Error('postgres_restore_verification_failed');
    } finally {
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
    }
  } finally {
    runDockerText([...composeCommand, 'exec', '-T', 'postgres', 'rm', '-f', containerPath]);
  }
}

function runDockerText(args) {
  try {
    return execFileSync('docker', args, {
      cwd: root,
      env: process.env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`postgres_backup_command_failed:${detail.slice(0, 500)}`, { cause: error });
  }
}

function runDockerBuffer(args) {
  try {
    return execFileSync('docker', args, {
      cwd: root,
      env: process.env,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`postgres_backup_command_failed:${detail.slice(0, 500)}`, { cause: error });
  }
}

function parseArgs(args) {
  let output;
  let force = false;
  let verifyRestore = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output' || argument === '-o') {
      output = args[index + 1];
      index += 1;
      continue;
    }
    if (argument === '--force') {
      force = true;
      continue;
    }
    if (argument === '--verify-restore') {
      verifyRestore = true;
      continue;
    }
    throw new Error(`unknown_backup_argument:${argument}`);
  }
  if (output === undefined) return { output, force, verifyRestore };
  if (output.startsWith('-')) throw new Error('backup_output_required');
  return { output, force, verifyRestore };
}

function isInside(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

function resolveOutput(path) {
  return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
