import type { IssuedClientToken, ClientTokenStore } from '@mnemosyne/core';
import { issuedClientTokenSchema } from '@mnemosyne/core';
import type { MemoryActor } from '@mnemosyne/contracts';
import type { Pool, QueryResultRow } from 'pg';

interface ClientTokenRow extends QueryResultRow {
  id: string;
  name: string;
  token_prefix: string;
  role: MemoryActor;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

export class PostgresClientTokenStore implements ClientTokenStore {
  constructor(private readonly pool: Pool) {}

  async issue(input: {
    name: string;
    tokenHash: string;
    prefix: string;
  }): Promise<IssuedClientToken> {
    const result = await this.pool.query<ClientTokenRow>(
      `INSERT INTO client_tokens (id, name, token_hash, token_prefix, role)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'owner')
       ON CONFLICT (name) DO UPDATE
         SET token_hash = EXCLUDED.token_hash,
             token_prefix = EXCLUDED.token_prefix,
             role = EXCLUDED.role,
             revoked_at = NULL,
             created_at = now()
       RETURNING id, name, token_prefix, role, created_at, last_used_at, revoked_at`,
      [input.name, input.tokenHash, input.prefix],
    );
    return toIssued(result.rows[0]);
  }

  async list(): Promise<IssuedClientToken[]> {
    const result = await this.pool.query<ClientTokenRow>(
      `SELECT id, name, token_prefix, role, created_at, last_used_at, revoked_at
       FROM client_tokens
       ORDER BY created_at DESC`,
    );
    return result.rows.map(toIssued);
  }

  async revoke(name: string): Promise<IssuedClientToken | null> {
    const result = await this.pool.query<ClientTokenRow>(
      `UPDATE client_tokens
       SET revoked_at = now()
       WHERE name = $1
       RETURNING id, name, token_prefix, role, created_at, last_used_at, revoked_at`,
      [name],
    );
    const row = result.rows[0];
    return row ? toIssued(row) : null;
  }

  async findActiveByHash(tokenHash: string): Promise<MemoryActor | null> {
    const result = await this.pool.query<{ role: MemoryActor }>(
      `UPDATE client_tokens
       SET last_used_at = now()
       WHERE token_hash = $1 AND revoked_at IS NULL
       RETURNING role`,
      [tokenHash],
    );
    return result.rows[0]?.role ?? null;
  }
}

function toIssued(row: ClientTokenRow | undefined): IssuedClientToken {
  if (!row) throw new Error('client_token_row_missing');
  return issuedClientTokenSchema.parse({
    id: row.id,
    name: row.name,
    prefix: row.token_prefix,
    role: row.role,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at ? row.last_used_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  });
}
