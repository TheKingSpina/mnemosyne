import { createClient, type RedisClientType } from 'redis';
import { corpusCacheKeyPrefix, type CorpusCache } from '@mnemosyne/core';

export class RedisCorpusCache implements CorpusCache {
  private constructor(private readonly client: RedisClientType) {}

  static async connect(url: string): Promise<RedisCorpusCache> {
    const client = createClient({ url });
    client.on('error', () => undefined);
    await client.connect();
    return new RedisCorpusCache(client);
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
      throw new Error('cache_ttl_invalid');
    }
    await this.client.set(key, value, { EX: ttlSeconds });
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async clear(): Promise<void> {
    for await (const keys of this.client.scanIterator({
      MATCH: `${corpusCacheKeyPrefix}*`,
      COUNT: 100,
    })) {
      for (const key of keys) await this.client.del(key);
    }
  }
}

export type CorpusCacheConnector = (url: string) => Promise<CorpusCache>;

/**
 * Resolves the optional corpus cache for a process. The API and MCP both call
 * this so the two cannot drift apart: an unconfigured REDIS_URL and an
 * unreachable Redis both mean "no cache", never a crash at startup.
 *
 * The degradation is silent by design, which is exactly why the capability
 * report has to be read from the process that answers: a missing cache is
 * reported as `projections.redis: false` rather than raising, and a caller
 * that never checks it will not notice that it lost the cache.
 */
export async function connectCorpusCache(
  url: string | undefined,
  connect: CorpusCacheConnector = (value) => RedisCorpusCache.connect(value),
): Promise<CorpusCache | undefined> {
  if (!url) return undefined;
  try {
    return await connect(url);
  } catch {
    return undefined;
  }
}
