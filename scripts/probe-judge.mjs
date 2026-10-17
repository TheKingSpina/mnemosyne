#!/usr/bin/env node
// Probing harness for the calibrated pruning judge (stage 2): reads the 30
// labeled pairs in scripts/pruning-golden-set.json and evaluates:
// 1. Offline deterministic baseline (areDirectlyContradictory + fusePruningScores)
// 2. Live LlamaCppPruningJudge when PRUNING_JUDGE_ENABLED=true is set alongside
//    PRUNING_JUDGE_RERANK_MODEL and/or PRUNING_JUDGE_INSTRUCT_MODEL.
// Writes nothing anywhere; reports accuracy per category and exits non-zero if
// the deterministic invariants or live judge errors fail.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pruningPolicy } from '../packages/contracts/dist/index.js';
import { LlamaCppPruningJudge, fusePruningScores } from '../packages/core/dist/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const goldenPairs = JSON.parse(readFileSync(join(__dirname, 'pruning-golden-set.json'), 'utf8'));

const STOPWORDS = new Set([
  'il',
  'lo',
  'la',
  'i',
  'gli',
  'le',
  'un',
  'uno',
  'una',
  'di',
  'a',
  'da',
  'in',
  'con',
  'su',
  'per',
  'tra',
  'fra',
  'è',
  'e',
  'sono',
]);
const NEGATIONS = new Set(['non', 'not', 'no', 'mai', 'never']);

function normalizeTokens(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

function isDirectContradiction(leftText, rightText) {
  const leftTokens = normalizeTokens(leftText);
  const rightTokens = normalizeTokens(rightText);
  const leftNegated = leftTokens.some((token) => NEGATIONS.has(token));
  const rightNegated = rightTokens.some((token) => NEGATIONS.has(token));
  if (leftNegated === rightNegated) {
    return false;
  }
  const leftCore = leftTokens.filter((token) => !NEGATIONS.has(token));
  const rightCore = rightTokens.filter((token) => !NEGATIONS.has(token));
  return leftCore.length >= 2 && leftCore.join(' ') === rightCore.join(' ');
}

const pruning = pruningPolicy;

let deterministicChecks = 0;
let deterministicPassed = 0;

for (const pair of goldenPairs) {
  if (
    pair.category === 'contradiction_direct' ||
    pair.category === 'compatible_non_contradiction'
  ) {
    deterministicChecks += 1;
    const detected = isDirectContradiction(pair.left.content, pair.right.content);
    if (detected === pair.expectedAccept) {
      deterministicPassed += 1;
    } else {
      console.error(
        `[deterministic] fallimento su ${pair.id} (${pair.category}): atteso=${pair.expectedAccept}, ottenuto=${detected}`,
      );
    }
  }
}

// Verify score fusion parity invariant on synthetic boundary (fusedScore === 0.6)
// deterministicScore = 0.6 -> deterministicPressure = 0.4, deterministicWantsPrune = false
// calibratedScore = 0.8, calibratedVerdict = 'accept' -> calibratedWantsPrune = true
// fusedScore = 0.5 * 0.4 + 0.5 * 0.8 = 0.6 === fusionAcceptThreshold -> winner: 'deterministic'
const tieResult = fusePruningScores({
  deterministicScore: 0.6,
  calibratedScore: 0.8,
  calibratedVerdict: 'accept',
});
const tieInvariantOk = tieResult.decision === 'reject' && tieResult.winner === 'deterministic';

console.log(
  `Golden set caricato: ${goldenPairs.length} coppie (${deterministicPassed}/${deterministicChecks} check contraddizione deterministica, tie-break deterministico=${tieInvariantOk})`,
);

if (deterministicPassed !== deterministicChecks || !tieInvariantOk) {
  console.error('Fallimento nei check deterministici del golden set.');
  process.exit(1);
}

if (process.env.PRUNING_JUDGE_ENABLED !== 'true') {
  console.log(
    'Modalità offline completata. Per il probing live su llama-server imposta PRUNING_JUDGE_ENABLED=true, PRUNING_JUDGE_RERANK_MODEL e PRUNING_JUDGE_INSTRUCT_MODEL.',
  );
  process.exit(0);
}

const baseUrl = process.env.PRUNING_JUDGE_BASE_URL ?? 'http://127.0.0.1:8081/v1';
const apiKey = process.env.PRUNING_JUDGE_API_KEY;
const rerankModel = process.env.PRUNING_JUDGE_RERANK_MODEL;
const instructModel = process.env.PRUNING_JUDGE_INSTRUCT_MODEL;

if (!rerankModel || !instructModel) {
  console.error('Imposta sia PRUNING_JUDGE_RERANK_MODEL sia PRUNING_JUDGE_INSTRUCT_MODEL.');
  process.exit(2);
}

const judge = new LlamaCppPruningJudge({
  baseUrl,
  ...(apiKey ? { apiKey } : {}),
  rerankModel,
  instructModel,
});

let liveEvaluated = 0;
let liveCorrect = 0;
let liveFailed = 0;
const byCategory = {};

for (const pair of goldenPairs) {
  byCategory[pair.category] ??= { total: 0, correct: 0 };
  try {
    if (pair.category === 'redundancy_clear' || pair.category === 'distinct_nuance') {
      byCategory[pair.category].total += 1;
      liveEvaluated += 1;
      const scores = await judge.rerank(pair.left.content, [pair.right.content]);
      const calibratedScore = scores[0] ?? 0;
      const calibratedVerdict =
        calibratedScore >= pruning.redundancyRerankThreshold ? 'accept' : 'reject';
      const fusion = fusePruningScores({
        deterministicScore: 0.2,
        calibratedScore,
        calibratedVerdict,
      });
      const accepted = fusion.decision === 'accept' && calibratedVerdict === 'accept';
      if (accepted === pair.expectedAccept) {
        liveCorrect += 1;
        byCategory[pair.category].correct += 1;
      }
    } else if (pair.category === 'merge_candidate' && pair.target) {
      byCategory[pair.category].total += 1;
      liveEvaluated += 1;
      const { verdict } = await judge.verdict({
        proposalType: 'merge',
        items: [
          { memoryId: pair.left.id, kind: pair.left.kind, content: pair.left.content },
          { memoryId: pair.right.id, kind: pair.right.kind, content: pair.right.content },
          { memoryId: pair.target.id, kind: pair.target.kind, content: pair.target.content },
        ],
      });
      const fusion = fusePruningScores({
        deterministicScore: 0.2,
        calibratedScore: verdict.confidence,
        calibratedVerdict: verdict.verdict,
      });
      const accepted =
        verdict.verdict === 'accept' &&
        verdict.confidence >= pruning.verdictConfidenceThreshold &&
        fusion.decision === 'accept';
      if (accepted === pair.expectedAccept) {
        liveCorrect += 1;
        byCategory[pair.category].correct += 1;
      }
    }
  } catch (error) {
    liveFailed += 1;
    console.error(`Errore su coppia ${pair.id}: ${error?.message ?? error}`);
  }
}

console.log('');
console.log('=== Resa del giudice calibrato sul golden set ===');
console.log(
  `coppie valutate: ${liveEvaluated}, corrette: ${liveCorrect}, errori HTTP/parse: ${liveFailed}`,
);
for (const [cat, stats] of Object.entries(byCategory)) {
  if (stats.total > 0) {
    console.log(
      `  ${cat}: ${stats.correct}/${stats.total} (${((stats.correct / stats.total) * 100).toFixed(1)}%)`,
    );
  }
}

if (liveFailed > 0 || liveEvaluated === 0) {
  process.exit(1);
}
