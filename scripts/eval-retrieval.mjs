import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CoreMemoryService,
  DeterministicEmbeddingProvider,
  InMemoryRepository,
  InMemorySemanticSearchIndex,
} from '../packages/core/dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataset = JSON.parse(
  await readFile(resolve(root, 'evals/datasets/retrieval-v1.json'), 'utf8'),
);
const legacyOrder = process.argv.includes('--legacy-order');
const datasetHash = createHash('sha256').update(JSON.stringify(dataset)).digest('hex').slice(0, 12);
const results = [];
const latencies = [];
const metrics = {
  dataset: 'retrieval-v1',
  datasetHash,
  provider: 'local-deterministic',
  rankingMode: legacyOrder ? 'legacy-insertion' : 'scored',
  cases: dataset.length,
  queries: 0,
  judgedQueries: 0,
  unjudgedQueries: 0,
  passedQueries: 0,
  recallAtK: 0,
  precisionAtK: 0,
  ndcgAtK: 0,
  ndcgAtKContext: 0,
  pendingContextLeaks: 0,
  budgetViolations: 0,
  p50LatencyMs: 0,
  p95LatencyMs: 0,
};
let recallTotal = 0;
let precisionTotal = 0;
let ndcgTotal = 0;
let ndcgContextTotal = 0;

for (const testCase of dataset) {
  const result = await runCase(testCase);
  results.push(result);
  metrics.queries += result.queries;
  metrics.judgedQueries += result.judgedQueries;
  metrics.unjudgedQueries += result.unjudgedQueries;
  metrics.passedQueries += result.passedQueries;
  recallTotal += result.recallTotal;
  precisionTotal += result.precisionTotal;
  ndcgTotal += result.ndcgTotal;
  ndcgContextTotal += result.ndcgContextTotal;
  metrics.pendingContextLeaks += result.pendingContextLeaks;
  metrics.budgetViolations += result.budgetViolations;
  latencies.push(...result.latencies);
}
metrics.recallAtK = ratio(recallTotal, metrics.queries);
metrics.precisionAtK = ratio(precisionTotal, metrics.queries);
metrics.ndcgAtK = ratio(ndcgTotal, metrics.judgedQueries);
metrics.ndcgAtKContext = ratio(ndcgContextTotal, metrics.judgedQueries);
const sortedLatencies = [...latencies].sort((left, right) => left - right);
metrics.p50LatencyMs = percentile(sortedLatencies, 0.5);
metrics.p95LatencyMs = percentile(sortedLatencies, 0.95);

const outputDirectory = resolve(root, 'evals/results');
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  resolve(outputDirectory, 'retrieval-v1.json'),
  `${JSON.stringify({ schemaVersion: 2, metrics, results }, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(metrics)}\n`);
if (metrics.passedQueries !== metrics.queries) throw new Error('retrieval_evaluation_failed');
if (metrics.judgedQueries === 0) throw new Error('retrieval_dataset_unjudged');
if (metrics.pendingContextLeaks !== 0 || metrics.budgetViolations !== 0) {
  throw new Error('retrieval_invariant_failed');
}

