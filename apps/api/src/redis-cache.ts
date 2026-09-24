import { createClient, type RedisClientType } from 'redis';
import type { CorpusCache } from '@mnemosyne/core';

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
}
