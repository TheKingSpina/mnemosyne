#!/usr/bin/env node
/**
 * Synthetic load test against a throwaway PostgreSQL + pgvector container.
 *
 * Nothing here touches a real deployment. The container gets a random name on a
 * random free port and is removed on the way out, and the corpus is generated, so
 * there is nothing to clean up and no owner approval involved. That is the point:
 * the removed seed cannot be recreated, and a load test does not need it.
 *
 * It measures, on a corpus far larger than the real one:
 *   - bulk fill throughput, which is what grows the outbox and the vector index
 *   - the governed single-item write path, sampled
 *   - search and context latency percentiles at rising concurrency
 *   - whether latency degrades gracefully or collapses as readers pile up
 *
 * Usage: node scripts/load-test.mjs [--memories 10000] [--concurrency 1,4,8,16] [--keep]
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const memoryCount = Number(flag('memories', '10000'));
const concurrencies = flag('concurrency', '1,4,8,16')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const governedSample = Number(flag('governed-sample', '200'));
const keepContainer = args.includes('--keep');

const IMAGE = 'pgvector/pgvector:pg17';
const FORGET_SECRET = 'load-test-forget-secret-that-is-long-enough';
const PROJECT = 'load-test';
const SCOPE = { type: 'project', id: PROJECT };

const containerName = `mnemosyne-load-${randomBytes(4).toString('hex')}`;
const password = randomBytes(16).toString('hex');
const port = 5500 + Math.floor(Math.random() * 400);

// fromPool runs migrate(), which reads schema.sql from dist. tsc --build does
// not copy non-TypeScript assets, so the Dockerfile does it by hand and so does
// this script; without it the schema is simply missing and there are 0 tables.
const schemaSource = fileURLToPath(new URL('../packages/postgres/src/schema.sql', import.meta.url));
const schemaTarget = fileURLToPath(
  new URL('../packages/postgres/dist/schema.sql', import.meta.url),
);
await mkdir(dirname(schemaTarget), { recursive: true });
await copyFile(schemaSource, schemaTarget);

const coreUrl = new URL('../packages/core/dist/index.js', import.meta.url);
const postgresUrl = new URL('../packages/postgres/dist/index.js', import.meta.url);

const { CoreMemoryService, DeterministicEmbeddingProvider } = await import(coreUrl.pathname);
const { PostgresMemoryRepository, PostgresSemanticSearchIndex } = await import(
  postgresUrl.pathname
);
const { Pool } = await import('pg');

const docker = (...argv) => execFileAsync('docker', argv, { maxBuffer: 128 * 1024 * 1024 });

/**
 * Waits for a connection from the host, not from inside the container. A
 * container-level pg_isready can pass while the published port is still
 * refusing, and the first pool query then dies with a terminated connection.
 */
async function waitForPostgres(connectionString, attempts = 120) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const probe = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000 });
    try {
      await probe.query('SELECT 1');
      await probe.end();
      return;
    } catch (error) {
      lastError = error;
      await probe.end().catch(() => undefined);
      await sleep(1000);
    }
  }
  throw new Error(`load_test_postgres_never_ready:${lastError?.message ?? 'unknown'}`);
}

function summarise(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  const total = values.length;
  return {
    n: total,
    p50: Number(at(0.5).toFixed(2)),
    p95: Number(at(0.95).toFixed(2)),
    p99: Number(at(0.99).toFixed(2)),
    max: Number((sorted.at(-1) ?? 0).toFixed(2)),
    mean: total ? Number((values.reduce((a, b) => a + b, 0) / total).toFixed(2)) : 0,
  };
}

