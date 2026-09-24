import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const storedIdempotentResponseSchema = z.object({
  status: z.number().int().min(100).max(599),
  body: z.unknown(),
});

export type StoredIdempotentResponse = z.infer<typeof storedIdempotentResponseSchema>;

export type IdempotencyReservation =
  | { state: 'reserved'; payloadMatches: false; response: null }
  | { state: 'in_progress'; payloadMatches: boolean; response: null }
  | {
      state: 'existing';
      payloadMatches: boolean;
      response: StoredIdempotentResponse;
    };

export interface IdempotencyStore {
  get(key: string): Promise<StoredIdempotentResponse | null>;
  payloadMatches(key: string, payloadHash: string): Promise<boolean>;
  save(key: string, payloadHash: string, response: StoredIdempotentResponse): Promise<void>;
  acquire(key: string, payloadHash: string): Promise<IdempotencyReservation>;
  abort(key: string, payloadHash: string): Promise<void>;
}

interface InMemoryRecord {
  payloadHash: string;
  response: StoredIdempotentResponse;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly records = new Map<string, InMemoryRecord>();
  private readonly pending = new Map<string, { payloadHash: string }>();

  async get(key: string): Promise<StoredIdempotentResponse | null> {
    return this.records.get(key)?.response ?? null;
  }

  async save(key: string, payloadHash: string, response: StoredIdempotentResponse): Promise<void> {
    this.records.set(key, {
      payloadHash,
      response: storedIdempotentResponseSchema.parse(response),
    });
    this.pending.delete(key);
  }

  async payloadMatches(key: string, payloadHash: string): Promise<boolean> {
    const stored = this.records.get(key)?.payloadHash;
    return stored !== undefined && safeEqual(stored, payloadHash);
  }

  async acquire(key: string, payloadHash: string): Promise<IdempotencyReservation> {
    const existing = this.records.get(key);
    if (existing) {
      return {
        state: 'existing',
        payloadMatches: safeEqual(existing.payloadHash, payloadHash),
        response: existing.response,
      };
    }
    const inProgress = this.pending.get(key)?.payloadHash;
    if (inProgress !== undefined) {
      return {
        state: 'in_progress',
        payloadMatches: safeEqual(inProgress, payloadHash),
        response: null,
      };
    }
    this.pending.set(key, { payloadHash });
    return { state: 'reserved', payloadMatches: false, response: null };
  }

  async abort(key: string, payloadHash: string): Promise<void> {
    if (this.pending.get(key)?.payloadHash === payloadHash) this.pending.delete(key);
  }
}

export function hashIdempotencyPayload(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('base64url');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    return serialized ?? 'null';
  }
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
