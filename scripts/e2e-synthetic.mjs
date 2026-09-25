#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import process from 'node:process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, URLSearchParams } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = resolve(root, 'compose.yaml');
const project = `mnemosyne-e2e-${process.pid}-${Date.now()}`;
const ports = {
  api: await availablePort(),
  postgres: await availablePort(),
  redis: await availablePort(),
  neo4j: await availablePort(),
};
const ownerToken = `owner-${randomBytes(24).toString('hex')}`;
const harnessToken = `harness-${randomBytes(24).toString('hex')}`;
const forgetSecret = `forget-${randomBytes(24).toString('hex')}`;
const postgresPassword = `postgres-${randomBytes(24).toString('hex')}`;
const neo4jPassword = `neo4j-${randomBytes(24).toString('hex')}`;
const inheritedEnvironment = { ...process.env };
for (const key of Object.keys(inheritedEnvironment)) {
  if (
    /^(OPENROUTER_|MNEMOSYNE_|DATABASE_URL$|POSTGRES_|NEO4J_|REDIS_|API_|WORKER_|COMPOSE_)/u.test(
      key,
    )
  ) {
    delete inheritedEnvironment[key];
  }
}
const environment = {
  ...inheritedEnvironment,
  COMPOSE_PROJECT_NAME: project,
  POSTGRES_DB: 'mnemosyne_e2e',
  POSTGRES_USER: 'mnemosyne_e2e',
  POSTGRES_PASSWORD: postgresPassword,
  POSTGRES_PORT: String(ports.postgres),
  REDIS_PORT: String(ports.redis),
  NEO4J_PORT: String(ports.neo4j),
  NEO4J_USERNAME: 'neo4j',
  NEO4J_PASSWORD: neo4jPassword,
  API_PORT: String(ports.api),
  MNEMOSYNE_OWNER_TOKEN: ownerToken,
  MNEMOSYNE_HARNESS_TOKEN: harnessToken,
  MNEMOSYNE_FORGET_SECRET: forgetSecret,
  EXTRACTION_PROVIDER: 'local',
  OPENROUTER_API_KEY: '',
  OPENROUTER_MODEL: '',
  WORKER_RETENTION_INTERVAL_MS: '60000',
  NEO4J_REBUILD_ON_START: 'false',
};
const apiUrl = `http://127.0.0.1:${ports.api}`;
let stackStarted = false;
let backupTempDirectory;

try {
  stackStarted = true;
  compose('up', '-d', '--build', 'postgres', 'redis', 'neo4j', 'api', 'worker');
  await waitForApi();
  await waitForGraph();
  const lifecycle = await runLifecycle();
  stackStarted = true;
  compose('down', '--volumes', '--remove-orphans');
  stackStarted = false;
  stackStarted = true;
  compose('up', '-d', '--build', 'api');
  await waitForApi();
  await restoreAndVerify(lifecycle);
  process.stdout.write('Synthetic end-to-end flow: OK\n');
} catch (error) {
  if (stackStarted) {
    try {
      process.stderr.write(collectServiceLogs());
    } catch {
      // The original failure is more useful than a diagnostic-log failure.
    }
  }
  process.stderr.write(`Synthetic end-to-end flow failed: ${errorMessage(error)}\n`);
  process.exitCode = 1;
} finally {
  if (stackStarted) {
    try {
      compose('down', '--volumes', '--remove-orphans');
    } catch {
      process.stderr.write('Synthetic end-to-end cleanup failed\n');
    }
  }
  if (backupTempDirectory) await rm(backupTempDirectory, { recursive: true, force: true });
}