const VOCABULARY = [
  'pipeline',
  'provenance',
  'threshold',
  'telemetry',
  'reindex',
  'outbox',
  'corpus',
  'lexical',
  'semantic',
  'ranking',
  'governance',
  'approval',
  'lifecycle',
  'revision',
  'isolation',
  'calibration',
  'delegation',
  'consolidation',
  'retention',
  'embedding',
  'tombstone',
  'idempotency',
  'dashboard',
  'openapi',
  'postgres',
  'redis',
  'neo4j',
  'tailnet',
  'orbstack',
  'launchd',
  'npm',
  'vector',
  'index',
  'cache',
  'lease',
  'worker',
];
const contentFor = (index) => {
  const a = VOCABULARY[index % VOCABULARY.length];
  const b = VOCABULARY[(index * 7 + 3) % VOCABULARY.length];
  const c = VOCABULARY[(index * 13 + 5) % VOCABULARY.length];
  return `load fixture ${1000 + (index % 8999)}: ${a} ${b} ${c} stage ${index % 97}`;
};

async function main() {
  process.stdout.write(`container ${containerName} su 127.0.0.1:${port}\n`);
  await docker(
    'run',
    '-d',
    '--name',
    containerName,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    'POSTGRES_USER=load',
    '-e',
    'POSTGRES_DB=load',
    '-p',
    `127.0.0.1:${port}:5432`,
    IMAGE,
  );

  let pool;
  try {
    const connectionString = `postgresql://load:${password}@127.0.0.1:${port}/load`;
    await waitForPostgres(connectionString);
    pool = new Pool({ connectionString, max: 24, connectionTimeoutMillis: 10_000 });
    await pool.query('SELECT 1');

    const repository = await PostgresMemoryRepository.fromPool(pool);
    const { rows } = await pool.query(
      `SELECT count(*)::int AS tables FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    process.stdout.write(`schema applicato, ${rows[0].tables} tabelle\n`);
    const provider = new DeterministicEmbeddingProvider(64);
    const index = new PostgresSemanticSearchIndex(pool, {
      profile: provider.profile,
      dimensions: provider.dimensions,
    });
    const service = new CoreMemoryService(repository, {
      forgetSecret: FORGET_SECRET,
      embeddingProvider: provider,
      semanticSearchIndex: index,
      reporter: 'load-test',
    });

    const session = await service.openSession({ projectId: PROJECT, taskTitle: 'load test' });

    // 1. Governed single-item write path, sampled: this is the path a harness
    //    actually uses, one proposal at a time, with the full policy pipeline.
    const sample = Math.min(governedSample, memoryCount);
    const writeLatencies = [];
    const writeStarted = Date.now();
    for (let index = 0; index < sample; index += 1) {
      const started = process.hrtime.bigint();
      await service.proposeMemory(
        {
          sessionId: session.sessionId,
          content: contentFor(index),
          kind: 'fact',
          scope: SCOPE,
          epistemicBasis: 'user_asserted',
          assessment: 'uncontested',
          confidence: 1,
          sensitivity: 'normal',
          activation: 'on_demand',
          sourceEventIds: [],
        },
        { actor: 'owner', explicitDirective: true },
      );
      writeLatencies.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    const writeSeconds = (Date.now() - writeStarted) / 1000;
    process.stdout.write(
      `scrittura governata: ${sample} memorie in ${writeSeconds.toFixed(1)}s ` +
        `(${(sample / writeSeconds).toFixed(1)}/s)\n`,
    );
    process.stdout.write(`  ${JSON.stringify(summarise(writeLatencies))}\n`);

    // 2. Bulk fill to the target size through the repository, then one reindex.
    const remaining = memoryCount - sample;
    const bulkStarted = Date.now();
    const batch = 500;
    for (let offset = 0; offset < remaining; offset += batch) {
      // createMemory mints its own id, so the record it returns is the only
      // source of truth for the lifecycle update.
      const drafts = [];
      for (let n = 0; n < Math.min(batch, remaining - offset); n += 1) {
        const index = sample + offset + n;
        drafts.push({
          content: contentFor(index),
          kind: 'fact',
          scope: SCOPE,
          epistemicBasis: 'user_asserted',
          assessment: 'uncontested',
          confidence: 1,
          sensitivity: 'normal',
          activation: 'on_demand',
          sourceEventIds: [],
          sessionId: session.sessionId,
        });
      }
      const created = [];
      for (const draft of drafts) {
        created.push(await repository.createMemory(draft));
      }
      for (const record of created) {
        await repository.updateMemoryLifecycle(record.id, 'accepted');
      }
      if ((offset / batch) % 4 === 0) {
        process.stdout.write(`  riempimento ${sample + offset + created.length}/${memoryCount}\n`);
      }
    }
    const bulkSeconds = (Date.now() - bulkStarted) / 1000;
    process.stdout.write(
      `riempimento: ${remaining} memorie in ${bulkSeconds.toFixed(1)}s ` +
        `(${(remaining / bulkSeconds).toFixed(0)}/s)\n`,
    );

    const reindexStarted = Date.now();
    const reindexed = await service.reindexEmbeddings();
    process.stdout.write(
      `reindex: ${reindexed.indexed} memorie in ${((Date.now() - reindexStarted) / 1000).toFixed(1)}s\n`,
    );

    const health = await service.getEmbeddingIndexHealth();
    process.stdout.write(
      `indice: ${health.indexedForActiveProfile}/${health.memoryCount} indicizzate, ` +
        `mancanti ${health.missingCount}\n`,
    );

    const { rows: outboxRows } = await pool.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE processed_at IS NULL)::int AS pending
       FROM corpus_outbox`,
    );
    process.stdout.write(
      `outbox: ${outboxRows[0].total} righe, ${outboxRows[0].pending} non elaborate\n`,
    );

    // 3. Read latency at rising concurrency.
    const { rows: total } = await pool.query('SELECT count(*)::int AS n FROM memories');
    process.stdout.write(`corpus effettivo: ${total[0].n} memorie\n`);

    const probeFor = (i) => {
      const a = VOCABULARY[i % VOCABULARY.length];
      const b = VOCABULARY[(i * 7 + 3) % VOCABULARY.length];
      return `${a} ${b} stage ${i % 97}`;
    };

    for (const concurrency of concurrencies) {
      const latencies = [];
      const contextLatencies = [];
      let errors = 0;
      const perWorker = Math.ceil(40 / concurrency);
      const started = Date.now();
      await Promise.all(
        Array.from({ length: concurrency }, async (_, worker) => {
          for (let n = 0; n < perWorker; n += 1) {
            const probe = probeFor(worker * perWorker + n);
            const queryStarted = process.hrtime.bigint();
            try {
              await service.searchMemories({
                sessionId: session.sessionId,
                query: probe,
                limit: 20,
                offset: 0,
              });
              latencies.push(Number(process.hrtime.bigint() - queryStarted) / 1e6);
            } catch {
              errors += 1;
            }
            const contextStarted = process.hrtime.bigint();
            try {
              await service.resolveContext({
                sessionId: session.sessionId,
                query: probe,
                budgetTokens: 1200,
              });
              contextLatencies.push(Number(process.hrtime.bigint() - contextStarted) / 1e6);
            } catch {
              errors += 1;
            }
          }
        }),
      );
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      process.stdout.write(
        `concorrenza ${String(concurrency).padStart(2)}: ${latencies.length} ricerche + ` +
          `${contextLatencies.length} contesti in ${elapsed}s, ${errors} errori\n` +
          `  ricerca ${JSON.stringify(summarise(latencies))}\n` +
          `  contesto ${JSON.stringify(summarise(contextLatencies))}\n`,
      );
    }
  } finally {
    if (pool) await pool.end();
    if (!keepContainer) {
      await docker('rm', '-f', containerName).catch(() => undefined);
      process.stdout.write(`container ${containerName} rimosso\n`);
    } else {
      process.stdout.write(
        `container ${containerName} conservato: docker start ${containerName}\n`,
      );
    }
  }
}

await main();
