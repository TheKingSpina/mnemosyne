import { describe, expect, it } from 'vitest';
import { InMemoryCorpusCache } from './corpus-cache.js';

describe('CorpusCache', () => {
  it('stores and expires a value with a deterministic clock', async () => {
    let now = 1_000;
    const cache = new InMemoryCorpusCache(() => now);
    await cache.set('key', 'value', 10);

    expect(await cache.get('key')).toBe('value');
    now = 11_001;
    expect(await cache.get('key')).toBeNull();
  });
});
