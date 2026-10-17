import type { ContextOutput, MemoryRevision } from '@mnemosyne/contracts';
import { describe, expect, it } from 'vitest';
import { formatContextForPrompt } from './format-context.js';

const baseMemory: MemoryRevision = {
  memoryId: 'mem_1',
  version: 1,
  content: 'Per i nuovi progetti usiamo pnpm',
  kind: 'convention',
  scope: { type: 'project', id: 'my-project' },
  epistemicBasis: 'user_asserted',
  assessment: 'uncontested',
  confidence: 1,
  sensitivity: 'normal',
  activation: 'on_demand',
  sourceEventIds: [],
};

describe('formatContextForPrompt', () => {
  it('returns empty string when context is empty', () => {
    expect(formatContextForPrompt({ context: [], conflicts: [] })).toBe('');
  });

  it('formats uncontested memories cleanly', () => {
    const formatted = formatContextForPrompt({
      context: [baseMemory],
      conflicts: [],
    });
    expect(formatted).toBe('- [CONVENTION]: Per i nuovi progetti usiamo pnpm');
  });

  it('renders explicit in-band warning when memories are in an open conflict', () => {
    const mem2: MemoryRevision = {
      ...baseMemory,
      memoryId: 'mem_2',
      content: 'Non usiamo pnpm',
      assessment: 'disputed',
    };
    const output: Pick<ContextOutput, 'context' | 'conflicts'> = {
      context: [baseMemory, mem2],
      conflicts: [
        {
          id: 'conf_1',
          type: 'direct_contradiction',
          memoryIds: ['mem_1', 'mem_2'],
        },
      ],
    };
    const formatted = formatContextForPrompt(output);
    expect(formatted).toContain(
      '- [CONVENTION [DISPUTED / CONTRADICTS mem_2]]: Per i nuovi progetti usiamo pnpm',
    );
    expect(formatted).toContain('- [CONVENTION [DISPUTED / CONTRADICTS mem_1]]: Non usiamo pnpm');
  });

  it('can opt out of warning tags if requested', () => {
    const mem2: MemoryRevision = {
      ...baseMemory,
      memoryId: 'mem_2',
      content: 'Non usiamo pnpm',
      assessment: 'disputed',
    };
    const output: Pick<ContextOutput, 'context' | 'conflicts'> = {
      context: [baseMemory, mem2],
      conflicts: [
        {
          id: 'conf_1',
          type: 'direct_contradiction',
          memoryIds: ['mem_1', 'mem_2'],
        },
      ],
    };
    const formatted = formatContextForPrompt(output, { includeDisputedWarning: false });
    expect(formatted).toBe(
      '- [CONVENTION]: Per i nuovi progetti usiamo pnpm\n- [CONVENTION]: Non usiamo pnpm',
    );
  });
});
