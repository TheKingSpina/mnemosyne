import { describe, expect, it } from 'vitest';
import { scoreMemoryForPruning, isPruningExempt, findStaleSource } from './pruning-score.js';

const NOW = '2026-10-16T12:00:00.000Z';

describe('scoreMemoryForPruning', () => {
  it('scores a fresh linked fact near the top', () => {
    const result = scoreMemoryForPruning({
      updatedAt: NOW,
      kind: 'fact',
      arcWeights: [0.8, 0.6],
      now: NOW,
    });
    // 0.5 * 1 + 0.3 * 0.7 + 0.2 * 1 = 0.91
    expect(result.score).toBeCloseTo(0.91, 5);
    expect(result.components.recency).toBe(1);
  });

  it('decays with age and stays within 0..1', () => {
    const old = scoreMemoryForPruning({
      // Seventeen half-lives old: recency is ~1/18, score ~0.24.
      updatedAt: '2019-06-01T12:00:00.000Z',
      kind: 'episode',
      arcWeights: [],
      now: NOW,
    });
    expect(old.score).toBeGreaterThanOrEqual(0);
    expect(old.score).toBeLessThanOrEqual(1);
    expect(old.score).toBeLessThan(0.25);
  });

  it('treats isolation as neutral rather than worthless', () => {
    const isolated = scoreMemoryForPruning({
      updatedAt: NOW,
      kind: 'convention',
      arcWeights: [],
      now: NOW,
    });
    const linked = scoreMemoryForPruning({
      updatedAt: NOW,
      kind: 'convention',
      arcWeights: [0.5],
      now: NOW,
    });
    expect(isolated.components.edgeWeight).toBe(0.5);
    expect(isolated.score).toBe(linked.score);
  });

  it('ignores null weights instead of dragging the mean down', () => {
    const result = scoreMemoryForPruning({
      updatedAt: NOW,
      kind: 'convention',
      arcWeights: [null, 0.8, null],
      now: NOW,
    });
    expect(result.components.edgeWeight).toBe(0.8);
  });

  it('exempts identity-grade kinds whatever the score', () => {
    expect(isPruningExempt('fact')).toBe(true);
    expect(isPruningExempt('decision')).toBe(true);
    expect(isPruningExempt('episode')).toBe(false);
    expect(isPruningExempt('preference')).toBe(false);
  });
});

describe('findStaleSource', () => {
  const proposal = { sourceIds: ['m1', 'a1'], sourceVersions: { m1: 2, a1: 0.4 } };

  it('returns null when everything matches', () => {
    expect(
      findStaleSource(proposal.sourceIds, proposal.sourceVersions, {
        m1: { snapshot: 2, usable: true },
        a1: { snapshot: 0.4, usable: true },
      }),
    ).toBeNull();
  });

  it('names a memory whose version moved', () => {
    expect(
      findStaleSource(proposal.sourceIds, proposal.sourceVersions, {
        m1: { snapshot: 3, usable: true },
        a1: { snapshot: 0.4, usable: true },
      }),
    ).toBe('m1');
  });

  it('names a source that is no longer usable', () => {
    expect(
      findStaleSource(proposal.sourceIds, proposal.sourceVersions, {
        m1: { snapshot: 2, usable: false },
        a1: { snapshot: 0.4, usable: true },
      }),
    ).toBe('m1');
  });

  it('names an arc whose weight changed', () => {
    expect(
      findStaleSource(proposal.sourceIds, proposal.sourceVersions, {
        m1: { snapshot: 2, usable: true },
        a1: { snapshot: 0.9, usable: true },
      }),
    ).toBe('a1');
  });

  it('names a source that vanished', () => {
    expect(
      findStaleSource(proposal.sourceIds, proposal.sourceVersions, {
        m1: { snapshot: 2, usable: true },
      }),
    ).toBe('a1');
  });
});
