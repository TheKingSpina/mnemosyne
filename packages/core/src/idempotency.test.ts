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

  it('reserves a key and distinguishes an in-flight request', async () => {
    const store = new InMemoryIdempotencyStore();
    const payloadHash = hashIdempotencyPayload({ request: 1 });

    expect(await store.acquire('request-1', payloadHash)).toEqual({
      state: 'reserved',
      payloadMatches: false,
      response: null,
    });
    expect(await store.acquire('request-1', payloadHash)).toEqual({
      state: 'in_progress',
      payloadMatches: true,
      response: null,
    });
    expect(await store.acquire('request-1', hashIdempotencyPayload({ request: 2 }))).toEqual({
      state: 'in_progress',
      payloadMatches: false,
      response: null,
    });
  });

  it('allows a reservation to be aborted after a failed operation', async () => {
    const store = new InMemoryIdempotencyStore();
    const payloadHash = hashIdempotencyPayload({ request: 1 });
    await store.acquire('request-1', payloadHash);

    await store.abort('request-1', payloadHash);

    expect(await store.acquire('request-1', payloadHash)).toEqual({
      state: 'reserved',
      payloadMatches: false,
      response: null,
    });
  });
});
