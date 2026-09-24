import { readFile } from 'node:fs/promises';
import type {
  CorrectMemoryInput,
  MemoryLifecycle,
  MemoryRevision,
  OpenSessionInput,
  ProposeMemoryInput,
  RecordEventsInput,
} from '@mnemosyne/contracts';
import type {
  ConflictRecord,
  CorpusRevision,
  EventRecord,
  JobAttemptRecord,
  JobRecord,
  MemoryRecord,
  MemoryRepository,
  MemoryWithCurrent,
  BalancedRetentionCutoffs,
  RetentionRunCounts,
  RetentionState,
  CorpusRestore,
  CorpusRestoreCounts,
  OutboxEvent,
  MemoryFeedbackInput,
  MemoryFeedbackOutput,
  SessionRecord,
} from '@mnemosyne/core';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
export {
  PostgresIdempotencyStore,
  completeIdempotencyKey,
  reserveIdempotencyKey,
} from './idempotency-store.js';
export type { IdempotencyReservation } from '@mnemosyne/core';
export { PostgresSemanticSearchIndex } from './semantic-search-index.js';

type Database = Pick<Pool, 'query' | 'connect'> | Pick<PoolClient, 'query'>;

interface SessionRow extends QueryResultRow {
  id: string;
  project_id: string;
  area_ids: string[];
  task_title: string | null;
  sequence: string;
  status: 'open' | 'closed';
  created_at: Date;
  closed_at: Date | null;
}
interface EventRow extends QueryResultRow {
  event_id: string;
  session_id: string;
  sequence: string;
  type: 'message';
  role: 'user' | 'assistant' | 'tool';
  content: string;
  occurred_at: Date;
  explicit_memory_request: boolean;
}
interface MemoryRow extends QueryResultRow {
  id: string;
  current_version: number;
  lifecycle: MemoryLifecycle;
  created_at: Date;
  updated_at: Date;
}
interface MemoryRevisionRow extends QueryResultRow {
  memory_id: string;
  version: number;
  content: string;
  kind: MemoryRevision['kind'];
  scope_type: MemoryRevision['scope']['type'];
  scope_id: string;
  epistemic_basis: MemoryRevision['epistemicBasis'];
  assessment: MemoryRevision['assessment'];
  confidence: number | null;
  sensitivity: MemoryRevision['sensitivity'];
  activation: MemoryRevision['activation'];
  source_event_ids: string[];
}
interface ConflictRow extends QueryResultRow {
  id: string;
  type: ConflictRecord['type'];
  memory_ids: string[];
  status: 'open' | 'resolved';
}
interface JobRow extends QueryResultRow {
  id: string;
  operation: JobRecord['operation'];
  status: JobRecord['status'];
  session_id: string;
  available_at: Date | null;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface JobAttemptRow extends QueryResultRow {
  id: string;
  job_id: string;
  worker_id: string;
  attempt: number;
  status: JobAttemptRecord['status'];
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
}

interface OutboxRow extends QueryResultRow {
  id: string;
  event_type: string;
  aggregate_id: string;
  store_revision: string;
  payload: Record<string, unknown>;
}

interface MemoryFeedbackRow extends QueryResultRow {
  id: string;
  memory_id: string;
  session_id: string;
  kind: MemoryFeedbackOutput['kind'];
  comment: string | null;
  observed_at: Date;
  created_at: Date;
}

export class PostgresMemoryRepository implements MemoryRepository {
  constructor(private readonly database: Database) {}

