#!/usr/bin/env node
/**
 * Read-only live retrieval benchmark against a running Mnemosyne API.
 *
 * Probes are generated from the corpus itself: for each accepted memory we take
 * its most distinctive terms (highest inverse document frequency, generic terms
 * removed) and expect that memory back. The corpus export is written to a
 * temporary file and deleted immediately; only aggregate numbers are printed,
 * never memory content.
 *
 * Usage: node scripts/bench-live-retrieval.mjs --base-url <api> [--probes N]
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const baseUrl = flag('base-url', 'http://127.0.0.1:3000');
const probeTarget = Number(flag('probes', '24'));
const token = process.env.MNEMOSYNE_OWNER_TOKEN;
if (!token) {
  console.error('MNEMOSYNE_OWNER_TOKEN is required');
  process.exit(2);
}

const GENERIC = new Set([
  'code',
  'content',
  'file',
  'files',
  'information',
  'memory',
  'memories',
  'project',
  'service',
  'system',
  'use',
  'used',
  'using',
  'the',
  'and',
  'che',
  'della',
  'delle',
  'della',
  'sono',
  'essere',
  'questo',
  'questa',
  'per',
  'con',
  'non',
  'una',
  'uno',
  'the',
  'of',
  'to',
  'in',
  'is',
  'are',
  'it',
  'that',
  'this',
]);

function terms(text) {
  return (
    text
      .normalize('NFKC')
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((t) => t.length >= 4 && !GENERIC.has(t));
}

async function api(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(`request_failed:${path}:${response.status}`);
  return response.json();
}

const directory = await mkdtemp(join(tmpdir(), 'mnemosyne-bench-'));
const exportPath = join(directory, 'corpus.json');
let corpus;
try {
  const exported = await api('/v1/admin/exports/corpus');
  await writeFile(exportPath, JSON.stringify(exported), { mode: 0o600 });
  corpus = JSON.parse(await readFile(exportPath, 'utf8'));
} finally {
  await rm(exportPath, { force: true });
  await rm(directory, { recursive: true, force: true });
}

// In the export shape the lifecycle lives on the record, not the revision.
const accepted = corpus.memories
  .filter((entry) => entry.record?.lifecycle === 'accepted')
  .map((entry) => entry.current)
  .filter((revision) => typeof revision?.content === 'string');
if (accepted.length === 0) {
  console.error('no_accepted_memories');
  process.exit(1);
}

const frequency = new Map();
for (const memory of accepted) {
  for (const term of new Set(terms(memory.content))) {
    frequency.set(term, (frequency.get(term) ?? 0) + 1);
  }
}
const distinctiveness = (term) => -Math.log((frequency.get(term) ?? 1) / accepted.length);

// The session must live in the project that owns the corpus, otherwise every
// probe is correctly out of scope and the benchmark measures nothing. Passing
// --project is how you point it at a different corpus.
const session = await api('/v1/sessions', {
  method: 'POST',
  // Every POST requires an Idempotency-Key; the benchmark only ever opens one
  // session, so a stable key keeps the run replay-safe.
  headers: { 'idempotency-key': `bench-live-${Date.now()}` },
  body: JSON.stringify({ projectId: flag('project', 'Mnemosyne') }),
});
const sessionId = session.sessionId;

/**
 * Three probe profiles, because one number would be misleading.
 *
 *   sharp3  the three most distinctive terms: close to verbatim, so this is a
 *           contract check on the ranking, not a relevance result.
 *   sharp2  two distinctive terms: less lexical overlap to work with.
 *   muted3  the three LEAST distinctive terms: deliberately close to the noise
 *           floor, which is where a relevance system actually earns its keep.
 *
 * A high sharp3 with a low muted3 is the honest shape of a lexical system, and
 * is exactly what a hand-judged set would be needed to interpret.
 */
const PROFILES = {
  sharp3: (ranked) => ranked.slice(0, 3),
  sharp2: (ranked) => ranked.slice(0, 2),
  muted3: (ranked) => [...ranked].reverse().slice(0, 3),
};

const buildProbes = (profile) =>
  accepted
    .map((memory) => {
      const ranked = [...new Set(terms(memory.content))].sort(
        (left, right) =>
          distinctiveness(right) - distinctiveness(left) || left.localeCompare(right),
      );
      return {
        expected: memory.memoryId,
        query: PROFILES[profile](ranked).join(' '),
      };
    })
    .filter((probe) => probe.query.trim().length > 0)
    .sort((left, right) => (left.expected < right.expected ? -1 : 1))
    .slice(0, probeTarget);

async function runProfile(profile, sessionId) {
  const probes = buildProbes(profile);
  const latencies = [];
  const reciprocal = [];
  let hit1 = 0;
  let hit5 = 0;
  let hit10 = 0;
  let empty = 0;

  for (const probe of probes) {
    const started = process.hrtime.bigint();
    const result = await api(
      `/v1/memories?${new URLSearchParams({
        sessionId,
        q: probe.query,
        limit: '10',
        offset: '0',
      })}`,
    );
    latencies.push(Number(process.hrtime.bigint() - started) / 1e6);
    const ids = result.items.map((item) => item.memoryId);
    if (ids.length === 0) empty += 1;
    const rank = ids.indexOf(probe.expected);
    if (rank === 0) hit1 += 1;
    if (rank >= 0 && rank < 5) hit5 += 1;
    if (rank >= 0 && rank < 10) hit10 += 1;
    if (rank >= 0) reciprocal.push(1 / (rank + 1));
  }

  latencies.sort((left, right) => left - right);
  const percentile = (fraction) =>
    latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))] ?? 0;
  const total = probes.length;
  const pct = (value) => `${((value / total) * 100).toFixed(1)}%`;
  return {
    probes: total,
    emptyResultSets: empty,
    hitAt1Rate: pct(hit1),
    hitAt5Rate: pct(hit5),
    hitAt10Rate: pct(hit10),
    mrrAt10: reciprocal.length
      ? Number((reciprocal.reduce((a, b) => a + b, 0) / total).toFixed(4))
      : 0,
    unranked: total - reciprocal.length,
    latencyP50Ms: Number(percentile(0.5).toFixed(2)),
    latencyP95Ms: Number(percentile(0.95).toFixed(2)),
  };
}

const profiles = {};
for (const profile of Object.keys(PROFILES)) {
  profiles[profile] = await runProfile(profile, sessionId);
}

await api(`/v1/sessions/${encodeURIComponent(sessionId)}/close`, {
  method: 'POST',
  headers: { 'idempotency-key': `bench-live-close-${sessionId}` },
  body: JSON.stringify({}),
});

process.stdout.write(`${JSON.stringify({ corpusAccepted: accepted.length, profiles }, null, 2)}\n`);
