import {
  cosineSimilarity,
  type SemanticSearchHit,
  type SemanticSearchIndex,
} from '@mnemosyne/core';
import type { Pool } from 'pg';

export class PostgresSemanticSearchIndex implements SemanticSearchIndex {
  readonly profile: string;
  readonly dimensions: number;

  constructor(
    private readonly pool: Pool,
    options: { profile: string; dimensions: number },
  ) {
    this.profile = options.profile;
    this.dimensions = options.dimensions;
  }

  async upsert(input: { memoryId: string; revision: number; embedding: number[] }): Promise<void> {
    await this.pool.query(
      `INSERT INTO memory_embeddings (memory_id, revision, profile, dimensions, embedding)
       VALUES ($1, $2, $3, $4, $5::vector)
       ON CONFLICT (memory_id, profile) DO UPDATE
       SET revision = EXCLUDED.revision,
           dimensions = EXCLUDED.dimensions,
           embedding = EXCLUDED.embedding,
           updated_at = now()`,
      [
        input.memoryId,
        input.revision,
        this.profile,
        this.dimensions,
        vectorLiteral(input.embedding),
      ],
    );
  }

  async remove(memoryId: string): Promise<void> {
    await this.pool.query('DELETE FROM memory_embeddings WHERE memory_id = $1', [memoryId]);
  }

  async search(input: { embedding: number[]; limit: number }): Promise<SemanticSearchHit[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new Error('semantic_search_limit_invalid');
    }
    const result = await this.pool.query<{ memory_id: string; embedding: string }>(
      `SELECT memory_id, embedding::text AS embedding
       FROM memory_embeddings
       WHERE profile = $2
       ORDER BY embedding <=> $1::vector, memory_id
       LIMIT $3`,
      [vectorLiteral(input.embedding), this.profile, input.limit],
    );
    return result.rows.map((row) => ({
      memoryId: row.memory_id,
      score: cosineSimilarity(parseVector(row.embedding, this.dimensions), input.embedding),
    }));
  }
}

function vectorLiteral(embedding: readonly number[]): string {
  if (embedding.some((value) => !Number.isFinite(value))) throw new Error('embedding_invalid');
  return `[${embedding.join(',')}]`;
}

function parseVector(value: string, dimensions: number): number[] {
  const values = value.slice(1, -1).split(',').map(Number);
  if (values.length !== dimensions || values.some((item) => !Number.isFinite(item))) {
    throw new Error('embedding_invalid');
  }
  return values;
}