  async restoreCorpus(input: CorpusRestore): Promise<CorpusRestoreCounts> {
    const client = await this.client();
    const forgottenMemoryIds = input.forgetLedger.map((entry) => entry.memoryId);
    const forgottenSet = new Set(forgottenMemoryIds);
    const restoredMemories = input.memories.filter((memory) => !forgottenSet.has(memory.record.id));
    const restoredMemoryIds = new Set(restoredMemories.map((memory) => memory.record.id));
    const restoredRevisions = input.revisions.filter(
      (item) => restoredMemoryIds.has(item.memoryId) && !forgottenSet.has(item.memoryId),
    );
    const restoredConflicts = input.conflicts.filter((conflict) =>
      conflict.memoryIds.every((memoryId) => restoredMemoryIds.has(memoryId)),
    );
    try {
      await client.query('BEGIN');
      for (const session of input.sessions) {
        await client.query(
          `INSERT INTO sessions (id, project_id, area_ids, task_title, sequence, status, created_at, closed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            session.id,
            session.projectId,
            session.areaIds,
            session.taskTitle,
            session.sequence,
            session.status,
            session.createdAt,
            session.closedAt,
          ],
        );
      }
      for (const event of input.events) {
        await client.query(
          `INSERT INTO events (session_id, event_id, sequence, type, role, content, occurred_at, explicit_memory_request)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            event.sessionId,
            event.id,
            event.sequence,
            event.type,
            event.role,
            event.content,
            event.occurredAt,
            event.explicitMemoryRequest,
          ],
        );
      }
      for (const memory of restoredMemories) {
        await client.query(
          `INSERT INTO memories (id, current_version, lifecycle, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            memory.record.id,
            memory.record.currentVersion,
            memory.record.lifecycle,
            memory.record.createdAt,
            memory.record.updatedAt,
          ],
        );
      }
      for (const item of restoredRevisions) {
        await this.insertRevision(client, item.memoryId, item.revision);
      }
      for (const conflict of restoredConflicts) {
        await client.query(
          `INSERT INTO conflicts (id, type, memory_ids, status)
           VALUES ($1, $2, $3, $4)`,
          [conflict.id, conflict.type, conflict.memoryIds, conflict.status],
        );
      }
      for (const job of input.jobs) {
        await client.query(
          `INSERT INTO jobs (id, operation, status, session_id, available_at, lease_owner, lease_expires_at, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            job.id,
            job.operation,
            job.status,
            job.sessionId,
            job.availableAt,
            job.leaseOwner,
            job.leaseExpiresAt,
            job.createdAt,
            job.updatedAt,
          ],
        );
      }
      for (const attempt of input.jobAttempts) {
        await client.query(
          `INSERT INTO job_attempts (id, job_id, worker_id, attempt, status, error_code, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            attempt.id,
            attempt.jobId,
            attempt.workerId,
            attempt.attempt,
            attempt.status,
            attempt.errorCode,
            attempt.createdAt,
            attempt.updatedAt,
          ],
        );
      }
      for (const entry of input.forgetLedger) {
        await client.query('INSERT INTO forget_ledger (memory_id, forgotten_at) VALUES ($1, $2)', [
          entry.memoryId,
          entry.forgottenAt,
        ]);
      }
      await client.query('COMMIT');
      return {
        restored: {
          sessions: input.sessions.length,
          events: input.events.length,
          memories: restoredMemories.length,
          revisions: restoredRevisions.length,
          conflicts: restoredConflicts.length,
          jobs: input.jobs.length,
          jobAttempts: input.jobAttempts.length,
          forgetLedger: input.forgetLedger.length,
        },
        skipped: {
          forgottenMemories: input.memories.length - restoredMemories.length,
          forgottenRevisions: input.revisions.length - restoredRevisions.length,
          forgottenConflicts: input.conflicts.length - restoredConflicts.length,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  static async fromConnectionString(connectionString: string): Promise<PostgresMemoryRepository> {
    const pool = new Pool({ connectionString });
    const repository = new PostgresMemoryRepository(pool);
    await repository.migrate();
    return repository;
  }

  static async fromPool(pool: Pool): Promise<PostgresMemoryRepository> {
    const repository = new PostgresMemoryRepository(pool);
    await repository.migrate();
    return repository;
  }

  async migrate(): Promise<void> {
    const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    await this.database.query(schema);
  }

  async createSession(input: OpenSessionInput): Promise<SessionRecord> {
    const result = await this.database.query<SessionRow>(
      `INSERT INTO sessions (id, project_id, area_ids, task_title, status)
       VALUES ($1, $2, $3, $4, 'open') RETURNING *`,
      [`ses_${randomUUID()}`, input.projectId, input.areaIds ?? [], input.taskTitle ?? null],
    );
    return this.sessionFromRow(result.rows[0]);
  }

  async findSession(id: string): Promise<SessionRecord | null> {
    const result = await this.database.query<SessionRow>('SELECT * FROM sessions WHERE id = $1', [
      id,
    ]);
    const row = result.rows[0];
    return row ? this.sessionFromRow(row) : null;
  }

  async closeSession(id: string): Promise<SessionRecord> {
    const result = await this.database.query<SessionRow>(
      `UPDATE sessions SET status = 'closed', closed_at = now() WHERE id = $1 RETURNING *`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new Error('session_not_found');
    return this.sessionFromRow(row);
  }

  async appendEvents(
    input: RecordEventsInput,
  ): Promise<{ accepted: EventRecord[]; duplicates: EventRecord[] }> {
    const client = await this.client();
    try {
      await client.query('BEGIN');
      const session = await this.lockedSession(client, input.sessionId);
      if (session.status !== 'open') throw new Error('session_closed');
      const accepted: EventRecord[] = [];
      const duplicates: EventRecord[] = [];
      let sequence = session.sequence;
      for (const event of input.events) {
        const existing = await client.query<EventRow>(
          'SELECT * FROM events WHERE session_id = $1 AND event_id = $2',
          [input.sessionId, event.eventId],
        );
        if (existing.rows[0]) {
          duplicates.push(this.eventFromRow(existing.rows[0]));
          continue;
        }
        sequence += 1;
        const inserted = await client.query<EventRow>(
          `INSERT INTO events (session_id, event_id, sequence, type, role, content, occurred_at, explicit_memory_request)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
          [
            input.sessionId,
            event.eventId,
            sequence,
            event.type,
            event.role,
            event.content,
            event.occurredAt,
            event.explicitMemoryRequest,
          ],
        );
        accepted.push(this.eventFromRow(inserted.rows[0]));
      }
      await client.query('UPDATE sessions SET sequence = $2 WHERE id = $1', [
        input.sessionId,
        sequence,
      ]);
      await client.query('COMMIT');
      return { accepted, duplicates };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async findEvents(sessionId: string): Promise<EventRecord[]> {
    const result = await this.database.query<EventRow>(
      'SELECT * FROM events WHERE session_id = $1 ORDER BY sequence',
      [sessionId],
    );
    return result.rows.map((row) => this.eventFromRow(row));
  }

  async createMemory(input: ProposeMemoryInput): Promise<MemoryRecord> {
    const client = await this.client();
    try {
      await client.query('BEGIN');
      const result = await client.query<MemoryRow>(
        "INSERT INTO memories (id, lifecycle) VALUES ($1, 'pending_approval') RETURNING *",
        [`mem_${randomUUID()}`],
      );
      const record = result.rows[0];
      await this.insertRevision(client, record.id, this.revisionFromInput(record.id, input));
      await client.query('COMMIT');
      return this.memoryFromRow(record);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getMemory(id: string): Promise<{ record: MemoryRecord; current: MemoryRevision } | null> {
    const result = await this.database.query<MemoryRow & MemoryRevisionRow>(
      `SELECT m.*, r.memory_id, r.version, r.content, r.kind, r.scope_type, r.scope_id,
              r.epistemic_basis, r.assessment, r.confidence, r.sensitivity, r.activation, r.source_event_ids
       FROM memories m JOIN memory_revisions r ON r.memory_id = m.id AND r.version = m.current_version
       WHERE m.id = $1`,
      [id],
    );
    const row = result.rows[0];
    return row ? { record: this.memoryFromRow(row), current: this.revisionFromRow(row) } : null;
  }

  async mergeMemorySources(
    id: string,
    expectedVersion: number,
    sourceEventIds: string[],
  ): Promise<MemoryRecord> {
    const client = await this.client();
    try {
      await client.query('BEGIN');
      const current = await client.query<MemoryRow & MemoryRevisionRow>(
        `SELECT m.*, r.memory_id, r.version, r.content, r.kind, r.scope_type, r.scope_id,
                r.epistemic_basis, r.assessment, r.confidence, r.sensitivity, r.activation,
                r.source_event_ids
         FROM memories m
         JOIN memory_revisions r ON r.memory_id = m.id AND r.version = m.current_version
         WHERE m.id = $1
         FOR UPDATE OF m`,
        [id],
      );
      const row = current.rows[0];
      if (!row) throw new Error('memory_not_found');
      if (row.current_version !== expectedVersion) throw new Error('memory_version_conflict');
      const revision = this.revisionFromRow(row);
      await this.insertRevision(client, id, {
        ...revision,
        version: expectedVersion + 1,
        sourceEventIds: [...new Set([...row.source_event_ids, ...sourceEventIds])],
      });
      const result = await client.query<MemoryRow>(
        'UPDATE memories SET current_version = $2, updated_at = now() WHERE id = $1 RETURNING *',
        [id, expectedVersion + 1],
      );
      await this.bumpCorpus(client, 'memory.sources.merged', id, expectedVersion);
      await client.query('COMMIT');
      return this.memoryFromRow(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async createRevision(input: CorrectMemoryInput): Promise<MemoryRecord> {
    const current = await this.getMemory(input.memoryId);
    if (!current) throw new Error('memory_not_found');
    if (current.record.currentVersion !== input.expectedVersion)
      throw new Error('memory_version_conflict');
    return this.updateMemoryRevision(input.memoryId, {
      memoryId: input.memoryId,
      version: input.expectedVersion + 1,
      content: input.content,
      kind: input.kind ?? current.current.kind,
      scope: input.scope ?? current.current.scope,
      epistemicBasis: input.epistemicBasis ?? current.current.epistemicBasis,
      assessment: input.assessment ?? current.current.assessment,
      confidence: input.confidence === undefined ? current.current.confidence : input.confidence,
      sensitivity: input.sensitivity ?? current.current.sensitivity,
      activation: input.activation ?? current.current.activation,
      sourceEventIds: current.current.sourceEventIds,
    });
  }

  async updateMemoryRevision(
    id: string,
    revision: MemoryRevision,
    options: { allowSameVersion?: boolean } = {},
  ): Promise<MemoryRecord> {
    const client = await this.client();
    try {
      await client.query('BEGIN');
      const current = await client.query<MemoryRow>(
        'SELECT * FROM memories WHERE id = $1 FOR UPDATE',
        [id],
      );
      const record = current.rows[0];
      if (!record) throw new Error('memory_not_found');
      if (!options.allowSameVersion && record.current_version !== revision.version - 1)
        throw new Error('memory_version_conflict');
      await this.insertRevision(client, id, revision);
      const previous = await client.query<{ lifecycle: MemoryLifecycle }>(
        'SELECT lifecycle FROM memories WHERE id = $1',
        [id],
      );
      const result = await client.query<MemoryRow>(
        `UPDATE memories
         SET current_version = $2,
             lifecycle = CASE WHEN $3 = 'pending_approval' THEN 'accepted' ELSE lifecycle END,
             updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, revision.version, previous.rows[0]?.lifecycle ?? 'accepted'],
      );
      await this.bumpCorpus(client, 'memory.revision.created', id, revision.version);
      await client.query('COMMIT');
      return this.memoryFromRow(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateMemoryLifecycle(id: string, lifecycle: MemoryLifecycle): Promise<MemoryRecord> {
    const client = await this.client();
    try {
      await client.query('BEGIN');
      const result = await client.query<MemoryRow>(
        'UPDATE memories SET lifecycle = $2, updated_at = now() WHERE id = $1 RETURNING *',
        [id, lifecycle],
      );
      const record = result.rows[0];
      if (!record) throw new Error('memory_not_found');
      if (lifecycle === 'accepted') await this.bumpCorpus(client, 'memory.accepted', id);
      await client.query('COMMIT');
      return this.memoryFromRow(record);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async removeMemory(id: string): Promise<void> {
    const client = await this.client();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT id FROM memories WHERE id = $1 FOR UPDATE', [id]);
      if (!result.rows[0]) throw new Error('memory_not_found');
      await client.query('DELETE FROM memories WHERE id = $1', [id]);
      await client.query(
        'INSERT INTO forget_ledger (memory_id) VALUES ($1) ON CONFLICT DO NOTHING',
        [id],
      );
      await this.bumpCorpus(client, 'memory.forgotten', id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async runBalancedRetention(cutoffs: BalancedRetentionCutoffs): Promise<RetentionRunCounts> {
    const client = await this.client();
    try {
      await client.query('BEGIN');
      const events = await client.query(
        `DELETE FROM events e
         USING sessions s
         WHERE e.session_id = s.id AND s.status = 'closed' AND s.closed_at < $1::timestamptz`,
        [cutoffs.closedEvents],
      );
      const pending = await client.query<{ id: string }>(
        `DELETE FROM memories m
         WHERE m.lifecycle = 'pending_approval'
           AND m.updated_at < $1::timestamptz
         RETURNING m.id`,
        [cutoffs.pendingCandidates],
      );
      const rejected = await client.query<{ id: string }>(
        `DELETE FROM memories m
         WHERE m.lifecycle = 'rejected'
           AND m.updated_at < $1::timestamptz
         RETURNING m.id`,
        [cutoffs.rejectedCandidates],
      );
      const retracted = await client.query<{ id: string }>(
        `DELETE FROM memories m
         WHERE m.lifecycle = 'retracted'
           AND m.updated_at < $1::timestamptz
         RETURNING m.id`,
        [cutoffs.retractedMemories],
      );
      const expiredMemoryIds = [
        ...pending.rows.map((row) => row.id),
        ...rejected.rows.map((row) => row.id),
        ...retracted.rows.map((row) => row.id),
      ];
      const conflicts = await client.query(
        `DELETE FROM conflicts c
         WHERE c.status = 'open'
           AND cardinality($1::text[]) > 0
           AND c.memory_ids <@ $1::text[]
           AND NOT (c.memory_ids && $2::text[])`,
        [expiredMemoryIds, await this.forgetLedgerIds(client, expiredMemoryIds)],
      );
      const superseded = await client.query(
        `DELETE FROM memory_revisions r
         USING memories m
         WHERE r.memory_id = m.id
           AND r.version <> m.current_version
           AND r.created_at < $1::timestamptz`,
        [cutoffs.supersededRevisions],
      );
      const deleted = {
        closedSessionEvents: events.rowCount ?? 0,
        pendingCandidates: pending.rowCount ?? 0,
        rejectedCandidates: rejected.rowCount ?? 0,
        supersededRevisions: superseded.rowCount ?? 0,
        retractedMemories: retracted.rowCount ?? 0,
        conflicts: conflicts.rowCount ?? 0,
      };
      const deletionCount = Object.values(deleted).reduce((total, count) => total + count, 0);
      if (deletionCount > 0) await this.bumpCorpus(client, 'retention.applied', 'corpus');
      await client.query('COMMIT');
      return deleted;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listCurrentMemories(): Promise<MemoryRevision[]> {
    const result = await this.database.query<MemoryRevisionRow>(
      `SELECT r.* FROM memories m JOIN memory_revisions r ON r.memory_id = m.id AND r.version = m.current_version
       WHERE m.lifecycle = 'accepted' ORDER BY m.updated_at DESC`,
    );
    return result.rows.map((row) => this.revisionFromRow(row));
  }

  async listAllEvents(): Promise<EventRecord[]> {
    const result = await this.database.query<EventRow>(
      'SELECT * FROM events ORDER BY session_id, sequence',
    );
    return result.rows.map((row) => this.eventFromRow(row));
  }

  async listAllMemoryRevisions(): Promise<Array<{ memoryId: string; revision: MemoryRevision }>> {
    const result = await this.database.query<MemoryRevisionRow>(
      'SELECT * FROM memory_revisions ORDER BY memory_id, version',
    );
    return result.rows.map((row) => ({
      memoryId: row.memory_id,
      revision: this.revisionFromRow(row),
    }));
  }

  async listForgetLedger(): Promise<Array<{ memoryId: string; forgottenAt: string }>> {
    const result = await this.database.query<{ memory_id: string; forgotten_at: Date }>(
      'SELECT memory_id, forgotten_at FROM forget_ledger ORDER BY forgotten_at, memory_id',
    );
    return result.rows.map((row) => ({
      memoryId: row.memory_id,
      forgottenAt: row.forgotten_at.toISOString(),
    }));
  }

  async listAllJobs(): Promise<JobRecord[]> {
    const result = await this.database.query<JobRow>('SELECT * FROM jobs ORDER BY created_at DESC');
    return result.rows.map((row) => this.jobFromRow(row));
  }

  async listAllJobAttempts(): Promise<JobAttemptRecord[]> {
    const result = await this.database.query<JobAttemptRow>(
      'SELECT * FROM job_attempts ORDER BY job_id, attempt DESC',
    );
    return result.rows.map((row) => this.jobAttemptFromRow(row));
  }

  async listPendingMemories(): Promise<MemoryRecord[]> {
    const result = await this.database.query<MemoryRow>(
      `SELECT * FROM memories
       WHERE lifecycle = 'pending_approval'
       ORDER BY updated_at DESC`,
    );
    return result.rows.map((row) => this.memoryFromRow(row));
  }

  async listMemoryViews(): Promise<MemoryWithCurrent[]> {
    const result = await this.database.query<MemoryRow & MemoryRevisionRow>(
      `SELECT m.*, r.memory_id, r.version, r.content, r.kind, r.scope_type, r.scope_id,
              r.epistemic_basis, r.assessment, r.confidence, r.sensitivity, r.activation, r.source_event_ids
       FROM memories m
       JOIN memory_revisions r ON r.memory_id = m.id AND r.version = m.current_version
       ORDER BY m.updated_at DESC`,
    );
    return result.rows.map((row) => ({
      record: this.memoryFromRow(row),
      current: this.revisionFromRow(row),
    }));
  }

  async listRevisions(id: string): Promise<MemoryRevision[]> {
    const result = await this.database.query<MemoryRevisionRow>(
      'SELECT * FROM memory_revisions WHERE memory_id = $1 ORDER BY version DESC',
      [id],
    );
    return result.rows.map((row) => this.revisionFromRow(row));
  }

  async findConflicts(memoryId: string): Promise<ConflictRecord[]> {
    const result = await this.database.query<ConflictRow>(
      'SELECT id, type, memory_ids, status FROM conflicts WHERE $1 = ANY(memory_ids)',
      [memoryId],
    );
    return result.rows.map((row) => this.conflictFromRow(row));
  }

  async listAllConflicts(): Promise<ConflictRecord[]> {
    const result = await this.database.query<ConflictRow>(
      'SELECT id, type, memory_ids, status FROM conflicts ORDER BY detected_at DESC',
    );
    return result.rows.map((row) => this.conflictFromRow(row));
  }

  async createConflict(
    memoryIds: string[],
    type: ConflictRecord['type'] = 'direct_contradiction',
  ): Promise<ConflictRecord> {
    const uniqueMemoryIds = [...new Set(memoryIds)];
    if (uniqueMemoryIds.length < 2) throw new Error('conflict_requires_two_memories');
    const client = await this.client();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [
        uniqueMemoryIds.join('\u0000'),
      ]);
      const existing = await client.query<ConflictRow>(
        `SELECT id, type, memory_ids, status
         FROM conflicts
         WHERE status = 'open'
           AND type = $2
           AND cardinality(memory_ids) = $3
           AND memory_ids @> $1::text[]
           AND memory_ids <@ $1::text[]
         LIMIT 1`,
        [uniqueMemoryIds, type, uniqueMemoryIds.length],
      );
      const existingRow = existing.rows[0];
      if (existingRow) {
        await client.query('COMMIT');
        return this.conflictFromRow(existingRow);
      }
      const result = await client.query<ConflictRow>(
        `INSERT INTO conflicts (id, type, memory_ids, status)
         VALUES ($1, $2, $3, 'open')
         RETURNING id, type, memory_ids, status`,
        [`conf_${randomUUID()}`, type, uniqueMemoryIds],
      );
      const row = result.rows[0];
      if (!row) throw new Error('conflict_create_failed');
      await client.query('COMMIT');
      return this.conflictFromRow(row);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async resolveConflict(id: string): Promise<ConflictRecord> {
    const result = await this.database.query<ConflictRow>(
      `UPDATE conflicts
       SET status = 'resolved'
       WHERE id = $1
       RETURNING id, type, memory_ids, status`,
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new Error('conflict_not_found');
    return this.conflictFromRow(row);
  }

  async createJob(job: Omit<JobRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<JobRecord> {
    const result = await this.database.query<JobRow>(
      'INSERT INTO jobs (id, operation, status, session_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [`job_${randomUUID()}`, job.operation, job.status, job.sessionId],
    );
    return this.jobFromRow(result.rows[0]);
  }

  async getJob(id: string): Promise<JobRecord | null> {
    const result = await this.database.query<JobRow>('SELECT * FROM jobs WHERE id = $1', [id]);
    return result.rows[0] ? this.jobFromRow(result.rows[0]) : null;
  }

  async listSessions(): Promise<SessionRecord[]> {
    const result = await this.database.query<SessionRow>(
      'SELECT * FROM sessions ORDER BY created_at DESC',
    );
    return result.rows.map((row) => this.sessionFromRow(row));
  }

  async listEvents(sessionId: string): Promise<EventRecord[]> {
    return this.findEvents(sessionId);
  }

  async listJobs(sessionId?: string): Promise<JobRecord[]> {
    const result = sessionId
      ? await this.database.query<JobRow>(
          'SELECT * FROM jobs WHERE session_id = $1 ORDER BY created_at DESC',
          [sessionId],
        )
      : await this.database.query<JobRow>('SELECT * FROM jobs ORDER BY created_at DESC');
    return result.rows.map((row) => this.jobFromRow(row));
  }

  async listJobAttempts(jobId: string) {
    const result = await this.database.query<JobAttemptRow>(
      'SELECT * FROM job_attempts WHERE job_id = $1 ORDER BY attempt DESC',
      [jobId],
    );
    return { items: result.rows.map((row) => this.jobAttemptFromRow(row)) };
  }

  async claimNextJob(workerId: string, leaseMs: number): Promise<JobRecord | null> {
    const client = await this.client();
    try {
      await client.query('BEGIN');
      await client.query(
        `WITH recovered AS (
           UPDATE jobs
           SET status = 'queued',
               available_at = now(),
               lease_owner = NULL,
               lease_expires_at = NULL,
               updated_at = now()
           WHERE status = 'running' AND lease_expires_at <= now()
           RETURNING id
         )
         UPDATE job_attempts attempts
         SET status = 'failed',
             error_code = 'lease_expired',
             updated_at = now()
         FROM recovered
         WHERE attempts.job_id = recovered.id AND attempts.status = 'running'`,
      );
      const result = await client.query<JobRow>(
        `UPDATE jobs
         SET status = 'running',
             lease_owner = $1,
             lease_expires_at = now() + ($2::integer * interval '1 millisecond'),
             updated_at = now()
         WHERE id = (
           SELECT id FROM jobs
           WHERE status = 'queued' AND (available_at IS NULL OR available_at <= now())
           ORDER BY created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         RETURNING *`,
        [workerId, leaseMs],
      );
      if (!result.rows[0]) {
        await client.query('COMMIT');
        return null;
      }
      await client.query('COMMIT');
      return this.jobFromRow(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async updateJob(id: string, status: JobRecord['status'], workerId: string): Promise<JobRecord> {
    const result = await this.database.query<JobRow>(
      `UPDATE jobs
       SET status = $2,
           available_at = NULL,
           lease_owner = CASE WHEN $2 = 'running' THEN $3 ELSE NULL END,
           lease_expires_at = CASE WHEN $2 = 'running' THEN lease_expires_at ELSE NULL END,
           updated_at = now()
       WHERE id = $1 AND status = 'running' AND lease_owner = $3
       RETURNING *`,
      [id, status, workerId],
    );
    if (!result.rows[0]) throw new Error(await this.jobUpdateError(id));
    return this.jobFromRow(result.rows[0]);
  }

  async renewJobLease(id: string, workerId: string, leaseMs: number): Promise<JobRecord> {
    const result = await this.database.query<JobRow>(
      `UPDATE jobs
       SET lease_expires_at = now() + ($3::integer * interval '1 millisecond'),
           updated_at = now()
       WHERE id = $1 AND status = 'running' AND lease_owner = $2
       RETURNING *`,
      [id, workerId, leaseMs],
    );
    if (!result.rows[0]) throw new Error(await this.jobUpdateError(id));
    return this.jobFromRow(result.rows[0]);
  }

  async retryJob(id: string, workerId: string, availableAt: string): Promise<JobRecord> {
    const result = await this.database.query<JobRow>(
      `UPDATE jobs
       SET status = 'queued',
           available_at = $3,
           lease_owner = NULL,
           lease_expires_at = NULL,
           updated_at = now()
       WHERE id = $1 AND status = 'running' AND lease_owner = $2
       RETURNING *`,
      [id, workerId, availableAt],
    );
    if (!result.rows[0]) throw new Error(await this.jobUpdateError(id));
    return this.jobFromRow(result.rows[0]);
  }

  async createJobAttempt(
    attempt: Omit<JobAttemptRecord, 'id' | 'workerId' | 'createdAt' | 'updatedAt'>,
    workerId: string,
  ): Promise<JobAttemptRecord> {
    const result = await this.database.query<JobAttemptRow>(
      `INSERT INTO job_attempts
         (id, job_id, worker_id, attempt, status, error_code, created_at, updated_at)
       SELECT $1, id, $5, $3, $4, $6, now(), now()
       FROM jobs
       WHERE id = $2 AND status = 'running' AND lease_owner = $5
       RETURNING *`,
      [
        `attempt_${randomUUID()}`,
        attempt.jobId,
        attempt.attempt,
        attempt.status,
        workerId,
        attempt.errorCode ?? null,
      ],
    );
    if (!result.rows[0]) throw new Error('job_lease_lost');
    return this.jobAttemptFromRow(result.rows[0]);
  }

  async finishJobAttempt(
    id: string,
    status: JobAttemptRecord['status'],
    workerId: string,
    errorCode?: string,
  ): Promise<JobAttemptRecord> {
    const result = await this.database.query<JobAttemptRow>(
      `UPDATE job_attempts
       SET status = $2, error_code = $3, updated_at = now()
       WHERE id = $1
         AND status = 'running'
         AND worker_id = $4
         AND EXISTS (
           SELECT 1 FROM jobs
           WHERE jobs.id = job_attempts.job_id
             AND jobs.status = 'running'
             AND jobs.lease_owner = $4
         )
       RETURNING *`,
      [id, status, errorCode ?? null, workerId],
    );
    if (!result.rows[0]) throw new Error('job_attempt_not_found');
    return this.jobAttemptFromRow(result.rows[0]);
  }

  async getCorpusRevision(): Promise<CorpusRevision> {
    const result = await this.database.query<{ id: string; epoch: string; revision: string }>(
      'SELECT id, epoch, revision FROM corpus_state WHERE id = $1',
      ['default'],
    );
    const row = result.rows[0];
    return { id: row.id, epoch: row.epoch, revision: BigInt(row.revision) };
  }

  async getRetentionState(): Promise<RetentionState> {
    const result = await this.database.query<{ last_run_at: Date | null }>(
      'SELECT last_run_at FROM retention_state WHERE id = $1',
      ['default'],
    );
    return { lastRunAt: result.rows[0]?.last_run_at?.toISOString() };
  }

  async recordRetentionRun(lastRunAt: string): Promise<void> {
    await this.database.query(
      `UPDATE retention_state
       SET last_run_at = $2, updated_at = now()
       WHERE id = $1`,
      ['default', lastRunAt],
    );
  }

  async claimOutboxEvents(limit: number): Promise<OutboxEvent[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('outbox_batch_size_invalid');
    }
    const result = await this.database.query<OutboxRow>(
      `SELECT id, event_type, aggregate_id, store_revision, payload
       FROM corpus_outbox
       WHERE processed_at IS NULL
       ORDER BY id
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      id: Number(row.id),
      eventType: row.event_type,
      aggregateId: row.aggregate_id,
      storeRevision: BigInt(row.store_revision),
      payload: row.payload,
    }));
  }

  async markOutboxProcessed(ids: number[]): Promise<void> {
    if (ids.length === 0) return;
    await this.database.query(
      'UPDATE corpus_outbox SET processed_at = now() WHERE id = ANY($1::bigint[]) AND processed_at IS NULL',
      [ids],
    );
  }

  async createFeedback(
    input: MemoryFeedbackInput & { id: string; createdAt: string },
  ): Promise<MemoryFeedbackOutput> {
    const result = await this.database.query<MemoryFeedbackRow>(
      `INSERT INTO memory_feedback
         (id, memory_id, session_id, kind, comment, observed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        input.id,
        input.memoryId,
        input.sessionId,
        input.kind,
        input.comment ?? null,
        input.observedAt,
        input.createdAt,
      ],
    );
    return this.feedbackFromRow(result.rows[0]);
  }

  async listFeedback(memoryId: string): Promise<MemoryFeedbackOutput[]> {
    const result = await this.database.query<MemoryFeedbackRow>(
      'SELECT * FROM memory_feedback WHERE memory_id = $1 ORDER BY created_at DESC, id',
      [memoryId],
    );
    return result.rows.map((row) => this.feedbackFromRow(row));
  }

  private async forgetLedgerIds(
    client: Pick<PoolClient, 'query'>,
    memoryIds: string[],
  ): Promise<string[]> {
    if (memoryIds.length === 0) return [];
    const result = await client.query<{ memory_id: string }>(
      'SELECT memory_id FROM forget_ledger WHERE memory_id = ANY($1::text[])',
      [memoryIds],
    );
    return result.rows.map((row) => row.memory_id);
  }

  private async client(): Promise<PoolClient> {
    if (!('connect' in this.database)) throw new Error('postgres_transaction_required');
    return this.database.connect();
  }

  private async lockedSession(
    client: PoolClient,
    id: string,
  ): Promise<{ status: 'open' | 'closed'; sequence: number }> {
    const result = await client.query<{ status: 'open' | 'closed'; sequence: string }>(
      'SELECT status, sequence FROM sessions WHERE id = $1 FOR UPDATE',
      [id],
    );
    const row = result.rows[0];
    if (!row) throw new Error('session_not_found');
    return { status: row.status, sequence: Number(row.sequence) };
  }

  private async insertRevision(
    client: PoolClient,
    memoryId: string,
    revision: MemoryRevision,
  ): Promise<void> {
    await client.query(
      `INSERT INTO memory_revisions (memory_id, version, content, kind, scope_type, scope_id, epistemic_basis, assessment, confidence, sensitivity, activation, source_event_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (memory_id, version) DO UPDATE SET content = EXCLUDED.content, kind = EXCLUDED.kind, scope_type = EXCLUDED.scope_type, scope_id = EXCLUDED.scope_id, epistemic_basis = EXCLUDED.epistemic_basis, assessment = EXCLUDED.assessment, confidence = EXCLUDED.confidence, sensitivity = EXCLUDED.sensitivity, activation = EXCLUDED.activation, source_event_ids = EXCLUDED.source_event_ids`,
      [
        memoryId,
        revision.version,
        revision.content,
        revision.kind,
        revision.scope.type,
        revision.scope.id,
        revision.epistemicBasis,
        revision.assessment,
        revision.confidence,
        revision.sensitivity,
        revision.activation,
        revision.sourceEventIds,
      ],
    );
  }

  private async bumpCorpus(
    client: PoolClient,
    eventType: string,
    aggregateId: string,
    version?: number,
  ): Promise<void> {
    const result = await client.query<{ revision: string }>(
      'UPDATE corpus_state SET revision = revision + 1, updated_at = now() WHERE id = $1 RETURNING revision',
      ['default'],
    );
    const row = result.rows[0];
    await client.query(
      'INSERT INTO corpus_outbox (event_type, aggregate_id, store_revision, payload) VALUES ($1, $2, $3, $4)',
      [
        eventType,
        aggregateId,
        row.revision,
        version === undefined ? { memoryId: aggregateId } : { memoryId: aggregateId, version },
      ],
    );
  }

  private revisionFromInput(id: string, input: ProposeMemoryInput): MemoryRevision {
    return {
      memoryId: id,
      version: 1,
      content: input.content,
      kind: input.kind,
      scope: input.scope,
      epistemicBasis: input.epistemicBasis,
      assessment: input.assessment,
      confidence: input.confidence,
      sensitivity: input.sensitivity,
      activation: input.activation,
      sourceEventIds: input.sourceEventIds,
    };
  }

  private sessionFromRow(row: SessionRow): SessionRecord {
    return {
      id: row.id,
      projectId: row.project_id,
      areaIds: row.area_ids,
      taskTitle: row.task_title ?? undefined,
      sequence: Number(row.sequence),
      status: row.status,
      createdAt: row.created_at.toISOString(),
      closedAt: row.closed_at?.toISOString(),
    };
  }

  private eventFromRow(row: EventRow): EventRecord {
    return {
      id: row.event_id,
      sessionId: row.session_id,
      sequence: Number(row.sequence),
      type: row.type,
      role: row.role,
      content: row.content,
      occurredAt: row.occurred_at.toISOString(),
      explicitMemoryRequest: row.explicit_memory_request,
    };
  }

  private memoryFromRow(row: MemoryRow): MemoryRecord {
    return {
      id: row.id,
      currentVersion: row.current_version,
      lifecycle: row.lifecycle,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private revisionFromRow(row: MemoryRevisionRow): MemoryRevision {
    return {
      memoryId: row.memory_id,
      version: row.version,
      content: row.content,
      kind: row.kind,
      scope: { type: row.scope_type, id: row.scope_id },
      epistemicBasis: row.epistemic_basis,
      assessment: row.assessment,
      confidence: row.confidence,
      sensitivity: row.sensitivity,
      activation: row.activation,
      sourceEventIds: row.source_event_ids,
    };
  }

  private jobFromRow(row: JobRow): JobRecord {
    return {
      id: row.id,
      operation: row.operation,
      status: row.status,
      sessionId: row.session_id,
      availableAt: row.available_at?.toISOString(),
      leaseOwner: row.lease_owner ?? undefined,
      leaseExpiresAt: row.lease_expires_at?.toISOString(),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private jobAttemptFromRow(row: JobAttemptRow): JobAttemptRecord {
    return {
      id: row.id,
      jobId: row.job_id,
      workerId: row.worker_id,
      attempt: row.attempt,
      status: row.status,
      errorCode: row.error_code ?? undefined,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private async jobUpdateError(id: string): Promise<'job_not_found' | 'job_lease_lost'> {
    const result = await this.database.query<{ id: string }>('SELECT id FROM jobs WHERE id = $1', [
      id,
    ]);
    return result.rows[0] ? 'job_lease_lost' : 'job_not_found';
  }

  private conflictFromRow(row: ConflictRow): ConflictRecord {
    return {
      id: row.id,
      type: row.type,
      memoryIds: row.memory_ids,
      status: row.status,
    };
  }

  private feedbackFromRow(row: MemoryFeedbackRow): MemoryFeedbackOutput {
    return {
      id: row.id,
      memoryId: row.memory_id,
      sessionId: row.session_id,
      kind: row.kind,
      comment: row.comment ?? undefined,
      observedAt: row.observed_at.toISOString(),
      createdAt: row.created_at.toISOString(),
    };
  }
}
