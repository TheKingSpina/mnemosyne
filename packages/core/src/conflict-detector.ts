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
  if (leftAssertion.polarity === rightAssertion.polarity) return false;
  const affirmed = leftAssertion.polarity === 'affirmed' ? leftAssertion : rightAssertion;
  const denied = leftAssertion.polarity === 'denied' ? leftAssertion : rightAssertion;
  return matchesAssertionBase(affirmed.base, denied.base);
}

const COMMON_STOPWORDS = new Set([
  'a',
  'ad',
  'al',
  'allo',
  'ai',
  'agli',
  'all',
  'alla',
  'alle',
  'da',
  'dal',
  'dallo',
  'dai',
  'dagli',
  'dall',
  'dalla',
  'dalle',
  'di',
  'del',
  'dello',
  'dei',
  'degli',
  'dell',
  'della',
  'delle',
  'in',
  'nel',
  'nello',
  'nei',
  'negli',
  'nell',
  'nella',
  'nelle',
  'su',
  'sul',
  'sullo',
  'sui',
  'sugli',
  'sull',
  'sulla',
  'sulle',
  'con',
  'per',
  'tra',
  'fra',
  'il',
  'lo',
  'la',
  'i',
  'gli',
  'le',
  'l',
  'un',
  'uno',
  'una',
  'è',
  'e',
  'ed',
  'ha',
  'ho',
  'hai',
  'hanno',
  'sia',
  'is',
  'are',
  'was',
  'were',
  'the',
  'an',
  'to',
  'of',
  'for',
  'in',
  'on',
  'at',
]);

function matchesAssertionBase(affirmedBase: string, deniedBase: string): boolean {
  if (affirmedBase === deniedBase) return true;
  // An unconditioned universal denial (e.g. "usiamo pnpm" or "chiudiamo") directly contradicts
  // a qualified/contextual affirmation (e.g. "per i nuovi progetti usiamo pnpm" or "chiudiamo alle diciotto")
  // because if the general claim is negated, no qualified sub-case can hold.
  // Note: the reverse (unqualified affirmation vs qualified denial, e.g. "usa pnpm" vs "non usa pnpm nel frontend")
  // is deliberately NOT contradictory, preserving domain compatibility where a general rule has a scoped exception.
  if (deniedBase.length >= 3 && !COMMON_STOPWORDS.has(deniedBase)) {
    if (
      affirmedBase.startsWith(`${deniedBase} `) ||
      affirmedBase.endsWith(` ${deniedBase}`) ||
      affirmedBase.includes(` ${deniedBase} `)
    ) {
      return true;
    }
  }
  return false;
}

function parsePolarity(content: string): Polarity {
  const normalized = content
    .normalize('NFKC')
    .replace(/[.,;!?]+$/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase();
  const negation = /\b(?:non|not)\s+/u.exec(normalized);
  if (!negation) return { base: normalized, polarity: 'affirmed' };
  if (/\b(?:non|not)\s+/u.test(normalized.slice(negation.index + negation[0].length))) {
    return { base: normalized, polarity: 'affirmed' };
  }
  return {
    base: `${normalized.slice(0, negation.index)}${normalized.slice(
      negation.index + negation[0].length,
    )}`.trim(),
    polarity: 'denied',
  };
}
