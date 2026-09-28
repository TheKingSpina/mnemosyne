import { describe, expect, it } from 'vitest';
import type { CorpusCache } from '@mnemosyne/core';
import { connectCorpusCache, type CorpusCacheConnector } from './index.js';

function stubCache(): CorpusCache {
  return {
    get: async () => null,
    set: async () => undefined,
    delete: async () => undefined,
    clear: async () => undefined,
  };
}

const unreachable: CorpusCacheConnector = async () => {
  throw new Error('cache_connect_failed');
};

describe('connectCorpusCache', () => {
  it('leaves the process without a cache when REDIS_URL is unset', async () => {
    let attempted = false;
    const connect: CorpusCacheConnector = async () => {
      attempted = true;
      return stubCache();
    };
    expect(await connectCorpusCache(undefined, connect)).toBeUndefined();
    expect(await connectCorpusCache('', connect)).toBeUndefined();
    expect(attempted).toBe(false);
  });

  it('returns the cache when the connection succeeds', async () => {
    const cache = stubCache();
    const connect: CorpusCacheConnector = async () => cache;
    expect(await connectCorpusCache('redis://redis:6379', connect)).toBe(cache);
  });

  it('degrades to no cache instead of failing startup when redis is unreachable', async () => {
    expect(await connectCorpusCache('redis://redis:6379', unreachable)).toBeUndefined();
  });

  it('passes the configured url to the connector', async () => {
    const seen: string[] = [];
    const connect: CorpusCacheConnector = async (url) => {
      seen.push(url);
      return stubCache();
    };
    await connectCorpusCache('redis://redis:6379', connect);
    expect(seen).toEqual(['redis://redis:6379']);
  });
});
