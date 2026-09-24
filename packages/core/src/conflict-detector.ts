import type { MemoryRevision } from '@mnemosyne/contracts';

interface Polarity {
  base: string;
  polarity: 'affirmed' | 'denied';
}

interface ScopedMemory {
  kind: MemoryRevision['kind'];
  scope: MemoryRevision['scope'];
  content: string;
}

export function areDirectlyContradictory(left: ScopedMemory, right: ScopedMemory): boolean {
  if (left.kind !== right.kind) return false;
  if (left.scope.type !== right.scope.type || left.scope.id !== right.scope.id) return false;
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