async function runCase(testCase) {
  const provider = new DeterministicEmbeddingProvider(32);
  const semanticSearchIndex = new InMemorySemanticSearchIndex({
    profile: provider.profile,
    dimensions: provider.dimensions,
  });
  const service = new CoreMemoryService(new InMemoryRepository(), {
    forgetSecret: 'evaluation-forget-secret-that-is-long-enough',
    embeddingProvider: provider,
    semanticSearchIndex,
  });
  const session = await service.openSession({ projectId: testCase.projectId });
  const keyByContent = new Map();
  const orderByContent = new Map();
  const pendingKeys = new Set();
  testCase.memories.forEach((memory, index) => {
    const normalized = normalize(memory.content);
    keyByContent.set(normalized, memory.key);
    orderByContent.set(normalized, index);
    if (memory.lifecycle === 'pending') pendingKeys.add(memory.key);
  });
  for (const memory of testCase.memories) {
    const input = {
      sessionId: session.sessionId,
      content: memory.content,
      kind: memory.kind,
      scope: memory.scope,
      epistemicBasis: 'user_asserted',
      assessment: 'uncontested',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: [],
    };
    if (memory.lifecycle === 'pending') {
      const proposal = await service.proposeMemory(input, {
        actor: 'harness',
        explicitDirective: false,
      });
      if (proposal.status !== 'pending_approval') throw new Error('retrieval_fixture_not_pending');
    } else {
      const proposal = await service.proposeMemory(input, {
        actor: 'owner',
        explicitDirective: true,
      });
      if (proposal.status !== 'accepted') throw new Error('retrieval_fixture_not_accepted');
    }
  }
  const queryResults = [];
  const caseLatencies = [];
  let pendingContextLeaks = 0;
  let budgetViolations = 0;
  let recallTotal = 0;
  let precisionTotal = 0;
  let ndcgTotal = 0;
  let ndcgContextTotal = 0;
  let passedQueries = 0;
  let judgedQueries = 0;
  let unjudgedQueries = 0;
  for (const query of testCase.queries) {
    const startedAt = performance.now();
    const [found, context] = await Promise.all([
      service.searchMemories({
        sessionId: session.sessionId,
        query: query.query,
        limit: query.limit,
        offset: 0,
      }),
      service.resolveContext({
        sessionId: session.sessionId,
        query: query.query,
        budgetTokens: query.budgetTokens ?? 1_200,
      }),
    ]);
    const elapsed = performance.now() - startedAt;
    caseLatencies.push(elapsed);
    const rankedFound = legacyOrder
      ? [...found].sort(
          (left, right) =>
            (orderByContent.get(normalize(left.content)) ?? 0) -
            (orderByContent.get(normalize(right.content)) ?? 0),
        )
      : found;
    const actual = rankedFound
      .map((memory) => keyByContent.get(normalize(memory.content)))
      .filter(Boolean);
    const contextKeys = context.context
      .map((memory) => keyByContent.get(normalize(memory.content)))
      .filter(Boolean);
    const expected = query.expectedKeys ?? [];
    const graded = new Map(
      Object.entries(query.gradedKeys ?? Object.fromEntries(expected.map((key) => [key, 1]))),
    );
    const recall = recallAtK(actual, expected, query.limit);
    const precision = precisionAtK(actual, expected, query.limit);
    const ndcg = ndcgAtK(actual, graded, query.limit);
    const contextNdcg = ndcgAtK(contextKeys, graded, query.limit);
    const leaks = contextKeys.filter((key) => pendingKeys.has(key)).length;
    const budgetExceeded = context.tokensEstimated > (query.budgetTokens ?? 1_200) ? 1 : 0;
    const judged = graded.size > 0;
    if (judged) judgedQueries += 1;
    else unjudgedQueries += 1;
    const ndcgPassed = ndcg === null || ndcg >= 1 - 1e-9;
    const contextNdcgPassed = contextNdcg === null || contextNdcg >= 1 - 1e-9;
    const passed =
      recall >= 1 - 1e-9 &&
      precision >= 1 - 1e-9 &&
      ndcgPassed &&
      contextNdcgPassed &&
      leaks === 0 &&
      budgetExceeded === 0;
    if (passed) passedQueries += 1;
    recallTotal += recall;
    precisionTotal += precision;
    if (ndcg !== null) ndcgTotal += ndcg;
    if (contextNdcg !== null) ndcgContextTotal += contextNdcg;
    pendingContextLeaks += leaks;
    budgetViolations += budgetExceeded;
    queryResults.push({
      query: query.query,
      expectedKeys: expected,
      gradedKeys: Object.fromEntries(graded),
      actualKeys: actual,
      contextKeys,
      recall,
      precision,
      ndcg,
      contextNdcg,
      leaks,
      budgetExceeded,
      passed,
    });
  }
  return {
    id: testCase.id,
    queries: queryResults.length,
    judgedQueries,
    unjudgedQueries,
    passedQueries,
    recallTotal,
    precisionTotal,
    ndcgTotal,
    ndcgContextTotal,
    pendingContextLeaks,
    budgetViolations,
    latencies: caseLatencies,
    results: queryResults,
  };
}

function recallAtK(actual, expected, limit) {
  if (expected.length === 0) return actual.length === 0 ? 1 : 0;
  const relevant = new Set(expected);
  return actual.slice(0, limit).filter((value) => relevant.has(value)).length / relevant.size;
}

function precisionAtK(actual, expected, limit) {
  if (expected.length === 0) return actual.length === 0 ? 1 : 0;
  const relevant = new Set(expected);
  return actual.slice(0, limit).filter((value) => relevant.has(value)).length / limit;
}

function ndcgAtK(actual, graded, limit) {
  if (graded.size === 0) return null;
  const gains = new Map([...graded.entries()].filter(([, gain]) => gain > 0));
  const dcg = actual.slice(0, limit).reduce((total, value, index) => {
    const gain = gains.get(value) ?? 0;
    return total + (gain > 0 ? 2 ** gain - 1 : 0) / Math.log2(index + 2);
  }, 0);
  const ideal = [...gains.values()]
    .sort((left, right) => right - left)
    .slice(0, limit)
    .reduce((total, gain, index) => total + (2 ** gain - 1) / Math.log2(index + 2), 0);
  return ideal === 0 ? 1 : dcg / ideal;
}

function normalize(value) {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

function ratio(total, count) {
  return count === 0 ? 1 : Number((total / count).toFixed(4));
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const index = Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1);
  return Number(values[index].toFixed(3));
}
