#!/usr/bin/env node
/**
 * Synthetic load test against throwaway PostgreSQL + pgvector and Redis
 * containers.
 *
 * Nothing here touches a real deployment. The containers get random names on
 * random free ports and are removed on the way out, and the corpus is generated,
 * so there is nothing to clean up and no owner approval involved. That is the
 * point: the removed seed cannot be recreated, and a load test does not need it.
 *
 * The cache is measured, not assumed. Three shapes, because "the cache makes it
 * fast" is only meaningful against a number:
 *
 *   uncached, distinct   the worst case for a new query: full ranking
 *   cached, distinct     same queries with a cache in front, so every one is a miss
 *   cached, repeated     the case the cache exists for, which is where
 *                        revalidateCachedMemories pays one getMemory query per
 *                        cached result, so the hit path is not free
 *
 * The last phase repeats that at growing result limits, to test whether that
 * per-result revalidation scales with the page size rather than with the corpus.
 *
 * Usage: node scripts/load-test.mjs [--memories 10000] [--concurrency 1,4,8,16]
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

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
const hitsPerPhase = Number(flag('hits', '200'));

const IMAGE = 'pgvector/pgvector:pg17';
const REDIS_IMAGE = 'redis:7.4-alpine';
const FORGET_SECRET = 'load-test-forget-secret-that-is-long-enough';
const PROJECT = 'load-test';
const SCOPE = { type: 'project', id: PROJECT };

const suffix = randomBytes(4).toString('hex');
const postgresName = `mnemosyne-load-pg-${suffix}`;
const redisName = `mnemosyne-load-redis-${suffix}`;
const password = randomBytes(16).toString('hex');
const postgresPort = 5500 + Math.floor(Math.random() * 400);
const redisPort = 6500 + Math.floor(Math.random() * 400);

// fromPool runs migrate(), which reads schema.sql from dist. tsc --build does
// not copy non-TypeScript assets, so the Dockerfile does it by hand and so does
// this script; without it the schema is simply missing and there are 0 tables.
const schemaSource = fileURLToPath(new URL('../packages/postgres/src/schema.sql', import.meta.url));
const schemaTarget = fileURLToPath(
  new URL('../packages/postgres/dist/schema.sql', import.meta.url),
);
await mkdir(dirname(schemaTarget), { recursive: true });
await copyFile(schemaSource, schemaTarget);

const { CoreMemoryService, DeterministicEmbeddingProvider } = await import(
  new URL('../packages/core/dist/index.js', import.meta.url).pathname
);
const { PostgresMemoryRepository, PostgresSemanticSearchIndex } = await import(
  new URL('../packages/postgres/dist/index.js', import.meta.url).pathname
);
const { RedisCorpusCache } = await import(
  new URL('../apps/api/dist/redis-cache.js', import.meta.url).pathname
);
const { Pool } = await import('pg');

const docker = (...argv) => execFileAsync('docker', argv, { maxBuffer: 128 * 1024 * 1024 });

function summarise(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (fraction) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
  const total = values.length;
  return {
    n: total,
    p50: Number(at(0.5).toFixed(2)),
    p95: Number(at(0.95).toFixed(2)),
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

// Distinct probes, so a "distinct" phase is genuinely all cache misses.
const probeFor = (n) => {
  const a = VOCABULARY[n % VOCABULARY.length];
  const b = VOCABULARY[(n * 7 + 3) % VOCABULARY.length];
  return `${a} ${b} stage ${n % 97}`;
};

async function timeQueries(service, sessionId, queries, run) {
  const latencies = [];
  let errors = 0;
  for (const query of queries) {
    const started = process.hrtime.bigint();
    try {
      await run(query);
      latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
    } catch {
      errors += 1;
    }
  }
  return { latencies, errors, summary: summarise(latencies) };
}

async function main() {
  process.stdout.write(
    `postgres ${postgresName}:${postgresPort}, redis ${redisName}:${redisPort}\n`,
  );
  await docker(
    'run',
    '-d',
    '--name',
    postgresName,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    'POSTGRES_USER=load',
    '-e',
    'POSTGRES_DB=load',
    '-p',
    `127.0.0.1:${postgresPort}:5432`,
    IMAGE,
    // Server flags must come after the image: -c before it means --cpu-shares.
    '-c',
    'shared_buffers=256MB',
    '-c',
    'max_connections=200',
    '-c',
    'work_mem=16MB',
  );
  await docker('run', '-d', '--name', redisName, '-p', `127.0.0.1:${redisPort}:6379`, REDIS_IMAGE);

  let pool;
  try {
    const connectionString = `postgresql://load:${password}@127.0.0.1:${postgresPort}/load`;
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const probe = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 2000 });
      try {
        await probe.query('SELECT 1');
        await probe.end();
        break;
      } catch {
        await probe.end().catch(() => undefined);
        await sleep(1000);
      }
      if (attempt === 119) throw new Error('load_test_postgres_never_ready');
    }

    pool = new Pool({ connectionString, max: 24, connectionTimeoutMillis: 10_000 });
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
    const corpusCache = await RedisCorpusCache.connect(`redis://127.0.0.1:${redisPort}`);
    process.stdout.write(`cache: RedisCorpusCache collegata\n`);

    const uncached = new CoreMemoryService(repository, {
      forgetSecret: FORGET_SECRET,
      embeddingProvider: provider,
      semanticSearchIndex: index,
      reporter: 'load-test-uncached',
    });
    const cached = new CoreMemoryService(repository, {
      forgetSecret: FORGET_SECRET,
      embeddingProvider: provider,
      semanticSearchIndex: index,
      corpusCache,
      reporter: 'load-test-cached',
    });

    const session = await cached.openSession({ projectId: PROJECT, taskTitle: 'load test' });

    const writeStarted = Date.now();
    for (let index_ = 0; index_ < Math.min(governedSample, memoryCount); index_ += 1) {
      await cached.proposeMemory(
        {
          sessionId: session.sessionId,
          content: contentFor(index_),
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
    }
    const writeSeconds = (Date.now() - writeStarted) / 1000;
    process.stdout.write(
      `scrittura governata: ${governedSample} memorie in ${writeSeconds.toFixed(1)}s ` +
        `(${(governedSample / writeSeconds).toFixed(1)}/s)\n`,
    );

    const remaining = memoryCount - governedSample;
    const bulkStarted = Date.now();
    const batch = 500;
    for (let offset = 0; offset < remaining; offset += batch) {
      const drafts = [];
      for (let n = 0; n < Math.min(batch, remaining - offset); n += 1) {
        const index_ = governedSample + offset + n;
        drafts.push({
          content: contentFor(index_),
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
      for (const draft of drafts) created.push(await repository.createMemory(draft));
      for (const record of created) await repository.updateMemoryLifecycle(record.id, 'accepted');
      if ((offset / batch) % 4 === 0) {
        process.stdout.write(
          `  riempimento ${governedSample + offset + created.length}/${memoryCount}\n`,
        );
      }
    }
    const bulkSeconds = (Date.now() - bulkStarted) / 1000;
    process.stdout.write(
      `riempimento: ${remaining} in ${bulkSeconds.toFixed(1)}s (${(remaining / bulkSeconds).toFixed(0)}/s)\n`,
    );

    const reindexStarted = Date.now();
    const reindexed = await cached.reindexEmbeddings();
    process.stdout.write(
      `reindex: ${reindexed.indexed} in ${((Date.now() - reindexStarted) / 1000).toFixed(1)}s\n`,
    );
    const health = await cached.getEmbeddingIndexHealth();
    process.stdout.write(
      `indice: ${health.indexedForActiveProfile}/${health.memoryCount}, mancanti ${health.missingCount}\n`,
    );
    const { rows: outboxRows } = await pool.query(
      `SELECT count(*)::int AS total, count(*) FILTER (WHERE processed_at IS NULL)::int AS pending
       FROM corpus_outbox`,
    );
    process.stdout.write(
      `outbox: ${outboxRows[0].total} righe, ${outboxRows[0].pending} pendenti\n`,
    );

    const distinct = Array.from({ length: 40 }, (_, n) => probeFor(n));

    const a = await timeQueries(uncached, session.sessionId, distinct, (query) =>
      uncached.searchMemories({ sessionId: session.sessionId, query, limit: 20, offset: 0 }),
    );
    process.stdout.write(
      `A. senza cache, ${distinct.length} query nuove, ${a.errors} errori\n  ${JSON.stringify(a.summary)}\n`,
    );

    const b = await timeQueries(cached, session.sessionId, distinct, (query) =>
      cached.searchMemories({ sessionId: session.sessionId, query, limit: 20, offset: 0 }),
    );
    const bTelemetry = cached.getRetrievalTelemetry();
    process.stdout.write(
      `B. con cache, ${distinct.length} query nuove (tutte miss), ${b.errors} errori\n  ${JSON.stringify(b.summary)}\n  miss registrati ${bTelemetry.cacheMisses}, hit ${bTelemetry.cacheHits}\n`,
    );

    const repeat = probeFor(0);
    await cached.searchMemories({
      sessionId: session.sessionId,
      query: repeat,
      limit: 20,
      offset: 0,
    });
    const hitsBefore = cached.getRetrievalTelemetry().cacheHits;
    const c = await timeQueries(
      cached,
      session.sessionId,
      Array.from({ length: hitsPerPhase }, () => repeat),
      (query) =>
        cached.searchMemories({ sessionId: session.sessionId, query, limit: 20, offset: 0 }),
    );
    const cTelemetry = cached.getRetrievalTelemetry();
    process.stdout.write(
      `C. con cache, ${hitsPerPhase} query identiche (hit), ${c.errors} errori\n  ${JSON.stringify(c.summary)}\n  hit registrati in questa fase ${cTelemetry.cacheHits - hitsBefore}\n`,
    );

    process.stdout.write('D. costo della rivedifica per pagina risultati (solo cache hit)\n');
    const byLimit = {};
    for (const limit of [5, 20, 50]) {
      const query = probeFor(3);
      await cached.searchMemories({ sessionId: session.sessionId, query, limit, offset: 0 });
      const measured = [];
      for (let n = 0; n < 100; n += 1) {
        const started = process.hrtime.bigint();
        await cached.searchMemories({ sessionId: session.sessionId, query, limit, offset: 0 });
        measured.push(Number(process.hrtime.bigint() - started) / 1e6);
      }
      byLimit[`limit${limit}`] = summarise(measured);
      process.stdout.write(
        `  limit ${String(limit).padStart(2)}: ${JSON.stringify(byLimit[`limit${limit}`])}\n`,
      );
    }

    process.stdout.write('E. concorrenza, con cache, query nuove\n');
    for (const concurrency of concurrencies) {
      const latencies = [];
      let errors = 0;
      const perWorker = Math.ceil(40 / concurrency);
      const started = Date.now();
      await Promise.all(
        Array.from({ length: concurrency }, async (_, worker) => {
          for (let n = 0; n < perWorker; n += 1) {
            const query = probeFor(1000 + worker * perWorker + n);
            const queryStarted = process.hrtime.bigint();
            try {
              await cached.searchMemories({
                sessionId: session.sessionId,
                query,
                limit: 20,
                offset: 0,
              });
              latencies.push(Number(process.hrtime.bigint() - queryStarted) / 1e6);
            } catch {
              errors += 1;
            }
          }
        }),
      );
      process.stdout.write(
        `  concorrenza ${String(concurrency).padStart(2)}: ${latencies.length} ricerche in ` +
          `${((Date.now() - started) / 1000).toFixed(1)}s, ${errors} errori\n  ${JSON.stringify(summarise(latencies))}\n`,
      );
    }
  } finally {
    if (pool) await pool.end();
    await docker('rm', '-f', postgresName).catch(() => undefined);
    await docker('rm', '-f', redisName).catch(() => undefined);
    process.stdout.write('container rimossi\n');
  }

  // RedisCorpusCache holds an open Redis connection with no close method, and
  // the pool is already ended, so without this the process never exits. P piped
  // through a filter that means the run looks silent and hung even though every
  // line has already been produced.
  process.exit(0);
}

await main();