async function runLifecycle() {
  const session = await api('/v1/sessions', {
    token: harnessToken,
    method: 'POST',
    key: 'e2e-open-session',
    body: { projectId: 'e2e-synthetic', areaIds: ['e2e-area'] },
    status: 201,
  });
  const firstEvent = await api(`/v1/sessions/${encodeURIComponent(session.sessionId)}/events`, {
    token: harnessToken,
    method: 'POST',
    key: 'e2e-first-event',
    body: {
      events: [
        {
          eventId: 'e2e-event-1',
          type: 'message',
          role: 'user',
          content: 'Ricorda che il progetto usa npm',
          occurredAt: '2026-01-20T10:00:00.000Z',
          explicitMemoryRequest: true,
        },
      ],
    },
    status: 202,
  });
  await waitForJob(firstEvent.jobIds[0]);
  const firstPending = await waitForPending(session.sessionId, 'il progetto usa npm');
  const first = await review(firstPending, 'e2e-review-first');
  const secondEvent = await api(`/v1/sessions/${encodeURIComponent(session.sessionId)}/events`, {
    token: harnessToken,
    method: 'POST',
    key: 'e2e-second-event',
    body: {
      events: [
        {
          eventId: 'e2e-event-2',
          type: 'message',
          role: 'user',
          content: 'Ricorda che il progetto non usa npm',
          occurredAt: '2026-01-20T10:01:00.000Z',
          explicitMemoryRequest: true,
        },
      ],
    },
    status: 202,
  });
  await waitForJob(secondEvent.jobIds[0]);
  const secondPending = await waitForPending(session.sessionId, 'il progetto non usa npm');
  const second = await review(secondPending, 'e2e-review-second');

  const context = await api('/v1/context/resolve', {
    token: harnessToken,
    method: 'POST',
    body: {
      sessionId: session.sessionId,
      query: 'npm',
      budgetTokens: 1_200,
    },
  });
  assert(context.context.some((memory) => memory.memoryId === first.memory.memoryId));
  const search = await api(
    `/v1/memories?${new URLSearchParams({
      sessionId: session.sessionId,
      q: 'non usa npm',
    })}`,
    { token: harnessToken },
  );
  assert(search.items.some((memory) => memory.memoryId === second.memory.memoryId));
  const feedback = await api('/v1/memories/feedback', {
    token: ownerToken,
    method: 'POST',
    key: 'e2e-feedback',
    body: {
      memoryId: first.memory.memoryId,
      sessionId: session.sessionId,
      kind: 'useful',
      observedAt: '2026-01-20T10:02:00.000Z',
    },
    status: 201,
  });
  assert(feedback.memoryId === first.memory.memoryId);
  const retention = await api('/v1/admin/retention/run', {
    token: ownerToken,
    method: 'POST',
    key: 'e2e-retention',
    body: {},
  });
  assert(retention.profile === 'balanced');
  await waitForGraphCount(2);
  const exported = await api('/v1/admin/exports/corpus', { token: ownerToken });
  assert(exported.forgetLedger.length === 0);
  assert(exported.memories.length === 2);
  assert(exported.conflicts.length === 1);

  await searchToCreateCache(session.sessionId, second.memory.memoryId);
  const prepared = await api(
    `/v1/memories/${encodeURIComponent(second.memory.memoryId)}/forget/prepare`,
    {
      token: ownerToken,
      method: 'POST',
      body: {},
    },
  );
  const forgotten = await api(`/v1/memories/${encodeURIComponent(second.memory.memoryId)}/forget`, {
    token: ownerToken,
    method: 'POST',
    key: 'e2e-forget-second',
    body: { confirmationToken: prepared.confirmationToken },
    status: 204,
  });
  assert(forgotten === null);
  await waitForRedisEmpty();
  const afterForget = await api(
    `/v1/memories?${new URLSearchParams({
      sessionId: session.sessionId,
      q: 'non usa npm',
    })}`,
    { token: harnessToken },
  );
  assert(!afterForget.items.some((memory) => memory.memoryId === second.memory.memoryId));
  await waitForGraphAbsent(second.memory.memoryId);
  const finalExport = await api('/v1/admin/exports/corpus', { token: ownerToken });
  assert(finalExport.memories.some((memory) => memory.current.memoryId === first.memory.memoryId));
  assert(
    !finalExport.memories.some((memory) => memory.current.memoryId === second.memory.memoryId),
  );
  assert(finalExport.forgetLedger.length === 1);
  assert(finalExport.conflicts.length === 0);
  const closed = await api(`/v1/sessions/${encodeURIComponent(session.sessionId)}/close`, {
    token: harnessToken,
    method: 'POST',
    key: 'e2e-close-session',
    body: {},
    status: 202,
  });
  await waitForJob(closed.jobId);
  await verifyBackupLifecycle();
  return {
    export: finalExport,
    sourceCorpusRevision: finalExport.corpusRevision,
    firstId: first.memory.memoryId,
    secondId: second.memory.memoryId,
  };
}

async function verifyBackupLifecycle() {
  backupTempDirectory = await mkdtemp(join(tmpdir(), 'mnemosyne-e2e-backup-'));
  const passphrasePath = join(backupTempDirectory, 'backup.pass');
  const backupPath = join(backupTempDirectory, 'e2e.dump');
  await writeFile(passphrasePath, 'synthetic-e2e-backup-passphrase-long-enough\n', { mode: 0o600 });
  execFileSync(
    process.execPath,
    [
      resolve(root, 'scripts/backup-postgres.mjs'),
      '--output',
      backupPath,
      '--verify-restore',
      '--encrypt',
      '--passphrase-file',
      passphrasePath,
    ],
    { cwd: root, env: environment, stdio: 'inherit' },
  );
  execFileSync(
    process.execPath,
    [
      resolve(root, 'scripts/restore-postgres.mjs'),
      '--input',
      backupPath,
      '--target-database',
      'mnemosyne_e2e_restored',
      '--confirm',
      '--passphrase-file',
      passphrasePath,
    ],
    { cwd: root, env: environment, stdio: 'inherit' },
  );
}

