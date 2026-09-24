import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { CoreMemoryService, ExtractionWorker } from '@mnemosyne/core';
import { PostgresMemoryRepository } from '@mnemosyne/postgres';
import { ExplicitRememberExtractor } from './explicit-remember-extractor.js';
import { OpenRouterExtractor } from './provider-extractor.js';
import { ProviderRouter } from './provider-router.js';
import { Neo4jProjection } from './neo4j-projection.js';

const connectionString = process.env.DATABASE_URL;
const forgetSecret = process.env.MNEMOSYNE_FORGET_SECRET;
if (!connectionString || !forgetSecret) {
  throw new Error('DATABASE_URL and MNEMOSYNE_FORGET_SECRET are required');
}

const pollIntervalMs = integerOption(process.env.WORKER_POLL_INTERVAL_MS ?? '1000', 250);
const leaseMs = integerOption(process.env.WORKER_LEASE_MS ?? '30000', 1000);
const maxAttempts = integerOption(process.env.WORKER_MAX_ATTEMPTS ?? '3', 1);
const backoffMs = integerOption(process.env.WORKER_BACKOFF_MS ?? '1000', 0);
const shutdownTimeoutMs = integerOption(process.env.WORKER_SHUTDOWN_TIMEOUT_MS ?? '30000', 1000);
const workerId = process.env.WORKER_ID ?? `${hostname()}:${process.pid}:${randomUUID()}`;
const repository = await PostgresMemoryRepository.fromConnectionString(connectionString);
const service = new CoreMemoryService(repository, {
  forgetSecret,
  neo4jConfigured: Boolean(process.env.NEO4J_URI),
});
const extractor = createExtractor();
const retentionIntervalMs = integerOption(
  process.env.WORKER_RETENTION_INTERVAL_MS ?? '86400000',
  60_000,
);
const worker = new ExtractionWorker({
  repository,
  service,
  extractor,
  workerId,
  leaseMs,
  maxAttempts,
  backoffMs,
});
const neo4jUri = process.env.NEO4J_URI;
const neo4jUsername = process.env.NEO4J_USERNAME;
const neo4jPassword = process.env.NEO4J_PASSWORD;
const neo4jProjection =
  neo4jUri && neo4jUsername && neo4jPassword
    ? new Neo4jProjection(repository, {
        uri: neo4jUri,
        username: neo4jUsername,
        password: neo4jPassword,
        database: process.env.NEO4J_DATABASE,
        batchSize: integerOption(process.env.NEO4J_BATCH_SIZE ?? '100', 1),
      })
    : undefined;

let stopping = false;
let rebuildPending = process.env.NEO4J_REBUILD_ON_START === 'true';
let shutdownTimer: NodeJS.Timeout | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let wakePolling: (() => void) | undefined;
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

process.stdout.write(`Mnemosyne extraction worker ${workerId} started\n`);
let nextRetentionRun = Date.now() + retentionIntervalMs;
while (!stopping) {
  try {
    const result = await worker.runOnce();
    if (neo4jProjection && rebuildPending) {
      await neo4jProjection.rebuild();
      rebuildPending = false;
    }
    if (neo4jProjection) await neo4jProjection.runOnce();
    if (retentionIntervalMs > 0 && Date.now() >= nextRetentionRun) {
      await service.runRetention();
      nextRetentionRun = Date.now() + retentionIntervalMs;
    }
    if (!result) await delay(pollIntervalMs);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'unknown_worker_error';
    process.stderr.write(`Mnemosyne extraction worker error: ${code}\n`);
    await delay(pollIntervalMs);
  }
}
if (shutdownTimer) clearTimeout(shutdownTimer);
await neo4jProjection?.close();
process.stdout.write(`Mnemosyne extraction worker ${workerId} stopped\n`);

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`Mnemosyne extraction worker ${workerId} received ${signal}\n`);
  wakePolling?.();
  shutdownTimer = setTimeout(() => {
    process.stderr.write('Mnemosyne extraction worker shutdown timed out\n');
    process.exitCode = 1;
    process.exit();
  }, shutdownTimeoutMs);
}

function integerOption(value: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`invalid_worker_integer:${value}`);
  }
  return parsed;
}

function createExtractor(): ExplicitRememberExtractor | OpenRouterExtractor | ProviderRouter {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;
  const provider = process.env.EXTRACTION_PROVIDER ?? (apiKey && model ? 'openrouter' : 'local');
  if (!['local', 'openrouter', 'openrouter-local-fallback'].includes(provider)) {
    throw new Error('invalid_extraction_provider');
  }
  if (apiKey && model) {
    const openRouter = new OpenRouterExtractor({
      apiKey,
      model,
      requestTimeoutMs: integerOption(process.env.OPENROUTER_TIMEOUT_MS ?? '30000', 1000),
    });
    if (provider === 'openrouter-local-fallback') {
      return new ProviderRouter([
        { name: 'openrouter', extractor: openRouter },
        { name: 'local', extractor: new ExplicitRememberExtractor() },
      ]);
    }
    return openRouter;
  }
  if (apiKey || model) {
    throw new Error('OPENROUTER_API_KEY and OPENROUTER_MODEL must be configured together');
  }
  return new ExplicitRememberExtractor();
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    pollTimer = setTimeout(resolve, milliseconds);
    wakePolling = () => {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = undefined;
      wakePolling = undefined;
      resolve();
    };
  });
}
