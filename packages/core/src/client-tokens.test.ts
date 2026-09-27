import { describe, expect, it } from 'vitest';
import {
  DomainError,
  InMemoryClientTokenStore,
  clientTokenNameSchema,
  createAccessPolicy,
  createIssuedTokenAccessPolicy,
  generateClientToken,
  hashClientToken,
} from './index.js';

const ownerToken = 'owner-token-that-is-long-enough-for-tests-123456';
const harnessToken = 'harness-token-that-is-long-enough-for-tests-123456';

async function issuedPolicy(store: InMemoryClientTokenStore) {
  return createIssuedTokenAccessPolicy({
    base: createAccessPolicy({ ownerToken, harnessToken }),
    lookup: (tokenHash) => store.findActiveByHash(tokenHash),
  });
}

describe('issued client tokens', () => {
  it('mints a token whose plaintext is never stored', async () => {
    const store = new InMemoryClientTokenStore();
    const minted = generateClientToken();
    const issued = await store.issue({
      name: 'opencode',
      tokenHash: minted.hash,
      prefix: minted.prefix,
    });

    expect(minted.token.startsWith('mnc_')).toBe(true);
    expect(issued.name).toBe('opencode');
    expect(issued.role).toBe('owner');
    expect(issued.revokedAt).toBeNull();
    expect(JSON.stringify(await store.list())).not.toContain(minted.token);
    expect(hashClientToken(minted.token)).toBe(minted.hash);
  });

  it('maps an issued token to owner and keeps the static tokens working', async () => {
    const store = new InMemoryClientTokenStore();
    const policy = await issuedPolicy(store);
    const minted = generateClientToken();
    await store.issue({ name: 'opencode', tokenHash: minted.hash, prefix: minted.prefix });

    await expect(policy.authenticate(`Bearer ${minted.token}`)).resolves.toBe('owner');
    await expect(policy.authenticate(`Bearer ${ownerToken}`)).resolves.toBe('owner');
    await expect(policy.authenticate(`Bearer ${harnessToken}`)).resolves.toBe('harness');
    await expect(policy.authenticate(undefined)).rejects.toThrowError(DomainError);
    await expect(policy.authenticate('Bearer mnc_unknown')).rejects.toThrowError(DomainError);
  });

  it('stops accepting a revoked token without touching the others', async () => {
    const store = new InMemoryClientTokenStore();
    const policy = await issuedPolicy(store);
    const first = generateClientToken();
    const second = generateClientToken();
    await store.issue({ name: 'opencode', tokenHash: first.hash, prefix: first.prefix });
    await store.issue({ name: 'laptop', tokenHash: second.hash, prefix: second.prefix });

    await store.revoke('opencode');

    await expect(policy.authenticate(`Bearer ${first.token}`)).rejects.toThrowError(DomainError);
    await expect(policy.authenticate(`Bearer ${second.token}`)).resolves.toBe('owner');
    await expect(policy.authenticate(`Bearer ${ownerToken}`)).resolves.toBe('owner');
  });

  it('rejects duplicate names and malformed slugs', async () => {
    const store = new InMemoryClientTokenStore();
    const minted = generateClientToken();
    await store.issue({ name: 'opencode', tokenHash: minted.hash, prefix: minted.prefix });

    await expect(
      store.issue({ name: 'opencode', tokenHash: 'other', prefix: 'mnc_other' }),
    ).rejects.toThrowError(DomainError);
    expect(() => clientTokenNameSchema.parse('Open Code')).toThrow();
    expect(() => clientTokenNameSchema.parse('')).toThrow();
  });
});
