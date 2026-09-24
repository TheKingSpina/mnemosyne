import { describe, expect, it } from 'vitest';
import { assertMemoryPermission, createAccessPolicy, DomainError } from './index.js';

const ownerToken = 'owner-token-that-is-long-enough-for-tests-123456';
const harnessToken = 'harness-token-that-is-long-enough-for-tests-123456';

describe('access policy', () => {
  it('maps distinct bearer tokens to their roles', () => {
    const policy = createAccessPolicy({ ownerToken, harnessToken });

    expect(policy.authenticate(`Bearer ${ownerToken}`)).toBe('owner');
    expect(policy.authenticate(`Bearer ${harnessToken}`)).toBe('harness');
  });

  it('rejects missing and invalid bearer credentials', () => {
    const policy = createAccessPolicy({ ownerToken, harnessToken });

    expect(() => policy.authenticate(undefined)).toThrowError(DomainError);
    expect(() => policy.authenticate('Bearer wrong-token')).toThrowError(DomainError);
  });

  it('denies administrative permissions to the harness', () => {
    expect(() => assertMemoryPermission('harness', 'proposal.review')).toThrowError(
      new DomainError('forbidden', 'Insufficient permissions', 403),
    );
    expect(() => assertMemoryPermission('harness', 'memory.forget')).toThrowError(DomainError);
  });

  it('allows the harness to use non-administrative operations', () => {
    expect(() => assertMemoryPermission('harness', 'session.manage')).not.toThrow();
    expect(() => assertMemoryPermission('harness', 'context.resolve')).not.toThrow();
    expect(() => assertMemoryPermission('harness', 'memory.propose')).not.toThrow();
  });
});
