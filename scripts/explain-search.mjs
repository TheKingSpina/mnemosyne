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
const VOCABULARY = Array.from(
  { length: BASE_WORDS.length * 64 },
  (_, index) =>
    `${BASE_WORDS[index % BASE_WORDS.length]}${Math.floor(index / BASE_WORDS.length) || ''}`,
);
const contentFor = (index) => {
  const a = VOCABULARY[index % VOCABULARY.length];
  const b = VOCABULARY[(index * 7 + 3) % VOCABULARY.length];
  const c = VOCABULARY[(index * 13 + 5) % VOCABULARY.length];
  return `fixture ${1000 + (index % 8999)} ${a} ${b} ${c} stage ${index % 97}`;
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

    const query = 'pipeline0:* or semantic1:*';
    const variants = [
      [
        'ORDINE per ts_rank_cd (query di rilascio)',
        `SELECT r.* FROM memories m JOIN memory_revisions r ON r.memory_id = m.id AND r.version = m.current_version
         WHERE m.lifecycle = 'accepted'
           AND to_tsvector('simple', r.content) @@ websearch_to_tsquery('simple', $1)
           AND (r.scope_type || ':' || r.scope_id) = ANY($2::text[])
         ORDER BY ts_rank_cd(to_tsvector('simple', r.content), websearch_to_tsquery('simple', $1)) DESC, r.memory_id ASC
         LIMIT 1000`,
      ],
      [
        'SENZA ORDER BY ts_rank_cd (solo il match)',
        `SELECT r.* FROM memories m JOIN memory_revisions r ON r.memory_id = m.id AND r.version = m.current_version
         WHERE m.lifecycle = 'accepted'
           AND to_tsvector('simple', r.content) @@ websearch_to_tsquery('simple', $1)
           AND (r.scope_type || ':' || r.scope_id) = ANY($2::text[])
         LIMIT 1000`,
      ],
      [
        'rank in una sottoquery, ordine sul solo memory_id',
        `SELECT * FROM (
           SELECT r.*, ts_rank_cd(to_tsvector('simple', r.content), websearch_to_tsquery('simple', $1)) AS rank
           FROM memories m JOIN memory_revisions r ON r.memory_id = m.id AND r.version = m.current_version
           WHERE m.lifecycle = 'accepted'
             AND to_tsvector('simple', r.content) @@ websearch_to_tsquery('simple', $1)
             AND (r.scope_type || ':' || r.scope_id) = ANY($2::text[])
         ) ranked
         ORDER BY rank DESC, memory_id ASC
         LIMIT 1000`,
      ],
    ];

    for (const [label, sql] of variants) {
      const values = [query, [SCOPE_KEY]];
      await pool.query(sql, values);
      const began = process.hrtime.bigint();
      const { rows } = await pool.query(sql, values);
      const ms = Number(process.hrtime.bigint() - began) / 1e6;
      const plan = await pool.query(`EXPLAIN (ANALYZE, BUFFERS) ${sql}`, values);
      const planText = plan.rows.map((row) => row['QUERY PLAN']).join('\n');
      const seqScan = /Seq Scan/.test(planText);
      const bitmap = /Bitmap (?:Heap )?Index Scan|Bitmap Index Scan/.test(planText);
      const sortNode = (planText.match(/Sort Method: [^\n]+/g) ?? []).join(' | ');
      process.stdout.write(
        `${label}\n  ${ms.toFixed(2)} ms, ${rows.length} righe, ` +
          `seq scan ${seqScan ? 'SI' : 'no'}, indice ${bitmap ? 'SI' : 'no'}\n` +
          `  ${sortNode || '(nessun nodo Sort)'}\n\n`,
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
