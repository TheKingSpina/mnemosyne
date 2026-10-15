import { describe, expect, it } from 'vitest';
import { PostgresMemoryRepository } from './index.js';

describe('PostgresMemoryRepository search pushdown', () => {
  it('uses the full-text index with a bounded scope and limit', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const database = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows: [] };
      },
    };
    const repository = new PostgresMemoryRepository(database as never);

    const result = await repository.searchCurrentMemories({
      query: 'cache:* or gateway:*',
      limit: 25,
      scopes: [
        { type: 'project', id: 'eval-retrieval' },
        { type: 'global', id: 'personal' },
      ],
    });

    expect(result).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toContain('websearch_to_tsquery');
    // The full-text filter must drive the plan. Without MATERIALIZED the
    // planner starts from memories, does one primary-key lookup per row and
    // applies the text match as a post-filter, ignoring the GIN index: 69 ms
    // for 15 rows at 10,000 memories against 2.1 ms for the same filter alone.
    expect(calls[0]?.text).toContain('WITH matched AS MATERIALIZED');
    expect(calls[0]?.text).toMatch(/JOIN memories m ON m\.id = matched\.memory_id/);
    expect(calls[0]?.text).toContain('ts_rank_cd');
    // Scope is not a stored string any more, so the buckets arrive separately
    // and the filter compares the columns that reference the real rows.
    expect(calls[0]?.text).toContain('r.session_id = ANY($2::text[])');
    expect(calls[0]?.text).toContain('r.area_id = ANY($3::text[])');
    expect(calls[0]?.text).toContain('r.project_id = ANY($4::text[])');
    expect(calls[0]?.text).toContain('LIMIT $6');
    expect(calls[0]?.values).toEqual([
      'cache:* or gateway:*',
      [],
      [],
      ['eval-retrieval'],
      'personal',
      25,
    ]);
  });

  it('returns nothing when the caller asks for no scopes at all', async () => {
    const calls: Array<{ text: string; values?: unknown[] }> = [];
    const database = {
      query: async (text: string, values?: unknown[]) => {
        calls.push({ text, values });
        return { rows: [] };
      },
    };
    const repository = new PostgresMemoryRepository(database as never);

    const result = await repository.searchCurrentMemories({
      query: 'cache',
      limit: 10,
      scopes: [],
    });

    // Every bucket empty means no scope can match, so the query must not run.
    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
