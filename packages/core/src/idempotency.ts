import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const responseSchema = z.object({
  status: z.number().int().min(100).max(599),
  body: z.unknown(),
});

export type StoredIdempotentResponse = z.infer<typeof responseSchema>;

export interface IdempotencyStore {
  get(key: string): Promise<StoredIdempotentResponse | null>;
  payloadMatches(key: string, payloadHash: string): Promise<boolean>;
  save(key: string, payloadHash: string, response: StoredIdempotentResponse): Promise<void>;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<
    string,
    { payloadHash: string; response: StoredIdempotentResponse }
  >();

  async get(key: string): Promise<StoredIdempotentResponse | null> {
    return this.records.get(key)?.response ?? null;
  }

  async save(key: string, payloadHash: string, response: StoredIdempotentResponse): Promise<void> {
    this.records.set(key, {
      payloadHash,
      response: responseSchema.parse(response),
    });
  }

  async payloadMatches(key: string, payloadHash: string): Promise<boolean> {
    const stored = this.records.get(key)?.payloadHash;
    return stored !== undefined && safeEqual(stored, payloadHash);
  }
}

export function hashIdempotencyPayload(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('base64url');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(',')}}`;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
