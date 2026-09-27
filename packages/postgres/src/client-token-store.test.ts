import { describe, expect, it } from 'vitest';
import { PostgresClientTokenStore } from './index.js';

function fakePool(rows: Record<string, unknown>[]) {
  const calls: Array<{ text: string; values?: unknown[] }> = [];
  return {
    calls,
    pool: {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows: values ? rows.slice(0, 1) : rows };
      },
    },
  };
}

const row = {
  id: 'ct_1',
  name: 'opencode',
  token_prefix: 'mnc_abcdefghi',
  role: 'owner',
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  last_used_at: null,
  revoked_at: null,
};

describe('PostgresClientTokenStore', () => {
  it('stores only the hash and the displayable prefix', async () => {
    const { pool, calls } = fakePool([row]);
    const store = new PostgresClientTokenStore(pool as never);

    const issued = await store.issue({
      name: 'opencode',
      tokenHash: 'a'.repeat(64),
      prefix: 'mnc_abcdefghi',
    });

    expect(issued.name).toBe('opencode');
    expect(issued.revokedAt).toBeNull();
    expect(calls[0]?.text).toContain('INSERT INTO client_tokens');
    expect(calls[0]?.text).toContain('ON CONFLICT (name) DO NOTHING');
    expect(calls[0]?.values).toEqual(['opencode', 'a'.repeat(64), 'mnc_abcdefghi']);
  });

  it('reuses a revoked name but never rotates an active one', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    let index = 0;
    const responses: Array<Record<string, unknown>[]> = [[], [row]];
    const pool = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows: responses[index++] ?? [] };
      },
    };
    const store = new PostgresClientTokenStore(pool as never);

    await store.issue({ name: 'opencode', tokenHash: 'd'.repeat(64), prefix: 'mnc_ddddddddd' });

    expect(calls).toHaveLength(2);
    expect(calls[1]?.text).toContain('revoked_at IS NOT NULL');
  });

  it('revokes by name and reports a missing token as null', async () => {
    const { pool, calls } = fakePool([]);
    const store = new PostgresClientTokenStore(pool as never);

    expect(await store.revoke('ghost')).toBeNull();
    expect(calls[0]?.text).toContain('UPDATE client_tokens');
    expect(calls[0]?.values).toEqual(['ghost']);
  });

  it('resolves an active token and stamps last use', async () => {
    const { pool, calls } = fakePool([{ role: 'owner' }]);
    const store = new PostgresClientTokenStore(pool as never);

    await expect(store.findActiveByHash('b'.repeat(64))).resolves.toBe('owner');
    expect(calls[0]?.text).toContain('revoked_at IS NULL');
    expect(calls[0]?.text).toContain('last_used_at = now()');
  });

  it('returns null for an unknown or revoked token', async () => {
    const { pool } = fakePool([]);
    const store = new PostgresClientTokenStore(pool as never);

    await expect(store.findActiveByHash('c'.repeat(64))).resolves.toBeNull();
  });
});
