#!/usr/bin/env node
/**
 * Is the full-text index actually used?
 *
 * Measured so far: query cost is proportional to corpus size, independent of
 * how many candidates are ranked in JavaScript, and independent of the semantic
 * path. That points at the SQL itself rather than at the ranking, and the
 * obvious suspect is the ORDER BY: PostgreSQL cannot use an index for
 * ts_rank_cd, so if it appears in ORDER BY it may recompute to_tsvector over
 * every row it visits, which defeats the GIN index that exists for this query.
 *
 * This runs EXPLAIN (ANALYZE, BUFFERS) on a throwaway container and prints the
 * planner's own account, so the answer comes from the database and not from a
 * guess.
 *
 * Usage: node scripts/explain-search.mjs [--memories 10000]
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
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

const IMAGE = 'pgvector/pgvector:pg17';
const SCOPE_KEY = 'project:explain';

const name = `mnemosyne-explain-${randomBytes(4).toString('hex')}`;
const password = randomBytes(16).toString('hex');
const port = 5500 + Math.floor(Math.random() * 400);

const schemaSource = fileURLToPath(new URL('../packages/postgres/src/schema.sql', import.meta.url));
const schemaTarget = fileURLToPath(
  new URL('../packages/postgres/dist/schema.sql', import.meta.url),
);
await mkdir(dirname(schemaTarget), { recursive: true });
await copyFile(schemaSource, schemaTarget);

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
const sharedTerm = !args.includes('--no-shared-term');
const VOCABULARY = Array.from(
  { length: BASE_WORDS.length * 64 },
  (_, index) =>
    `${BASE_WORDS[index % BASE_WORDS.length]}${Math.floor(index / BASE_WORDS.length) || ''}`,
);
const contentFor = (index) => {
  const a = VOCABULARY[index % VOCABULARY.length];
  const b = VOCABULARY[(index * 7 + 3) % VOCABULARY.length];
  const c = VOCABULARY[(index * 13 + 5) % VOCABULARY.length];
  const shared = sharedTerm ? ` stage ${index % 97}` : '';
  return `fixture ${1000 + (index % 8999)} ${a} ${b} ${c}${shared}`;
};

async function main() {
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
    pool = new Pool({ connectionString, max: 4 });
    await pool.query(await readFile(schemaTarget, 'utf8'));

    const { rows: existing } = await pool.query('SELECT count(*)::int AS n FROM memories');
    if (existing[0].n === 0) {
      for (let start = 0; start < memoryCount; start += 500) {
        for (let n = 0; n < 500 && start + n < memoryCount; n += 1) {
          const index = start + n;
          const { rows } = await pool.query(
            `INSERT INTO memories (id, lifecycle) VALUES ($1, 'accepted') RETURNING id`,
            [`mem_x${index}`],
          );
          const id = rows[0].id;
          await pool.query(
            `INSERT INTO memory_revisions
               (memory_id, version, content, kind, scope_type, scope_id,
                epistemic_basis, assessment, confidence, sensitivity, activation, source_event_ids)
             VALUES ($1, 1, $2, 'fact', 'project', 'explain', 'user_asserted', 'uncontested', 1, 'normal', 'on_demand', '{}')`,
            [id, contentFor(index)],
          );
        }
      }
    }
    const { rows: total } = await pool.query('SELECT count(*)::int AS n FROM memories');
    process.stdout.write(`corpus: ${total[0].n} memorie\n\n`);

    const variants = [
      [
        'rilascio: OR con prefisso (*)',
        'pipeline0:* or semantic1:*',
        `SELECT r.* FROM memories m JOIN memory_revisions r ON r.memory_id = m.id AND r.version = m.current_version
         WHERE m.lifecycle = 'accepted'
           AND to_tsvector('simple', r.content) @@ websearch_to_tsquery('simple', $1)
           AND (r.scope_type || ':' || r.scope_id) = ANY($2::text[])
         ORDER BY ts_rank_cd(to_tsvector('simple', r.content), websearch_to_tsquery('simple', $1)) DESC, r.memory_id ASC
         LIMIT 1000`,
      ],
      [
        'senza prefisso (termini esatti)',
        'pipeline0 | semantic1',
        `SELECT r.* FROM memories m JOIN memory_revisions r ON r.memory_id = m.id AND r.version = m.current_version
         WHERE m.lifecycle = 'accepted'
           AND to_tsvector('simple', r.content) @@ to_tsquery('simple', $1)
           AND (r.scope_type || ':' || r.scope_id) = ANY($2::text[])
         ORDER BY ts_rank_cd(to_tsvector('simple', r.content), to_tsquery('simple', $1)) DESC, r.memory_id ASC
         LIMIT 1000`,
      ],
      [
        'letterale al posto di $1 (non parametrizzato)',
        null,
        `SELECT r.* FROM memories m JOIN memory_revisions r ON r.memory_id = m.id AND r.version = m.current_version
         WHERE m.lifecycle = 'accepted'
           AND to_tsvector('simple', r.content) @@ websearch_to_tsquery('simple', 'pipeline0:* or semantic1:*')
           AND (r.scope_type || ':' || r.scope_id) = ANY(ARRAY['project:explain']::text[])
         ORDER BY ts_rank_cd(to_tsvector('simple', r.content), websearch_to_tsquery('simple', 'pipeline0:* or semantic1:*')) DESC, r.memory_id ASC
         LIMIT 1000`,
      ],
      [
        'solo memory_revisions, nessuna join',
        null,
        `SELECT r.* FROM memory_revisions r
         WHERE to_tsvector('simple', r.content) @@ websearch_to_tsquery('simple', 'pipeline0:* or semantic1:*')`,
      ],
      [
        'memory_revisions filtrato, poi join a memories',
        null,
        `WITH matched AS (
           SELECT r.* FROM memory_revisions r
           WHERE to_tsvector('simple', r.content) @@ websearch_to_tsquery('simple', 'pipeline0:* or semantic1:*')
         )
         SELECT matched.* FROM matched
         JOIN memories m ON m.id = matched.memory_id AND m.current_version = matched.version
         WHERE m.lifecycle = 'accepted'
           AND (matched.scope_type || ':' || matched.scope_id) = ANY(ARRAY['project:explain']::text[])`,
      ],
      [
        'CTE MATERIALIZED: il FTS guida, poi join',
        null,
        `WITH matched AS MATERIALIZED (
           SELECT r.* FROM memory_revisions r
           WHERE to_tsvector('simple', r.content) @@ websearch_to_tsquery('simple', 'pipeline0:* or semantic1:*')
         )
         SELECT matched.* FROM matched
         JOIN memories m ON m.id = matched.memory_id AND m.current_version = matched.version
         WHERE m.lifecycle = 'accepted'
           AND (matched.scope_type || ':' || matched.scope_id) = ANY(ARRAY['project:explain']::text[])
         ORDER BY matched.memory_id
         LIMIT 1000`,
      ],
    ];

    for (const [label, tsquery, sql] of variants) {
      const values = tsquery === null ? [] : [tsquery, [SCOPE_KEY]];
      await pool.query(sql, values);
      const samples = [];
      for (let n = 0; n < 5; n += 1) {
        const began = process.hrtime.bigint();
        await pool.query(sql, values);
        samples.push(Number(process.hrtime.bigint() - began) / 1e6);
      }
      samples.sort((a, b) => a - b);
      const { rows } = await pool.query(sql, values);
      const { rows: planRows } = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, values);
      const planText = planRows.map((row) => row['QUERY PLAN']).join('\n');
      const usedIndexes = [...planText.matchAll(/Index Scan using (\S+)/g)].map((m) => m[1]);
      const nodes = planText
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^(Seq Scan|Bitmap|Index|Sort|Nested|Hash|Subquery|->)/.test(line));
      process.stdout.write(
        `${label}\n` +
          `  p50 ${samples[2].toFixed(2)} ms (min ${samples[0].toFixed(2)}), ${rows.length} righe\n` +
          `  indici usati: ${usedIndexes.length ? [...new Set(usedIndexes)].join(', ') : 'NESSUNO'}\n` +
          `  seq scan: ${/Seq Scan/.test(planText) ? 'SI' : 'no'}\n` +
          `  piano:\n${nodes.map((line) => `    ${line}`).join('\n')}\n\n`,
      );
    }
  } finally {
    if (pool) await pool.end();
    await docker('rm', '-f', name).catch(() => undefined);
    process.stdout.write('container rimosso\n');
  }
  process.exit(0);
}

await main();
