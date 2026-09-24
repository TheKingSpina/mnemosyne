import { createHash } from 'node:crypto';

export interface EmbeddingProvider {
  readonly profile: string;
  readonly dimensions: number;
  embed(text: string): Promise<number[]>;
}

export interface SemanticSearchHit {
  memoryId: string;
  score: number;
}

export interface SemanticSearchIndex {
  readonly profile: string;
  readonly dimensions: number;
  upsert(input: { memoryId: string; revision: number; embedding: number[] }): Promise<void>;
  remove(memoryId: string): Promise<void>;
  search(input: { embedding: number[]; limit: number }): Promise<SemanticSearchHit[]>;
}

export interface SemanticSearchOptions {
  embeddingProvider?: EmbeddingProvider;
  semanticSearchIndex?: SemanticSearchIndex;
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly profile = 'deterministic-v1';
  readonly dimensions: number;

  constructor(dimensions = 64) {
    if (!Number.isSafeInteger(dimensions) || dimensions < 8 || dimensions > 4_096) {
      throw new Error('embedding_dimensions_invalid');
    }
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<number[]> {
    return deterministicEmbedding(text, this.dimensions);
  }
}

export class InMemorySemanticSearchIndex implements SemanticSearchIndex {
  readonly profile: string;
  readonly dimensions: number;
  private readonly records = new Map<string, { revision: number; embedding: number[] }>();

  constructor(options: { profile?: string; dimensions?: number } = {}) {
    this.profile = options.profile ?? 'deterministic-v1';
    this.dimensions = options.dimensions ?? 64;
    if (!Number.isSafeInteger(this.dimensions) || this.dimensions < 8) {
      throw new Error('embedding_dimensions_invalid');
    }
  }

  async upsert(input: { memoryId: string; revision: number; embedding: number[] }): Promise<void> {
    this.records.set(input.memoryId, {
      revision: input.revision,
      embedding: validateEmbedding(input.embedding, this.dimensions),
    });
  }

  async remove(memoryId: string): Promise<void> {
    this.records.delete(memoryId);
  }

  async search(input: { embedding: number[]; limit: number }): Promise<SemanticSearchHit[]> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
      throw new Error('semantic_search_limit_invalid');
    }
    const query = validateEmbedding(input.embedding, this.dimensions);
    return [...this.records.entries()]
      .map(([memoryId, record]) => ({
        memoryId,
        score: cosineSimilarity(query, record.embedding),
      }))
      .filter((hit) => hit.memoryId.length > 0 && hit.score > 0)
      .sort(
        (left, right) => right.score - left.score || left.memoryId.localeCompare(right.memoryId),
      )
      .slice(0, input.limit);
  }
}

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length !== right.length) throw new Error('embedding_dimensions_mismatch');
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftNorm += leftValue * leftValue;
    rightNorm += rightValue * rightValue;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

function deterministicEmbedding(text: string, dimensions: number): number[] {
  const values = Array.from({ length: dimensions }, () => 0);
  const tokens = text
    .normalize('NFKC')
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? [''];
  for (const token of tokens) {
    const digest = createHash('sha256').update(token).digest();
    const index = digest.readUInt32BE(0) % dimensions;
    const sign = (digest[4] ?? 0) % 2 === 0 ? 1 : -1;
    values[index] = (values[index] ?? 0) + sign;
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  return norm === 0 ? values : values.map((value) => value / norm);
}

function validateEmbedding(embedding: readonly number[], dimensions: number): number[] {
  if (embedding.length !== dimensions || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error('embedding_invalid');
  }
  return [...embedding];
}
