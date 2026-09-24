import type { MemoryRevision } from '@mnemosyne/contracts';
import { describe, expect, it } from 'vitest';
import { areDirectlyContradictory } from './conflict-detector.js';

const base: MemoryRevision = {
  memoryId: 'mem_left',
  version: 1,
  content: 'Il progetto usa pnpm',
  kind: 'convention',
  scope: { type: 'project', id: 'conflict-project' },
  epistemicBasis: 'user_asserted',
  assessment: 'uncontested',
  confidence: 1,
  sensitivity: 'normal',
  activation: 'on_demand',
  sourceEventIds: [],
};

describe('areDirectlyContradictory', () => {
  it('detects opposite polarity for the same scoped assertion', () => {
    expect(areDirectlyContradictory(base, { ...base, content: 'Il progetto non usa pnpm' })).toBe(
      true,
    );
  });

  it('does not treat matching polarity as a contradiction', () => {
    expect(areDirectlyContradictory(base, { ...base, content: 'Il progetto usa pnpm  ' })).toBe(
      false,
    );
  });

  it('does not compare different kinds or scopes', () => {
    expect(
      areDirectlyContradictory(base, {
        ...base,
        kind: 'preference',
        content: 'Il progetto non usa pnpm',
      }),
    ).toBe(false);
    expect(
      areDirectlyContradictory(base, {
        ...base,
        scope: { type: 'global', id: 'personal' },
        content: 'Il progetto non usa pnpm',
      }),
    ).toBe(false);
  });
});
