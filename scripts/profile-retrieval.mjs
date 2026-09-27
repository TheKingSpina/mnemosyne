#!/usr/bin/env node
/**
 * Where does query time actually go?
 *
 * The load test measures the whole pipeline. This isolates the two retrieval
 * paths against the same corpus, because guessing which one dominates has been
 * wrong twice: the semantic neighbour count was blamed and turned out to make no
 * measurable difference, and the full-text match set was blamed and turned out
 * to be tiny.
 *
 * Variants, same corpus, same queries, same service code:
 *   lexical   no embedding provider and no semantic index at all
 *   semantic  lexical disabled by having the repository expose no
 *             searchCurrentMemories, so the candidate pool is the raw list
 *   hybrid    the shipping configuration
 *
 * Usage: node scripts/profile-retrieval.mjs [--memories 10000] [--probes 40]
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
const probeCount = Number(flag('probes', '40'));

const IMAGE = 'pgvector/pgvector:pg17';
const FORGET_SECRET = 'profile-forget-secret-that-is-long-enough';
const SCOPE = { type: 'project', id: 'profile' };

const name = `mnemosyne-profile-${randomBytes(4).toString('hex')}`;
const password = randomBytes(16).toString('hex');
const port = 5500 + Math.floor(Math.random() * 400);

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
const { Pool } = await import('pg');

const docker = (...argv) => execFileAsync('docker', argv, { maxBuffer: 128 * 1024 * 1024 });

const BASE_WORDS = [
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
const morphemes = 64;
const VOCABULARY = Array.from(
  { length: BASE_WORDS.length * morphemes },
  (_, index) =>
    `${BASE_WORDS[index % BASE_WORDS.length]}${Math.floor(index / BASE_WORDS.length) || ''}`,
);
const contentFor = (index) => {
  const a = VOCABULARY[index % VOCABULARY.length];
  const b = VOCABULARY[(index * 7 + 3) % VOCABULARY.length];
  const c = VOCABULARY[(index * 13 + 5) % VOCABULARY.length];
  return `load fixture ${1000 + (index % 8999)}: ${a} ${b} ${c} stage ${index % 97}`;
};
const probeFor = (n) => {
  const a = VOCABULARY[n % VOCABULARY.length];
  const b = VOCABULARY[(n * 7 + 3) % VOCABULARY.length];
  return `${a} ${b} stage ${n % 97}`;
};

function stats(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const at = (f) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * f))] ?? 0;
  return {
    n: values.length,
    p50: Number(at(0.5).toFixed(2)),
    p95: Number(at(0.95).toFixed(2)),
  };
}

async function main() {
  process.stdout.write(`postgres su 127.0.0.1:${port}\n`);
  await docker(
    'run',
    '-d',
    '--name',
    name,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-e',
    'POSTGRES_USER=load',
    '-e',
    'POSTGRES_DB=load',
    '-p',
    `127.0.0.1:${port}:5432`,
    IMAGE,
    '-c',
    'shared_buffers=256MB',
    '-c',
    'max_connections=200',
  );

  let pool;
  try {
    const connectionString = `postgresql://load:${password}@127.0.0.1:${port}/load`;
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
    }
    pool = new Pool({ connectionString, max: 8 });
    const repository = await PostgresMemoryRepository.fromPool(pool);
    const provider = new DeterministicEmbeddingProvider(64);
    const index = new PostgresSemanticSearchIndex(pool, {
      profile: provider.profile,
      dimensions: provider.dimensions,
    });

    const session = await new CoreMemoryService(repository, {
      forgetSecret: FORGET_SECRET,
    }).openSession({ projectId: 'profile' });

    const started = Date.now();
    for (let batch = 0; batch < memoryCount; batch += 500) {
      const created = [];
      for (let n = 0; n < Math.min(500, memoryCount - batch); n += 1) {
        const index_ = batch + n;
        created.push(
          await repository.createMemory({
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
          }),
        );
      }
      for (const record of created) await repository.updateMemoryLifecycle(record.id, 'accepted');
    }
    process.stdout.write(
      `corpus: ${memoryCount} memorie in ${((Date.now() - started) / 1000).toFixed(1)}s\n`,
    );

    const hybrid = new CoreMemoryService(repository, {
      forgetSecret: FORGET_SECRET,
      embeddingProvider: provider,
      semanticSearchIndex: index,
    });
    await hybrid.reindexEmbeddings();
    process.stdout.write(`embedding ricostruite\n`);

    // Lexical only: no provider, no index, so the semantic path is inert.
    const lexicalOnly = new CoreMemoryService(repository, { forgetSecret: FORGET_SECRET });

    // A repository facade whose full-text pushdown is absent, so the candidate
    // pool falls back to listing every current memory. That is the shape the
    // in-memory backend has, and it isolates the cost of the pushdown itself.
    const listOnlyRepository = Object.create(repository);
    listOnlyRepository.searchCurrentMemories = undefined;

    const variants = [
      ['lexical, nessun indice semantico', lexicalOnly],
      [
        'solo listCurrentMemories, nessuna pushdown',
        new CoreMemoryService(listOnlyRepository, {
          forgetSecret: FORGET_SECRET,
          embeddingProvider: provider,
          semanticSearchIndex: index,
        }),
      ],
      ['hybrid, configurazione di rilascio', hybrid],
    ];

    const probes = Array.from({ length: probeCount }, (_, n) => probeFor(n));
    for (const [label, service] of variants) {
      const latencies = [];
      let empty = 0;
      for (const query of probes) {
        const began = process.hrtime.bigint();
        const result = await service.searchMemories({
          sessionId: session.sessionId,
          query,
          limit: 20,
          offset: 0,
        });
        latencies.push(Number(process.hrtime.bigint() - began) / 1e6);
        if (result.length === 0) empty += 1;
      }
      process.stdout.write(`${label}\n  ${JSON.stringify(stats(latencies))}  vuoti ${empty}\n`);

      // Candidate pool sweep. Latency alone would be the wrong thing to optimise,
      // so each setting also reports hit@1 against a known target: the probe is
      // built from the target memory's own most distinctive terms, and the
      // expectation is that memory comes back first. A setting that is fast
      // because it stopped finding the right answer is not an optimisation, and
      // the offline gate cannot catch it because on a dataset of a few dozen
      // memories the bound never binds at all.
      process.stdout.write('\nsweep del pool candidati (moltiplicatore x limite massimo)\n');
      const targets = [];
      const expected = [];
      for (let n = 0; n < probeCount; n += 1) {
        const tokens =
          contentFor(n)
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu) ?? [];
        targets.push(
          [...new Set(tokens)]
            .filter((token) => token.length >= 5)
            .slice(0, 3)
            .join(' '),
        );
        const { rows } = await pool.query(
          `SELECT m.id FROM memories m JOIN memory_revisions r
           ON r.memory_id = m.id AND r.version = m.current_version
         WHERE r.content = $1 LIMIT 1`,
          [contentFor(n)],
        );
        expected.push(rows[0]?.id ?? null);
      }
      for (const [multiplier, maximum] of [
        [20, 1000],
        [10, 500],
        [5, 200],
        [3, 100],
        [2, 50],
      ]) {
        const service = new CoreMemoryService(repository, {
          forgetSecret: FORGET_SECRET,
          embeddingProvider: provider,
          semanticSearchIndex: index,
          candidateLimitMultiplier: multiplier,
          candidateLimitMaximum: maximum,
        });
        const latencies = [];
        let hitAt1 = 0;
        for (const [position, query] of targets.entries()) {
          const began = process.hrtime.bigint();
          const result = await service.searchMemories({
            sessionId: session.sessionId,
            query,
            limit: 20,
            offset: 0,
          });
          latencies.push(Number(process.hrtime.bigint() - began) / 1e6);
          if (result[0]?.memoryId === expected[position]) hitAt1 += 1;
        }
        const summary = stats(latencies);
        const bound = Math.min(maximum, Math.max(200, 20 * multiplier));
        process.stdout.write(
          `  x${String(multiplier).padEnd(2)} max ${String(maximum).padEnd(4)} pool ~${String(bound).padEnd(4)}` +
            ` p50 ${String(summary.p50).padStart(7)} ms  hit@1 ${((hitAt1 / targets.length) * 100).toFixed(1).padStart(5)}%\n`,
        );
      }
    }
  } finally {
    if (pool) await pool.end();
    await docker('rm', '-f', name).catch(() => undefined);
    process.stdout.write('container rimosso\n');
  }
  process.exit(0);
}

await main();
