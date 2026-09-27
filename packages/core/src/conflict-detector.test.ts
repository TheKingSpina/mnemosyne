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

  it('does not compare different kinds', () => {
    expect(
      areDirectlyContradictory(base, {
        ...base,
        kind: 'preference',
        content: 'Il progetto non usa pnpm',
      }),
    ).toBe(false);
  });

  it('detects a contradiction that only becomes visible across scopes', () => {
    expect(
      areDirectlyContradictory(base, {
        ...base,
        scope: { type: 'global', id: 'personal' },
        content: 'Il progetto non usa pnpm',
      }),
    ).toBe(true);
    expect(
      areDirectlyContradictory(
        { ...base, scope: { type: 'project', id: 'a' } },
        {
          ...base,
          scope: { type: 'project', id: 'b' },
          content: 'Il progetto non usa pnpm',
        },
      ),
    ).toBe(true);
  });

  it('still requires the claim to match word for word', () => {
    expect(
      areDirectlyContradictory(base, {
        ...base,
        scope: { type: 'global', id: 'personal' },
        content: 'Il progetto non usa pnpm nel frontend',
      }),
    ).toBe(false);
  });

  it('does not treat a differently scoped agreement as a contradiction', () => {
    expect(
      areDirectlyContradictory(base, {
        ...base,
        scope: { type: 'global', id: 'personal' },
        content: 'Il progetto usa pnpm',
      }),
    ).toBe(false);
  });
});
