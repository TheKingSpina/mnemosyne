import { describe, expect, it } from 'vitest';
import { DeterministicEmbeddingProvider, InMemorySemanticSearchIndex } from './semantic-search.js';

const provider = new DeterministicEmbeddingProvider(32);

describe('semantic search primitives', () => {
  it('creates deterministic normalized embeddings', async () => {
    const first = await provider.embed('Il progetto usa pnpm');
    const second = await provider.embed('Il progetto usa pnpm');

    expect(first).toEqual(second);
    expect(first).toHaveLength(32);
    expect(Math.sqrt(first.reduce((sum, value) => sum + value * value, 0))).toBeCloseTo(1);
  });

  it('ranks the closest synthetic memory first', async () => {
    const index = new InMemorySemanticSearchIndex({ dimensions: 32 });
    const relevant = await provider.embed('Il progetto usa pnpm');
    const unrelated = await provider.embed('La pizza preferita è margherita');
    await index.upsert({ memoryId: 'mem_unrelated', revision: 1, embedding: unrelated });
    await index.upsert({ memoryId: 'mem_relevant', revision: 1, embedding: relevant });

    const results = await index.search({ embedding: relevant, limit: 2 });

    expect(results[0]).toMatchObject({ memoryId: 'mem_relevant', score: 1 });
  });

  it('removes forgotten memories from the derived index', async () => {
    const index = new InMemorySemanticSearchIndex({ dimensions: 32 });
    const embedding = await provider.embed('Memoria sintetica');
    await index.upsert({ memoryId: 'mem_forgotten', revision: 1, embedding });

    await index.remove('mem_forgotten');

    await expect(index.search({ embedding, limit: 2 })).resolves.toEqual([]);
  });
});
