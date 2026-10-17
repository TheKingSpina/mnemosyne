import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { extractionProviderNameSchema, type ExtractionProviderName } from '@mnemosyne/contracts';
import { CoreMemoryService, ExtractionWorker, LlamaCppPruningJudge } from '@mnemosyne/core';
import { isInAnalyzerWindow, nextAnalyzerDueAt, parseAnalyzerWindow } from './schedule-window.js';
import { PostgresMemoryRepository, WORKER_CAPABILITY_COMPONENT } from '@mnemosyne/postgres';
import { RemotePruningAnalyzer } from '@mnemosyne/core';
import { ExplicitRememberExtractor } from './explicit-remember-extractor.js';
import { OpenRouterExtractor } from './provider-extractor.js';
import { ProviderRouter } from './provider-router.js';
import { Neo4jProjection } from './neo4j-projection.js';
import { ProjectionSupervisor } from './projection-supervisor.js';

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
const workerId = process.env.WORKER_ID || `${hostname()}:${process.pid}:${randomUUID()}`;
const pruningJudgeEnabled = process.env.PRUNING_JUDGE_ENABLED === 'true';
const pruningJudge =
  pruningJudgeEnabled &&
  process.env.PRUNING_JUDGE_RERANK_MODEL &&
  process.env.PRUNING_JUDGE_INSTRUCT_MODEL
    ? new LlamaCppPruningJudge({
        rerankModel: process.env.PRUNING_JUDGE_RERANK_MODEL,
        instructModel: process.env.PRUNING_JUDGE_INSTRUCT_MODEL,
        baseUrl: process.env.PRUNING_JUDGE_BASE_URL,
        rerankBaseUrl: process.env.PRUNING_JUDGE_RERANK_BASE_URL,
        apiKey: process.env.PRUNING_JUDGE_API_KEY,
      })
    : undefined;
if (pruningJudgeEnabled && !pruningJudge) {
  throw new Error(
    'PRUNING_JUDGE_RERANK_MODEL and PRUNING_JUDGE_INSTRUCT_MODEL are required when PRUNING_JUDGE_ENABLED=true',
  );
}
const repository = await PostgresMemoryRepository.fromConnectionString(connectionString);
const service = new CoreMemoryService(repository, {
  forgetSecret,
  reporter: 'worker',
  ...(pruningJudge === undefined ? {} : { pruningJudge }),
});
const extractor = createExtractor();
const extractionProviderName = resolveExtractionProviderName();
const retentionIntervalMs = integerOption(
  process.env.WORKER_RETENTION_INTERVAL_MS ?? '86400000',
  60_000,
);
// Analyzer schedule: weekly by default, 0 disables. Like retention it runs
// inline on the worker loop, and like retention it is inert without data to
// work on — plus inert without an analyzer at all.
const analyzerIntervalMs = integerOption(process.env.WORKER_ANALYZER_INTERVAL_MS ?? '604800000', 0);
const pruningAnalyzerEnabled = process.env.PRUNING_ANALYZER_ENABLED === 'true';
const pruningAnalyzer =
  pruningAnalyzerEnabled &&
  process.env.PRUNING_ANALYZER_API_KEY &&
  process.env.PRUNING_ANALYZER_MODEL
    ? new RemotePruningAnalyzer({
        apiKey: process.env.PRUNING_ANALYZER_API_KEY,
        model: process.env.PRUNING_ANALYZER_MODEL,
        baseUrl: process.env.PRUNING_ANALYZER_BASE_URL,
      })
    : null;
if (pruningAnalyzerEnabled && !pruningAnalyzer) {
  throw new Error('PRUNING_ANALYZER_API_KEY and PRUNING_ANALYZER_MODEL are required together');
}
// Optional night window "HH:MM-HH:MM" in container local time: the analyzer
// never runs outside it. The mini's window is documented as after the 02:00
// backup, so defaults stay off and a deployment opts in explicitly.
const analyzerWindow =
  pruningAnalyzer && process.env.WORKER_ANALYZER_WINDOW
    ? parseAnalyzerWindow(process.env.WORKER_ANALYZER_WINDOW)
    : null;
