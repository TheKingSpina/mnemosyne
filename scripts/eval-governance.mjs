import { mkdir, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CoreMemoryService,
  ExtractionWorker,
  InMemoryRepository,
} from '../packages/core/dist/index.js';
import { ExplicitRememberExtractor } from '../apps/worker/dist/explicit-remember-extractor.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataset = JSON.parse(
  await readFile(resolve(root, 'evals/datasets/governance-v1.json'), 'utf8'),
);
const results = [];
const metrics = {
  cases: dataset.length,
  passedCases: 0,
  candidatePrecision: 0,
  candidateRecall: 0,
  kindAccuracy: 0,
  scopeAccuracy: 0,
  falseAutoAcceptances: 0,
  pendingContextLeaks: 0,
  conflictsDetected: 0,
  duplicateMerges: 0,
};
let precisionHits = 0;
let precisionTotal = 0;
let recallHits = 0;
let recallTotal = 0;
let kindMatches = 0;
let kindTotal = 0;
let scopeMatches = 0;
let scopeTotal = 0;

for (const testCase of dataset) {
  const result = await runCase(testCase);
  results.push(result);
  if (result.passed) metrics.passedCases += 1;
  precisionHits += result.metrics.precisionHits;
  precisionTotal += result.metrics.precisionTotal;
  recallHits += result.metrics.recallHits;
  recallTotal += result.metrics.recallTotal;
  kindMatches += result.metrics.kindMatches;
  kindTotal += result.metrics.kindTotal;
  scopeMatches += result.metrics.scopeMatches;
  scopeTotal += result.metrics.scopeTotal;
  metrics.falseAutoAcceptances += result.actual.acceptedBeforeReview;
  metrics.pendingContextLeaks += result.actual.pendingContextLeaks;
  metrics.conflictsDetected += result.actual.conflicts;
  metrics.duplicateMerges += result.actual.duplicateMerges;
}
metrics.candidatePrecision = ratio(precisionHits, precisionTotal);
metrics.candidateRecall = ratio(recallHits, recallTotal);
metrics.kindAccuracy = ratio(kindMatches, kindTotal);
metrics.scopeAccuracy = ratio(scopeMatches, scopeTotal);

const outputDirectory = resolve(root, 'evals/results');
await mkdir(outputDirectory, { recursive: true });
await writeFile(
  resolve(outputDirectory, 'governance-v1.json'),
  `${JSON.stringify({ schemaVersion: 1, dataset: 'governance-v1', metrics, results }, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(metrics)}\n`);
if (metrics.passedCases !== metrics.cases) throw new Error('evaluation_case_failed');
if (metrics.falseAutoAcceptances !== 0 || metrics.pendingContextLeaks !== 0) {
  throw new Error('evaluation_invariant_failed');
}

