import { describe, expect, it } from 'vitest';
import { PostgresMemoryRepository } from './index.js';

const cutoffs = {
  closedEvents: '2026-09-01T00:00:00.000Z',
  pendingCandidates: '2026-09-01T00:00:00.000Z',
  rejectedCandidates: '2026-09-01T00:00:00.000Z',
  supersededRevisions: '2026-09-01T00:00:00.000Z',
  retractedMemories: '2026-09-01T00:00:00.000Z',
  processedOutboxEvents: '2026-09-20T00:00:00.000Z',
  terminalJobs: '2026-09-01T00:00:00.000Z',
  expiredIdempotencyKeys: '2026-09-01T00:00:00.000Z',
};

/**
 * Dispatches on the SQL text rather than on call order: runBalancedRetention
 * interleaves BEGIN/COMMIT, a forget-ledger lookup and bumpCorpus reads, so a
 * positional fake silently returns the wrong row for the wrong statement.
 */
function fakeDatabase(
  overrides: {
    outboxRows?: unknown[];
    eventRows?: unknown[];
    jobRows?: unknown[];
    idempotencyRows?: unknown[];
  } = {},
) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  const query = async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    const rows = text.includes('DELETE FROM corpus_outbox')
      ? (overrides.outboxRows ?? [])
      : text.includes('DELETE FROM events')
        ? (overrides.eventRows ?? [])
        : text.includes('DELETE FROM jobs')
          ? (overrides.jobRows ?? [])
          : text.includes('DELETE FROM idempotency_keys')
            ? (overrides.idempotencyRows ?? [])
            : text.includes('UPDATE corpus_state')
              ? [{ id: 'corpus', epoch: 'epoch-1', revision: 7n }]
              : [];
    return { rows, rowCount: rows.length };
  };
  return {
    calls,
    database: { query, connect: async () => ({ query, release: () => undefined }) },
  };
}

function sqlFor(calls: Array<{ text: string }>, fragment: string): string | undefined {
  return calls.find((call) => call.text.includes(fragment))?.text;
}

/** The corpus bump shows up as an outbox insert whose first value is the event type. */
function bumpedCorpus(calls: Array<{ text: string; values?: unknown[] }>): boolean {
  return calls.some(
    (call) =>
      call.text.includes('INSERT INTO corpus_outbox') && call.values?.[0] === 'retention.applied',
  );
}

describe('PostgresMemoryRepository retention prunes the outbox', () => {
  it('deletes processed outbox rows older than the cutoff and counts them', async () => {
    const { calls, database } = fakeDatabase({ outboxRows: [{ id: 1 }, { id: 2 }] });
    const repository = new PostgresMemoryRepository(database as never);

    const counts = await repository.runBalancedRetention(cutoffs);

    const prune = sqlFor(calls, 'DELETE FROM corpus_outbox');
    expect(prune).toContain('processed_at IS NOT NULL');
    expect(prune).toContain('processed_at < $1::timestamptz');
    expect(counts.processedOutboxEvents).toBe(2);
  });

  it('does not bump the corpus revision when only the outbox was pruned', async () => {
    // The outbox is derived projection feed. Bumping here would invalidate every
    // cached search in the deployment over rows nobody can see.
    const { calls, database } = fakeDatabase({ outboxRows: [{ id: 1 }] });
    const repository = new PostgresMemoryRepository(database as never);

    await repository.runBalancedRetention(cutoffs);

    expect(bumpedCorpus(calls)).toBe(false);
  });

  it('still bumps the corpus revision when corpus content was actually deleted', async () => {
    const { calls, database } = fakeDatabase({
      outboxRows: [{ id: 1 }],
      eventRows: [{ id: 'evt-gone' }],
    });
    const repository = new PostgresMemoryRepository(database as never);

    await repository.runBalancedRetention(cutoffs);

    expect(bumpedCorpus(calls)).toBe(true);
  });

  it('deletes terminal jobs older than the cutoff and counts them without bumping revision', async () => {
    const { calls, database } = fakeDatabase({ jobRows: [{ id: 'job-1' }, { id: 'job-2' }] });
    const repository = new PostgresMemoryRepository(database as never);

    const counts = await repository.runBalancedRetention(cutoffs);

    const prune = sqlFor(calls, 'DELETE FROM jobs');
    expect(prune).toContain("status IN ('succeeded', 'failed', 'quarantined', 'cancelled')");
    expect(prune).toContain('updated_at < $1::timestamptz');
    expect(counts.terminalJobs).toBe(2);
    expect(bumpedCorpus(calls)).toBe(false);
  });

  it('deletes expired idempotency keys older than the cutoff and counts them without bumping revision', async () => {
    const { calls, database } = fakeDatabase({ idempotencyRows: [{ key: 'k1' }] });
    const repository = new PostgresMemoryRepository(database as never);

    const counts = await repository.runBalancedRetention(cutoffs);

    const prune = sqlFor(calls, 'DELETE FROM idempotency_keys');
    expect(prune).toContain('created_at < $1::timestamptz');
    expect(counts.expiredIdempotencyKeys).toBe(1);
    expect(bumpedCorpus(calls)).toBe(false);
  });
});
