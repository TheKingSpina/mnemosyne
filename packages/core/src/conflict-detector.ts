import type { MemoryRevision } from '@mnemosyne/contracts';

interface Polarity {
  base: string;
  polarity: 'affirmed' | 'denied';
}

interface ComparableMemory {
  kind: MemoryRevision['kind'];
  content: string;
  /** Accepted and deliberately not compared: see areDirectlyContradictory. */
  scope: MemoryRevision['scope'];
}

/**
 * Flags the narrow, high-confidence case: the same claim, word for word, with
 * exactly one negation between the two, whatever scope each side lives in.
 *
 * Scope is deliberately not part of the comparison. A contradiction that is only
 * visible when you widen the scope is still a contradiction, and the costs are
 * lopsided: a false positive costs one review item the owner resolves, while a
 * false negative leaves two incompatible claims in the corpus where retrieval
 * will happily return either. Bounding the false-positive surface is why the
 * match stays exact rather than fuzzy.
 */
export function areDirectlyContradictory(left: ComparableMemory, right: ComparableMemory): boolean {
  if (left.kind !== right.kind) return false;
  const leftAssertion = parsePolarity(left.content);
  const rightAssertion = parsePolarity(right.content);
  return (
    leftAssertion.polarity !== rightAssertion.polarity && leftAssertion.base === rightAssertion.base
  );
}

function parsePolarity(content: string): Polarity {
  const normalized = content.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
  const negation = /\b(?:non|not)\s+/u.exec(normalized);
  if (!negation) return { base: normalized, polarity: 'affirmed' };
  if (/\b(?:non|not)\s+/u.test(normalized.slice(negation.index + negation[0].length))) {
    return { base: normalized, polarity: 'affirmed' };
  }
  return {
    base: `${normalized.slice(0, negation.index)}${normalized.slice(
      negation.index + negation[0].length,
    )}`,
    polarity: 'denied',
  };
}