async function runCase(testCase) {
  const repository = new InMemoryRepository();
  const service = new CoreMemoryService(repository, {
    forgetSecret: 'evaluation-forget-secret-that-is-long-enough',
  });
  const session = await service.openSession({ projectId: testCase.projectId });
  await service.recordEvents({ sessionId: session.sessionId, events: testCase.events });
  const worker = new ExtractionWorker({
    repository,
    service,
    extractor: new ExplicitRememberExtractor(),
    workerId: `evaluation-${testCase.id}`,
  });
  const extraction = await worker.runOnce();
  const extracted = extraction?.candidates ?? [];
  const extractedContents = unique(extracted.map((candidate) => candidate.content));
  for (const input of testCase.directPending ?? []) {
    await repository.createMemory({ ...input, sessionId: session.sessionId });
  }
  const beforeReview = await service.listPendingProposals({
    sessionId: session.sessionId,
    limit: 100,
    offset: 0,
  });
  const contextBeforeReview = await service.resolveContext({
    sessionId: session.sessionId,
    query: testCase.query,
    budgetTokens: 1_200,
  });
  const memoriesBeforeReview = await service.listAdminMemories({ q: '', limit: 100, offset: 0 });
  const acceptedBeforeReview = memoriesBeforeReview.items.filter(
    (memory) => memory.lifecycle === 'accepted',
  ).length;
  let followUpStatus;
  if (testCase.acceptFirst) {
    const first = beforeReview.items[0];
    if (!first) throw new Error(`evaluation_first_candidate_missing:${testCase.id}`);
    await service.reviewProposal({
      memoryId: first.memoryId,
      expectedVersion: first.currentVersion,
      decision: 'accept',
    });
    const proposal = await service.proposeMemory(
      { ...testCase.followUp, sessionId: session.sessionId },
      { actor: 'harness', explicitDirective: false },
    );
    followUpStatus = proposal.status;
  }
  const sessionEventIds = new Set(testCase.events.map((event) => event.eventId));
  const pendingBeforeConsolidation = await service.listPendingProposals({
    sessionId: session.sessionId,
    limit: 100,
    offset: 0,
  });
  const consolidationCandidates = pendingBeforeConsolidation.items.filter((memory) =>
    memory.sourceEventIds.some((eventId) => sessionEventIds.has(eventId)),
  );
  await service.closeSession(session.sessionId);
  const consolidationResult = await service.consolidateSession(session.sessionId);
  const finalMemoryViews = await service.listAdminMemories({ q: '', limit: 100, offset: 0 });
  const finalMemories = {
    ...finalMemoryViews,
    items: finalMemoryViews.items.filter((memory) => memory.lifecycle !== 'rejected'),
  };
  const finalContents = unique(finalMemories.items.map((memory) => memory.content)).sort();
  const kinds = finalMemories.items.map((memory) => memory.kind).sort();
  const scopes = finalMemories.items
    .map((memory) => `${memory.scope.type}:${memory.scope.id}`)
    .sort();
  const conflicts = (await service.listConflicts()).items.length;
  const expected = testCase.expected;
  const candidateMetrics = setMetrics(extractedContents, expected.extractedContents);
  const precision = {
    hits: candidateMetrics.hits,
    total: candidateMetrics.actualTotal,
    matches: candidateMetrics.matches,
  };
  const recall = {
    hits: candidateMetrics.hits,
    total: candidateMetrics.expectedTotal,
    matches: candidateMetrics.matches,
  };
  const kindComparison = compare(kinds, expected.kinds);
  const scopeComparison = compare(scopes, expected.scopes);
  const actual = {
    extractedCount: extracted.length,
    extractedContents,
    finalContents,
    kinds,
    scopes,
    pendingBeforeReview: beforeReview.items.length,
    acceptedBeforeReview,
    acceptedAfterReview: finalMemories.items.filter((memory) => memory.lifecycle === 'accepted')
      .length,
    conflicts,
    duplicateMerges: Math.max(
      0,
      consolidationCandidates.length - consolidationResult.candidateCount,
    ),
    pendingContextLeaks: contextBeforeReview.context.length,
    followUpStatus,
  };
  const checks = [
    actual.extractedCount === expected.extractedCount,
    JSON.stringify(finalContents) === JSON.stringify(expected.finalContents),
    precision.matches,
    recall.matches,
    kindComparison.matches,
    scopeComparison.matches,
    actual.pendingBeforeReview === expected.pendingBeforeReview,
    actual.acceptedAfterReview === expected.acceptedAfterReview,
    actual.conflicts === expected.conflicts,
    actual.duplicateMerges === expected.duplicateMerges,
    actual.pendingContextLeaks === 0,
    actual.acceptedBeforeReview === 0,
  ];
  return {
    id: testCase.id,
    passed: checks.every(Boolean),
    expected,
    actual,
    metrics: {
      precisionHits: precision.hits,
      precisionTotal: precision.total,
      recallHits: recall.hits,
      recallTotal: recall.total,
      kindMatches: kindComparison.matchesCount,
      kindTotal: kindComparison.total,
      scopeMatches: scopeComparison.matchesCount,
      scopeTotal: scopeComparison.total,
    },
  };
}

function setMetrics(actual, expected) {
  const actualSet = new Set(actual.map(normalize));
  const expectedSet = new Set(expected.map(normalize));
  const hits = [...expectedSet].filter((value) => actualSet.has(value)).length;
  return {
    hits,
    actualTotal: actualSet.size,
    expectedTotal: expectedSet.size,
    matches: hits === expectedSet.size && actualSet.size === expectedSet.size,
  };
}

function compare(actual, expected) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const matchesCount = [...expectedSet].filter((value) => actualSet.has(value)).length;
  return {
    matchesCount,
    total: expectedSet.size,
    matches: actualSet.size === expectedSet.size && matchesCount === expectedSet.size,
  };
}

function unique(values) {
  return [...new Set(values.map(normalize))];
}

function normalize(value) {
  return value.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
}

function ratio(hits, total) {
  return total === 0 ? 1 : Number((hits / total).toFixed(4));
}
