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
    expect(calls[0]?.text).toContain('ts_rank_cd');
    expect(calls[0]?.text).toContain('LIMIT $3');
    expect(calls[0]?.values).toEqual([
      'cache:* or gateway:*',
      ['project:eval-retrieval', 'global:personal'],
      25,
    ]);
  });
});
