import { describe, expect, it } from 'vitest';
import { hashIdempotencyPayload, InMemoryIdempotencyStore } from './idempotency.js';

describe('IdempotencyStore', () => {
  it('replays a stored response for the same key and payload', async () => {
    const store = new InMemoryIdempotencyStore();
    const payloadHash = hashIdempotencyPayload({ b: 2, a: 1 });
    await store.save('request-1', payloadHash, { status: 201, body: { id: 'created' } });

    expect(await store.get('request-1')).toEqual({ status: 201, body: { id: 'created' } });
    expect(await store.payloadMatches('request-1', payloadHash)).toBe(true);
    expect(await store.payloadMatches('request-1', hashIdempotencyPayload({ a: 1, b: 3 }))).toBe(
      false,
    );
  });
});
