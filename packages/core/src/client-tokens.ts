import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  clientTokenNameSchema,
  issuedClientTokenSchema,
  type IssuedClientToken,
  type MemoryActor,
} from '@mnemosyne/contracts';
import { DomainError } from './errors.js';

export const CLIENT_TOKEN_PREFIX = 'mnc';
const TOKEN_BYTES = 32;

/**
 * One credential per client, minted from the owner side. The plaintext is
 * returned exactly once at creation and only its hash is stored, so a stolen
 * database never yields a usable token.
 */
export interface ClientTokenStore {
  issue(input: { name: string; tokenHash: string; prefix: string }): Promise<IssuedClientToken>;
  list(): Promise<IssuedClientToken[]>;
  revoke(name: string): Promise<IssuedClientToken | null>;
  findActiveByHash(tokenHash: string): Promise<MemoryActor | null>;
}

export function generateClientToken(): { token: string; hash: string; prefix: string } {
  const token = `${CLIENT_TOKEN_PREFIX}_${randomBytes(TOKEN_BYTES).toString('base64url')}`;
  return { token, hash: hashClientToken(token), prefix: clientTokenPrefix(token) };
}

export function hashClientToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function clientTokenPrefix(token: string): string {
  return token.slice(0, CLIENT_TOKEN_PREFIX.length + 9);
}

export function parseBearerToken(authorization: string | undefined): string {
  const match = /^Bearer ([^\s]+)$/u.exec(authorization ?? '');
  if (!match) throw unauthorized();
  return match[1];
}

export function clientTokenHashesMatch(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export class InMemoryClientTokenStore implements ClientTokenStore {
  private readonly records = new Map<string, IssuedClientToken & { tokenHash: string }>();

  async issue(input: {
    name: string;
    tokenHash: string;
    prefix: string;
  }): Promise<IssuedClientToken> {
    const name = clientTokenNameSchema.parse(input.name);
    for (const record of this.records.values()) {
      if (record.name === name && record.revokedAt === null) {
        throw new DomainError('client_token_name_taken', 'Client token name already exists', 409);
      }
    }
    const record = {
      id: randomBytes(8).toString('hex'),
      name,
      tokenHash: input.tokenHash,
      prefix: input.prefix,
      role: 'owner' as const,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    };
    this.records.set(record.id, record);
    return toPublic(record);
  }

  async list(): Promise<IssuedClientToken[]> {
    return [...this.records.values()].map(toPublic);
  }

  async revoke(name: string): Promise<IssuedClientToken | null> {
    for (const record of this.records.values()) {
      if (record.name !== name) continue;
      if (record.revokedAt === null) {
        record.revokedAt = new Date().toISOString();
      }
      return toPublic(record);
    }
    return null;
  }

  async findActiveByHash(tokenHash: string): Promise<MemoryActor | null> {
    for (const record of this.records.values()) {
      if (record.revokedAt !== null) continue;
      if (clientTokenHashesMatch(record.tokenHash, tokenHash)) {
        record.lastUsedAt = new Date().toISOString();
        return record.role;
      }
    }
    return null;
  }
}

function toPublic(record: IssuedClientToken & { tokenHash: string }): IssuedClientToken {
  return issuedClientTokenSchema.parse({
    id: record.id,
    name: record.name,
    prefix: record.prefix,
    role: record.role,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  });
}

function unauthorized(): DomainError {
  return new DomainError('unauthorized', 'Authentication is required', 401);
}
