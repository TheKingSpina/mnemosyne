import { describe, expect, it } from 'vitest';
import { composeAnalyzerBatches, type AnalyzerBatchInput } from './privacy-batch.js';

const NOW = '2026-10-16T12:00:00.000Z';

function node(overrides: Partial<AnalyzerBatchInput> & { memoryId: string }): AnalyzerBatchInput {
  return {
    kind: 'fact',
    scopeKind: 'project',
    updatedAt: NOW,
    content: 'contenuto con Nome Cognome e /percorsi/segreti',
    recordPrivacy: null,
    projectPrivacy: 'local_only',
    incidentArcTypes: [],
    ...overrides,
  };
}

describe('composeAnalyzerBatches', () => {
  it('drops everything local_only before any network call', () => {
    const batches = composeAnalyzerBatches(
      [
        node({ memoryId: 'm1' }),
        node({ memoryId: 'm2', recordPrivacy: 'local_only', projectPrivacy: 'public' }),
      ],
      10,
      NOW,
    );
    expect(batches).toEqual([]);
  });

  it('treats a missing project as local_only', () => {
    const batches = composeAnalyzerBatches(
      [node({ memoryId: 'm1', recordPrivacy: null, projectPrivacy: undefined })],
      10,
      NOW,
    );
    expect(batches).toEqual([]);
  });

  it('lets the node override win in both directions', () => {
    const batches = composeAnalyzerBatches(
      [
        node({ memoryId: 'm1', recordPrivacy: 'public', projectPrivacy: 'local_only' }),
        node({ memoryId: 'm2', recordPrivacy: 'anonymized', projectPrivacy: 'public' }),
      ],
      10,
      NOW,
    );
    expect(batches.map((batch) => batch.privacy).sort()).toEqual(['anonymized', 'public']);
  });

  it('never mixes flags in one batch and carries full content only for public', () => {
    const batches = composeAnalyzerBatches(
      [
        node({ memoryId: 'm1', recordPrivacy: 'public', projectPrivacy: 'local_only' }),
        node({ memoryId: 'm2', recordPrivacy: 'anonymized', projectPrivacy: 'local_only' }),
      ],
      10,
      NOW,
    );
    const pub = batches.find((batch) => batch.privacy === 'public');
    const anon = batches.find((batch) => batch.privacy === 'anonymized');
    expect(typeof pub?.items[0]?.content).toBe('string');
    expect(anon?.items[0]).not.toHaveProperty('content');
    expect(JSON.stringify(anon)).not.toContain('Nome Cognome');
    expect(JSON.stringify(anon)).not.toContain('/percorsi/segreti');
  });

  it('chunks large groups at the batch size', () => {
    const memories = Array.from({ length: 5 }, (_, index) =>
      node({ memoryId: `m${index}`, recordPrivacy: 'public', projectPrivacy: 'local_only' }),
    );
    const batches = composeAnalyzerBatches(memories, 2, NOW);
    expect(batches.map((batch) => batch.items.length)).toEqual([2, 2, 1]);
  });
});
