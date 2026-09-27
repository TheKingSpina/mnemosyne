import { describe, expect, it } from 'vitest';
import { workerRuntimeCapabilitiesSchema } from '@mnemosyne/contracts';
import { PostgresMemoryRepository } from './index.js';

const capabilities = {
  neo4jConfigured: true,
  openRouterConfigured: false,
  extractionProvider: 'local' as const,
  retentionScheduled: true,
};

function fakeDatabase(rows: unknown[]) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  return {
    calls,
    database: {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows };
      },
    },
  };
}

describe('PostgresMemoryRepository runtime capabilities', () => {
  it('upserts the heartbeat by component', async () => {
    const { calls, database } = fakeDatabase([]);
    const repository = new PostgresMemoryRepository(database as never);
    const reportedAt = '2026-09-27T10:00:00.000Z';

    await repository.reportRuntimeCapabilities('worker', capabilities, reportedAt);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('INSERT INTO runtime_capabilities');
    expect(calls[0]?.text).toContain('ON CONFLICT (component) DO UPDATE');
    expect(calls[0]?.text).toContain('reported_at = EXCLUDED.reported_at');
    expect(calls[0]?.values).toEqual(['worker', JSON.stringify(capabilities), reportedAt]);
  });

  it('reads back the parsed payload and a normalised timestamp', async () => {
    const { calls, database } = fakeDatabase([
      { component: 'worker', capabilities, reported_at: new Date('2026-09-27T10:00:00.000Z') },
    ]);
    const repository = new PostgresMemoryRepository(database as never);

    const report = await repository.readRuntimeCapabilities('worker');

    expect(report).toEqual({
      component: 'worker',
      capabilities,
      reportedAt: '2026-09-27T10:00:00.000Z',
    });
    expect(calls[0]?.values).toEqual(['worker']);
  });

  it('returns null when the component has never reported', async () => {
    const { database } = fakeDatabase([]);
    const repository = new PostgresMemoryRepository(database as never);

    expect(await repository.readRuntimeCapabilities('worker')).toBeNull();
  });

  it('treats a payload that fails the contract as unobservable', async () => {
    // A stale row written by an older build must not be reported as a fact:
    // a capability that silently loses a required field would look configured.
    const { database } = fakeDatabase([
      { component: 'worker', capabilities: { neo4jConfigured: true }, reported_at: new Date() },
    ]);
    const repository = new PostgresMemoryRepository(database as never);

    expect(await repository.readRuntimeCapabilities('worker')).toBeNull();
  });

  it('keeps the stored payload compatible with the published contract', async () => {
    const { calls, database } = fakeDatabase([]);
    const repository = new PostgresMemoryRepository(database as never);

    await repository.reportRuntimeCapabilities('worker', capabilities, '2026-09-27T10:00:00.000Z');

    const stored = JSON.parse(String(calls[0]?.values?.[1])) as unknown;
    expect(workerRuntimeCapabilitiesSchema.parse(stored)).toEqual(capabilities);
  });
});
