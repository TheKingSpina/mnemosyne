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
  JobRecord,
  MemoryRecord,
  MemoryRepository,
  MemoryWithCurrent,
  SessionRecord,
} from '@mnemosyne/core';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

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
interface JobRow extends QueryResultRow {
  id: string;
  operation: JobRecord['operation'];
  status: JobRecord['status'];
  session_id: string;
  created_at: Date;
}

export class PostgresMemoryRepository implements MemoryRepository {
  constructor(private readonly database: Database) {}

  static async fromConnectionString(connectionString: string): Promise<PostgresMemoryRepository> {
    const pool = new Pool({ connectionString });
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

  async listCurrentMemories(): Promise<MemoryRevision[]> {
    const result = await this.database.query<MemoryRevisionRow>(
      `SELECT r.* FROM memories m JOIN memory_revisions r ON r.memory_id = m.id AND r.version = m.current_version
       WHERE m.lifecycle = 'accepted' ORDER BY m.updated_at DESC`,
    );
    return result.rows.map((row) => this.revisionFromRow(row));
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
    const result = await this.database.query<{
      id: string;
      memory_ids: string[];
      status: 'open' | 'resolved';
    }>('SELECT id, memory_ids, status FROM conflicts WHERE $1 = ANY(memory_ids)', [memoryId]);
    return result.rows.map((row) => ({
      id: row.id,
      memoryIds: row.memory_ids,
      status: row.status,
    }));
  }

  async listAllConflicts(): Promise<ConflictRecord[]> {
    const result = await this.database.query<{
      id: string;
      memory_ids: string[];
      status: 'open' | 'resolved';
    }>('SELECT id, memory_ids, status FROM conflicts ORDER BY detected_at DESC');
    return result.rows.map((row) => ({
      id: row.id,
      memoryIds: row.memory_ids,
      status: row.status,
    }));
  }

  async createJob(job: Omit<JobRecord, 'id' | 'createdAt'>): Promise<JobRecord> {
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

  async getCorpusRevision(): Promise<CorpusRevision> {
    const result = await this.database.query<{ id: string; epoch: string; revision: string }>(
      'SELECT id, epoch, revision FROM corpus_state WHERE id = $1',
      ['default'],
    );
    const row = result.rows[0];
    return { id: row.id, epoch: row.epoch, revision: BigInt(row.revision) };
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
      createdAt: row.created_at.toISOString(),
    };
  }
}
