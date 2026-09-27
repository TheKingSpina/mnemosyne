import { retrievalTelemetryOutputSchema, type RetrievalTelemetry } from '@mnemosyne/contracts';

/**
 * Privacy-safe retrieval counters.
 *
 * The hard rule this file exists to enforce: nothing here ever records a query,
 * a memory id, a scope, or any corpus content. Everything is a count or a score
 * band, so the observation surface is aggregate behaviour and not a window into
 * what the owner or the harness is working on. If a future change needs to
 * record something identifying, that is a policy decision, not a refactor.
 *
 * Counters live in memory only and are never persisted: they die with the
 * process, so there is no new storage, no new migration and nothing to migrate
 * or forget later. The trade-off is no history, which is the deliberate choice.
 */

const CANDIDATE_BUCKETS = ['0', '1-5', '6-20', '21-100', '101-1000', '1000+'] as const;
const RESULT_BUCKETS = ['0', '1-5', '6-20', '21+'] as const;
const TOP_SCORE_BANDS = ['0', '0-0.2', '0.2-0.5', '0.5-1', '1'] as const;

type RetrievalPath = 'lexicalOnly' | 'semanticOnly' | 'hybrid' | 'empty';

interface MutableTelemetry {
  searches: number;
  contextResolutions: number;
  cacheHits: number;
  cacheMisses: number;
  paths: Record<RetrievalPath, number>;
  candidates: Record<(typeof CANDIDATE_BUCKETS)[number], number>;
  results: Record<(typeof RESULT_BUCKETS)[number], number>;
  topScoreBands: Record<(typeof TOP_SCORE_BANDS)[number], number>;
  semanticUnavailable: number;
}

function zeroed<const K extends readonly string[]>(keys: K): Record<K[number], number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K[number], number>;
}

function emptyTelemetry(): MutableTelemetry {
  return {
    searches: 0,
    contextResolutions: 0,
    cacheHits: 0,
    cacheMisses: 0,
    paths: { lexicalOnly: 0, semanticOnly: 0, hybrid: 0, empty: 0 },
    candidates: zeroed(CANDIDATE_BUCKETS),
    results: zeroed(RESULT_BUCKETS),
    topScoreBands: zeroed(TOP_SCORE_BANDS),
    semanticUnavailable: 0,
  };
}

function candidateBucket(count: number): (typeof CANDIDATE_BUCKETS)[number] {
  if (count <= 0) return '0';
  if (count <= 5) return '1-5';
  if (count <= 20) return '6-20';
  if (count <= 100) return '21-100';
  if (count <= 1000) return '101-1000';
  return '1000+';
}

function resultBucket(count: number): (typeof RESULT_BUCKETS)[number] {
  if (count <= 0) return '0';
  if (count <= 5) return '1-5';
  if (count <= 20) return '6-20';
  return '21+';
}

function scoreBand(score: number): (typeof TOP_SCORE_BANDS)[number] {
  if (score <= 0) return '0';
  if (score < 0.2) return '0-0.2';
  if (score < 0.5) return '0.2-0.5';
  if (score < 1) return '0.5-1';
  return '1';
}

export class RetrievalTelemetryCollector {
  private readonly state = emptyTelemetry();

  recordSearch(input: {
    candidateCount: number;
    resultCount: number;
    topScore: number;
    lexical: boolean;
    semantic: boolean;
    cached: boolean;
  }): void {
    this.state.searches += 1;
    if (input.cached) this.state.cacheHits += 1;
    else this.state.cacheMisses += 1;
    const path: RetrievalPath =
      input.resultCount === 0
        ? 'empty'
        : input.lexical && input.semantic
          ? 'hybrid'
          : input.semantic
            ? 'semanticOnly'
            : 'lexicalOnly';
    this.state.paths[path] += 1;
    this.state.candidates[candidateBucket(input.candidateCount)] += 1;
    this.state.results[resultBucket(input.resultCount)] += 1;
    this.state.topScoreBands[scoreBand(input.topScore)] += 1;
  }

  recordContextResolution(resultCount: number): void {
    this.state.contextResolutions += 1;
    this.state.results[resultBucket(resultCount)] += 1;
  }

  recordSemanticUnavailable(): void {
    this.state.semanticUnavailable += 1;
  }

  snapshot(reporter: string): RetrievalTelemetry {
    return retrievalTelemetryOutputSchema.parse({
      reporter,
      ...this.state,
      note: 'Counts and score bands only. No query text, no memory ids, no corpus content.',
    });
  }

  reset(): void {
    Object.assign(this.state, emptyTelemetry());
  }
}
