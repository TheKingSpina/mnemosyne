import {
  storedIdempotentResponseSchema,
  type IdempotencyReservation,
  type IdempotencyStore,
  type StoredIdempotentResponse,
} from '@mnemosyne/core';
import type { Pool, PoolClient, QueryResultRow } from 'pg';

interface IdempotencyRow extends QueryResultRow {
  key: string;
  payload_hash: string;
  response_status: number;
  response_body: unknown;
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async get(key: string): Promise<StoredIdempotentResponse | null> {
    const result = await this.pool.query<IdempotencyRow>(
      `SELECT key, payload_hash, response_status, response_body
       FROM idempotency_keys
       WHERE key = $1`,
      [key],
    );
    const row = result.rows[0];
    return row && row.response_status >= 100
      ? storedIdempotentResponseSchema.parse({
          status: row.response_status,
          body: row.response_body,
        })
      : null;
  }

  async payloadMatches(key: string, payloadHash: string): Promise<boolean> {
    const result = await this.pool.query<{ payload_hash: string }>(
      'SELECT payload_hash FROM idempotency_keys WHERE key = $1',
      [key],
    );
    return result.rows[0]?.payload_hash === payloadHash;
  }

  async save(key: string, payloadHash: string, response: StoredIdempotentResponse): Promise<void> {
    await completeIdempotencyKey(this.pool, key, payloadHash, response);
  }

  async acquire(key: string, payloadHash: string): Promise<IdempotencyReservation> {
    return reserveIdempotencyKey(this.pool, key, payloadHash);
  }

  async abort(key: string, payloadHash: string): Promise<void> {
    await this.pool.query(
      'DELETE FROM idempotency_keys WHERE key = $1 AND payload_hash = $2 AND response_status = 0',
      [key, payloadHash],
    );
  }
}

export async function reserveIdempotencyKey(
  pool: Pick<Pool, 'connect'>,
  key: string,
  payloadHash: string,
): Promise<IdempotencyReservation> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = await client.query<IdempotencyRow>(
      `INSERT INTO idempotency_keys (key, payload_hash, response_status, response_body)
       VALUES ($1, $2, 0, 'null'::jsonb)
       ON CONFLICT (key) DO NOTHING
       RETURNING key, payload_hash, response_status, response_body`,
      [key, payloadHash],
    );
    if (inserted.rows[0]) {
      await client.query('COMMIT');
      return { state: 'reserved', payloadMatches: false, response: null };
    }
    const result = await client.query<IdempotencyRow>(
      `SELECT key, payload_hash, response_status, response_body
       FROM idempotency_keys
       WHERE key = $1
       FOR UPDATE`,
      [key],
    );
    const existing = result.rows[0];
    if (!existing) throw new Error('idempotency_key_not_found_after_conflict');
    await client.query('COMMIT');
    if (existing.response_status === 0) {
      return {
        state: 'in_progress',
        payloadMatches: existing.payload_hash === payloadHash,
        response: null,
      };
    }
    return {
      state: 'existing',
      payloadMatches: existing.payload_hash === payloadHash,
      response: storedIdempotentResponseSchema.parse({
        status: existing.response_status,
        body: existing.response_body,
      }),
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function completeIdempotencyKey(
  database: Pick<PoolClient, 'query'>,
  key: string,
  payloadHash: string,
  response: StoredIdempotentResponse,
): Promise<void> {
  const validated = storedIdempotentResponseSchema.parse(response);
  const result = await database.query(
    `UPDATE idempotency_keys
     SET response_status = $2, response_body = $3::jsonb
     WHERE key = $1 AND payload_hash = $4 AND response_status = 0`,
    [key, validated.status, JSON.stringify(validated.body ?? null), payloadHash],
  );
  if (result.rowCount !== 1) throw new Error('idempotency_key_not_reserved');
}
