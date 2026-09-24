import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { extractionResultSchema } from '@mnemosyne/contracts';
import {
  CoreMemoryService,
  ExtractionWorker,
  type EventRecord,
  type Extractor,
  type SessionRecord,
} from '@mnemosyne/core';
import { PostgresMemoryRepository } from '@mnemosyne/postgres';

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
const service = new CoreMemoryService(repository, { forgetSecret });
const extractor = explicitRememberExtractor();
const worker = new ExtractionWorker({
  repository,
  service,
  extractor,
  workerId,
  leaseMs,
  maxAttempts,
  backoffMs,
});

let stopping = false;
let shutdownTimer: NodeJS.Timeout | undefined;
let pollTimer: NodeJS.Timeout | undefined;
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

process.stdout.write(`Mnemosyne extraction worker ${workerId} started\n`);
while (!stopping) {
  try {
    const result = await worker.runOnce();
    if (!result) await delay(pollIntervalMs);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'unknown_worker_error';
    process.stderr.write(`Mnemosyne extraction worker error: ${code}\n`);
    await delay(pollIntervalMs);
  }
}
if (shutdownTimer) clearTimeout(shutdownTimer);
process.stdout.write(`Mnemosyne extraction worker ${workerId} stopped\n`);

function stop(signal: NodeJS.Signals): void {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`Mnemosyne extraction worker ${workerId} received ${signal}\n`);
  if (pollTimer) clearTimeout(pollTimer);
  shutdownTimer = setTimeout(() => {
    process.stderr.write('Mnemosyne extraction worker shutdown timed out\n');
    process.exitCode = 1;
    process.exit();
  }, shutdownTimeoutMs);
}

function explicitRememberExtractor(): Extractor {
  return {
    async extract({ session, events }: { session: SessionRecord; events: EventRecord[] }) {
      const candidates: unknown[] = [];
      for (const event of events) {
        if (!event.explicitMemoryRequest || event.role !== 'user') continue;
        const content = event.content.match(/^ricorda\s+(?:che\s+)?(.+)$/iu)?.[1]?.trim();
        if (!content) continue;
        candidates.push({
          sessionId: session.id,
          eventIds: [event.id],
          content,
          kind: 'instruction' as const,
          scope: { type: 'project' as const, id: session.projectId },
          epistemicBasis: 'user_asserted' as const,
          assessment: 'uncontested' as const,
          confidence: 1,
          sensitivity: 'normal' as const,
          activation: 'on_demand' as const,
        });
      }
      return extractionResultSchema.parse({ candidates });
    },
  };
}

function integerOption(value: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`invalid_worker_integer:${value}`);
  }
  return parsed;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    pollTimer = setTimeout(resolve, milliseconds);
  });
}
