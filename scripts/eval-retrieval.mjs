import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CoreMemoryService, InMemoryRepository } from '../packages/core/dist/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataset = JSON.parse(
  await readFile(resolve(root, 'evals/datasets/retrieval-v1.json'), 'utf8'),
);
const results = [];
const latencies = [];
const metrics = {
  dataset: 'retrieval-v1',
  provider: 'local-deterministic',
  cases: dataset.length,
  queries: 0,
  passedQueries: 0,
  recallAtK: 0,
  precisionAtK: 0,
  ndcgAtK: 0,
  pendingContextLeaks: 0,
  budgetViolations: 0,
  p50LatencyMs: 0,
  p95LatencyMs: 0,
};
let recallTotal = 0;
let precisionTotal = 0;
let ndcgTotal = 0;

for (const testCase of dataset) {
  const result = await runCase(testCase);
  results.push(result);
  metrics.queries += result.queries;
  metrics.passedQueries += result.passedQueries;
  recallTotal += result.recallTotal;
  precisionTotal += result.precisionTotal;
  ndcgTotal += result.ndcgTotal;
  metrics.pendingContextLeaks += result.pendingContextLeaks;
  metrics.budgetViolations += result.budgetViolations;
  latencies.push(...result.latencies);
}
metrics.recallAtK = ratio(recallTotal, metrics.queries);
metrics.precisionAtK = ratio(precisionTotal, metrics.queries);
metrics.ndcgAtK = ratio(ndcgTotal, metrics.queries);
const sortedLatencies = [...latencies].sort((left, right) => left - right);
metrics.p50LatencyMs = percentile(sortedLatencies, 0.5);
metrics.p95LatencyMs = percentile(sortedLatencies, 0.95);

const outputDirectory = resolve(root, 'evals/results');
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  resolve(outputDirectory, 'retrieval-v1.json'),
  `${JSON.stringify({ schemaVersion: 1, metrics, results }, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(metrics)}\n`);
if (metrics.passedQueries !== metrics.queries) throw new Error('retrieval_evaluation_failed');
if (metrics.pendingContextLeaks !== 0 || metrics.budgetViolations !== 0) {
  throw new Error('retrieval_invariant_failed');
}

async function runCase(testCase) {
  const service = new CoreMemoryService(new InMemoryRepository(), {
    forgetSecret: 'evaluation-forget-secret-that-is-long-enough',
  });
  const session = await service.openSession({ projectId: testCase.projectId });
  const pendingContents = new Set();
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
      pendingContents.add(normalize(memory.content));
    } else {
      const proposal = await service.proposeMemory(input, {
        actor: 'owner',
        explicitDirective: true,
      });
      if (proposal.status !== 'accepted') throw new Error('retrieval_fixture_not_accepted');
    }
  }
  const memoryByKey = new Map(testCase.memories.map((memory) => [memory.key, memory.content]));
  const queryResults = [];
  const caseLatencies = [];
  let pendingContextLeaks = 0;
  let budgetViolations = 0;
  let recallTotal = 0;
  let precisionTotal = 0;
  let ndcgTotal = 0;
  let passedQueries = 0;
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
    const actual = found.map((memory) => normalize(memory.content));
    const expected = query.expectedKeys.map((key) => normalize(memoryByKey.get(key)));
    const recall = recallAtK(actual, expected, query.limit);
    const precision = precisionAtK(actual, expected, query.limit);
    const ndcg = ndcgAtK(actual, expected, query.limit);
    const contextContents = context.context.map((memory) => normalize(memory.content));
    const leaks = contextContents.filter((content) => pendingContents.has(content)).length;
    const budgetExceeded = context.tokensEstimated > (query.budgetTokens ?? 1_200) ? 1 : 0;
    const passed =
      recall === 1 && precision === 1 && ndcg === 1 && leaks === 0 && budgetExceeded === 0;
    if (passed) passedQueries += 1;
    recallTotal += recall;
    precisionTotal += precision;
    ndcgTotal += ndcg;
    pendingContextLeaks += leaks;
    budgetViolations += budgetExceeded;
    queryResults.push({
      query: query.query,
      expected,
      actual,
      recall,
      precision,
      ndcg,
      leaks,
      budgetExceeded,
      passed,
    });
  }
  return {
    id: testCase.id,
    queries: queryResults.length,
    passedQueries,
    recallTotal,
    precisionTotal,
    ndcgTotal,
    pendingContextLeaks,
    budgetViolations,
    latencies: caseLatencies,
    results: queryResults,
  };
}

function recallAtK(actual, expected, limit) {
  if (expected.length === 0) return 1;
  const relevant = new Set(expected);
  return actual.slice(0, limit).filter((value) => relevant.has(value)).length / relevant.size;
}

function precisionAtK(actual, expected, limit) {
  const values = actual.slice(0, limit);
  if (values.length === 0) return expected.length === 0 ? 1 : 0;
  const relevant = new Set(expected);
  return values.filter((value) => relevant.has(value)).length / values.length;
}

function ndcgAtK(actual, expected, limit) {
  if (expected.length === 0) return 1;
  const relevant = new Set(expected);
  const dcg = actual
    .slice(0, limit)
    .reduce(
      (total, value, index) => total + (relevant.has(value) ? 1 / Math.log2(index + 2) : 0),
      0,
    );
  const ideal = [...expected]
    .slice(0, limit)
    .reduce((total, _value, index) => total + 1 / Math.log2(index + 2), 0);
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
