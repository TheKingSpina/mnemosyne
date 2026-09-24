import type { MemoryRevision } from '@mnemosyne/contracts';

export function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

export function estimateMemoryTokens(memory: MemoryRevision): number {
  return estimateTokens(JSON.stringify(memory));
}