const capabilityHeartbeatMs = integerOption(
  process.env.WORKER_CAPABILITY_HEARTBEAT_MS ?? '60000',
  5_000,
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
const neo4jOutboxLeaseMs = integerOption(process.env.NEO4J_OUTBOX_LEASE_MS ?? '30000', 1000);
const neo4jProjection =
  neo4jUri && neo4jUsername && neo4jPassword
    ? new Neo4jProjection(repository, {
        uri: neo4jUri,
        username: neo4jUsername,
        password: neo4jPassword,
        database: process.env.NEO4J_DATABASE,
        batchSize: integerOption(process.env.NEO4J_BATCH_SIZE ?? '100', 1),
        consumerId: workerId,
        leaseMs: neo4jOutboxLeaseMs,
      })
    : undefined;
const projectionSupervisor = neo4jProjection
  ? new ProjectionSupervisor(neo4jProjection, {
      rebuildOnStart: process.env.NEO4J_REBUILD_ON_START === 'true',
      onError: (error) => {
        const code = error instanceof Error ? error.message : 'unknown_projection_error';
        process.stderr.write(`Mnemosyne derived projection error: ${code}\n`);
      },
    })
  : undefined;

let stopping = false;
let shutdownTimer: NodeJS.Timeout | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let wakePolling: (() => void) | undefined;
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

process.stdout.write(`Mnemosyne extraction worker ${workerId} started\n`);
let nextRetentionRun = Date.now() + retentionIntervalMs;
let nextAnalyzerRun = analyzerWindow
  ? nextAnalyzerDueAt(new Date(), analyzerWindow, analyzerIntervalMs)
  : Date.now() + analyzerIntervalMs;
let nextCapabilityHeartbeat = 0;
while (!stopping) {
  try {
    if (Date.now() >= nextCapabilityHeartbeat) {
      await publishCapabilities();
      nextCapabilityHeartbeat = Date.now() + capabilityHeartbeatMs;
    }
    const result = await worker.runOnce();
    await projectionSupervisor?.runOnce();
    if (retentionIntervalMs > 0 && Date.now() >= nextRetentionRun) {
      await service.runRetention();
      nextRetentionRun = Date.now() + retentionIntervalMs;
    }
    if (pruningAnalyzer && analyzerIntervalMs > 0 && Date.now() >= nextAnalyzerRun) {
      if (!analyzerWindow || isInAnalyzerWindow(new Date(), analyzerWindow)) {
        await service.runPruningAnalysis(pruningAnalyzer);
      }
      nextAnalyzerRun = nextAnalyzerDueAt(new Date(), analyzerWindow, analyzerIntervalMs);
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

function resolveExtractionProviderName(): ExtractionProviderName {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;
  const provider = process.env.EXTRACTION_PROVIDER ?? (apiKey && model ? 'openrouter' : 'local');
  const parsed = extractionProviderNameSchema.safeParse(provider);
  if (!parsed.success) throw new Error('invalid_extraction_provider');
  return parsed.data;
}

/**
 * Publishes the facts only this process owns, so the API and the MCP server can
 * report them instead of guessing. Idempotent, and a failure here is logged and
 * swallowed: losing a heartbeat must never stop extraction.
 */
async function publishCapabilities(): Promise<void> {
  try {
    await repository.reportRuntimeCapabilities(
      WORKER_CAPABILITY_COMPONENT,
      {
        neo4jConfigured: neo4jProjection !== undefined,
        openRouterConfigured: Boolean(process.env.OPENROUTER_API_KEY),
        extractionProvider: extractionProviderName,
        retentionScheduled: retentionIntervalMs > 0,
      },
      new Date().toISOString(),
    );
  } catch (error) {
    const code = error instanceof Error ? error.message : 'unknown_capability_report_error';
    process.stderr.write(`Mnemosyne capability heartbeat error: ${code}\n`);
  }
}

function createExtractor(): ExplicitRememberExtractor | OpenRouterExtractor | ProviderRouter {
  const provider = resolveExtractionProviderName();
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL;
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
