export interface CorpusCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
}

export const corpusCacheKeyPrefix = 'mnemosyne:';

export class InMemoryCorpusCache implements CorpusCache {
  private readonly records = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async get(key: string): Promise<string | null> {
    const record = this.records.get(key);
    if (!record) return null;
    if (record.expiresAt <= this.now()) {
      this.records.delete(key);
      return null;
    }
    return record.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1) {
      throw new Error('cache_ttl_invalid');
    }
    this.records.set(key, { value, expiresAt: this.now() + ttlSeconds * 1_000 });
  }

  async delete(key: string): Promise<void> {
    this.records.delete(key);
  }

  async clear(): Promise<void> {
    this.records.clear();
  }
}
