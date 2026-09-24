import { timingSafeEqual } from 'node:crypto';
import type { MemoryActor } from '@mnemosyne/contracts';
import { DomainError } from './errors.js';

export const memoryPermissions = [
  'session.manage',
  'events.write',
  'context.resolve',
  'memory.read',
  'memory.propose',
  'job.read',
  'proposal.owner',
  'proposal.review',
  'memory.correct',
  'memory.retract',
  'memory.forget',
] as const;

export type MemoryPermission = (typeof memoryPermissions)[number];

export interface AccessPolicy {
  authenticate(authorization: string | undefined): MemoryActor;
  authorize(actor: MemoryActor, permission: MemoryPermission): void;
}

export function createProcessAccessPolicy(actor: MemoryActor): AccessPolicy {
  return {
    authenticate: () => actor,
    authorize: assertMemoryPermission,
  };
}

export function assertMemoryPermission(actor: MemoryActor, permission: MemoryPermission): void {
  if (actor === 'owner') return;
  if (permission === 'memory.read' || permission === 'memory.propose') return;
  if (
    permission === 'session.manage' ||
    permission === 'events.write' ||
    permission === 'context.resolve' ||
    permission === 'job.read'
  ) {
    return;
  }
  throw forbidden();
}

export function createAccessPolicy(tokens: {
  ownerToken: string;
  harnessToken: string;
}): AccessPolicy {
  validateToken(tokens.ownerToken, 'owner');
  validateToken(tokens.harnessToken, 'harness');
  if (secureEqual(tokens.ownerToken, tokens.harnessToken)) {
    throw new Error('bearer_tokens_must_differ');
  }

  return {
    authenticate(authorization) {
      const match = /^Bearer ([^\s]+)$/u.exec(authorization ?? '');
      if (!match) throw unauthorized();
      const supplied = match[1];
      if (secureEqual(supplied, tokens.ownerToken)) return 'owner';
      if (secureEqual(supplied, tokens.harnessToken)) return 'harness';
      throw unauthorized();
    },
    authorize: assertMemoryPermission,
  };
}

function validateToken(token: string, role: 'owner' | 'harness'): void {
  if (token.length < 32) throw new Error(`${role}_bearer_token_too_short`);
}

function secureEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function unauthorized(): DomainError {
  return new DomainError('unauthorized', 'Authentication is required', 401);
}

function forbidden(): DomainError {
  return new DomainError('forbidden', 'Insufficient permissions', 403);
}