async function restoreAndVerify(lifecycle) {
  const restored = await api('/v1/admin/restore/corpus', {
    token: ownerToken,
    method: 'POST',
    key: 'e2e-restore',
    body: lifecycle.export,
  });
  assert(restored.restored.forgetLedger === 1);
  assert(restored.corpusRevision !== lifecycle.sourceCorpusRevision);
  assert(restored.corpusRevision.endsWith(':1'));
  const first = await api(`/v1/memories/${encodeURIComponent(lifecycle.firstId)}`, {
    token: harnessToken,
  });
  assert(first.content === 'il progetto usa npm');
  const second = await api(`/v1/memories/${encodeURIComponent(lifecycle.secondId)}`, {
    token: harnessToken,
    status: 404,
  });
  assert(second.code === 'memory_not_found');
  const feedback = await api(
    `/v1/memories/feedback?${new URLSearchParams({ memoryId: lifecycle.firstId })}`,
    { token: ownerToken },
  );
  const retention = await api('/v1/admin/retention', { token: ownerToken });
  assert(feedback.items.length === 0);
  assert(retention.lastRunAt === undefined);
}

async function review(pending, key) {
  return api(`/v1/proposals/${encodeURIComponent(pending.memoryId)}/decision`, {
    token: ownerToken,
    method: 'POST',
    key,
    body: { expectedVersion: pending.currentVersion, decision: 'accept' },
  });
}

async function waitForPending(sessionId, content) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pending = await api(`/v1/proposals?${new URLSearchParams({ sessionId, limit: '100' })}`, {
      token: ownerToken,
    });
    const found = pending.items.find((memory) => memory.content === content);
    if (found) return found;
    await sleep(250);
  }
  throw new Error(`pending_not_found:${content}`);
}

async function searchToCreateCache(sessionId, memoryId) {
  const search = await api(
    `/v1/memories?${new URLSearchParams({
      sessionId,
      q: 'non usa npm',
    })}`,
    { token: harnessToken },
  );
  assert(search.items.some((memory) => memory.memoryId === memoryId));
}

async function waitForJob(jobId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await api(`/v1/jobs/${encodeURIComponent(jobId)}`, { token: harnessToken });
    if (job.status === 'succeeded') return;
    if (job.status === 'failed' || job.status === 'quarantined') {
      const attempts = await api(`/v1/admin/jobs/${encodeURIComponent(jobId)}/attempts`, {
        token: ownerToken,
      });
      throw new Error(`job_${job.status}:${JSON.stringify(attempts)}`);
    }
    await sleep(250);
  }
  throw new Error('job_timeout');
}

async function waitForApi() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const response = await globalThis.fetch(`${apiUrl}/health/ready`);
      if (response.ok) return;
    } catch {
      // Compose is still starting.
    }
    await sleep(500);
  }
  throw new Error('api_readiness_timeout');
}

async function waitForGraph() {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (tryGraphCount() !== null) return;
    await sleep(500);
  }
  throw new Error('neo4j_readiness_timeout');
}

async function waitForGraphCount(expected) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (tryGraphCount() === expected) return;
    await sleep(250);
  }
  throw new Error(`neo4j_projection_timeout:${expected}`);
}

async function waitForGraphAbsent(memoryId) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (tryGraphCount(`MATCH (m:Memory {id: ${quote(memoryId)}}) RETURN count(m);`) === 0) return;
    await sleep(250);
  }
  throw new Error('neo4j_forget_timeout');
}

function tryGraphCount(query = 'MATCH (m:Memory) RETURN count(m);') {
  try {
    const output = compose(
      'exec',
      '-T',
      'neo4j',
      'cypher-shell',
      '-u',
      environment.NEO4J_USERNAME,
      '-p',
      environment.NEO4J_PASSWORD,
      '--format',
      'plain',
      query,
    );
    const match = output.match(/(\d+)\s*$/u);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function redisKeys() {
  return compose('exec', '-T', 'redis', 'redis-cli', '--raw', '--scan', '--pattern', 'mnemosyne:*')
    .split('\n')
    .map((key) => key.trim())
    .filter(Boolean);
}

async function waitForRedisEmpty() {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (redisKeys().length === 0) return;
    await sleep(250);
  }
  throw new Error('redis_cache_forget_timeout');
}

async function api(path, options) {
  const headers = {
    accept: 'application/json',
    authorization: `Bearer ${options.token}`,
  };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.key) headers['idempotency-key'] = options.key;
  const response = await globalThis.fetch(`${apiUrl}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`invalid_json_response:${response.status}`);
    }
  }
  const expected = options.status ?? 200;
  if (response.status !== expected) {
    throw new Error(`http_${response.status}:${path}:${JSON.stringify(body)}`);
  }
  return body;
}

function compose(...args) {
  try {
    return execFileSync(
      'docker',
      ['compose', '--env-file', '/dev/null', '-p', project, '-f', composeFile, ...args],
      { cwd: root, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`docker_compose_failed:${detail}`, { cause: error });
  }
}

function collectServiceLogs() {
  return compose('logs', '--no-color', '--tail=100', 'api', 'worker', 'neo4j');
}

function assert(condition, message = 'synthetic_assertion_failed') {
  if (!condition) throw new Error(message);
}

function quote(value) {
  return JSON.stringify(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function availablePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('available_port_failed'));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}
