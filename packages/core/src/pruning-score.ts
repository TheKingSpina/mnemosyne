import { pruningPolicy, type MemoryKind } from '@mnemosyne/contracts';

export interface PruningScoreInput {
  updatedAt: string;
  kind: MemoryKind;
  arcWeights: Array<number | null>;
  now: string;
}

export interface PruningScoreComponents {
  recency: number;
  edgeWeight: number;
  kind: number;
}

export interface PruningScoreOutput {
  score: number;
  components: PruningScoreComponents;
}

// The deterministic proposer behind phase (a): pure, no repository, no clock.
// Every component is normalised to 0..1 and the weights sum to 1, so the score
// is itself a 0..1 confidence the ledger can reuse. Only the signals that exist
// enter the formula: recency from updatedAt, the mean of non-null accepted arc
// weights, and the per-kind factor. Access frequency is deliberately absent.
export function scoreMemoryForPruning(input: PruningScoreInput): PruningScoreOutput {
  const ageMs = Date.parse(input.now) - Date.parse(input.updatedAt);
  const ageDays = Math.max(0, ageMs / 86_400_000);
  const recency = 1 / (1 + ageDays / pruningPolicy.recencyHalfLifeDays);
  const weighted = input.arcWeights.filter((weight): weight is number => weight !== null);
  const edgeWeight =
    weighted.length === 0
      ? pruningPolicy.noArcNeutralWeight
      : weighted.reduce((sum, weight) => sum + weight, 0) / weighted.length;
  const kind = pruningPolicy.kindFactors[input.kind];
  const score =
    pruningPolicy.weights.recency * recency +
    pruningPolicy.weights.edgeWeight * edgeWeight +
    pruningPolicy.weights.kind * kind;
  return { score, components: { recency, edgeWeight, kind } };
}

// The decide step re-reads every source and compares against what the propose
// step saw. Anything that moved — version, lifecycle, weight, existence —
// makes the proposal stale, because pruning on an old photograph of the graph
// is exactly the failure mode the ledger exists to rule out.
export interface PruningFreshSource {
  snapshot: number | string;
  usable: boolean;
}

export function findStaleSource(
  sourceIds: string[],
  sourceVersions: Record<string, number | string>,
  fresh: Record<string, PruningFreshSource>,
): string | null {
  for (const id of sourceIds) {
    const seen = sourceVersions[id];
    const now = fresh[id];
    if (now === undefined || !now.usable || now.snapshot !== seen) return id;
  }
  return null;
}

export function isPruningExempt(kind: MemoryKind): boolean {
  return (pruningPolicy.neverExpireKinds as readonly string[]).includes(kind);
}
