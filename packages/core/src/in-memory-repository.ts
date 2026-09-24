import type {
  CorrectMemoryInput,
  MemoryLifecycle,
  MemoryRevision,
  OpenSessionInput,
  ProposeMemoryInput,
  RecordEventsInput,
} from '@mnemosyne/contracts';
import { randomUUID } from 'node:crypto';
import type {
  ConflictRecord,
  CorpusRevision,
  EventRecord,
  JobRecord,
  MemoryRecord,
  MemoryRepository,
  SessionRecord,
} from './types.js';

export class InMemoryRepository implements MemoryRepository {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly events = new Map<string, EventRecord>();
  private readonly memories = new Map<string, MemoryRecord>();
  private readonly revisions = new Map<string, Map<number, MemoryRevision>>();
  private readonly conflicts = new Map<string, ConflictRecord>();
  private readonly jobs = new Map<string, JobRecord>();
  private corpusRevision: bigint = 1n;
  private readonly corpusEpoch = randomUUID();
  private readonly corpusId = 'corpus';

  async createSession(input: OpenSessionInput): Promise<SessionRecord> {
    const session: SessionRecord = {
      id: `ses_${randomUUID()}`,
      projectId: input.projectId,
      areaIds: [...(input.areaIds ?? [])],
      taskTitle: input.taskTitle,
      sequence: 0,
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async findSession(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async closeSession(id: string): Promise<SessionRecord> {
    const session = await this.requireSession(id);
    const closed = { ...session, status: 'closed' as const, closedAt: new Date().toISOString() };
    this.sessions.set(id, closed);
    return closed;
  }

  async appendEvents(
    input: RecordEventsInput,
  ): Promise<{ accepted: EventRecord[]; duplicates: EventRecord[] }> {
    const session = await this.requireSession(input.sessionId);
    if (session.status !== 'open') throw new Error('session_closed');
    const accepted: EventRecord[] = [];
    const duplicates: EventRecord[] = [];
    let sequence = session.sequence;
    for (const event of input.events) {
      const key = `${session.id}:${event.eventId}`;
      const existing = this.events.get(key);
      if (existing) {
        duplicates.push(existing);
        continue;
      }
      sequence += 1;
      const record: EventRecord = { ...event, id: event.eventId, sessionId: session.id, sequence };
      this.events.set(key, record);
      accepted.push(record);
    }
    this.sessions.set(session.id, { ...session, sequence });
    return { accepted, duplicates };
  }

  async findEvents(sessionId: string): Promise<EventRecord[]> {
    return [...this.events.values()]
      .filter((event) => event.sessionId === sessionId)
      .sort((left, right) => left.sequence - right.sequence);
  }

  async createMemory(input: ProposeMemoryInput): Promise<MemoryRecord> {
    const id = `mem_${randomUUID()}`;
    const now = new Date().toISOString();
    const record: MemoryRecord = {
      id,
      currentVersion: 1,
      lifecycle: 'pending_approval',
      createdAt: now,
      updatedAt: now,
    };
    this.memories.set(id, record);
    this.revisions.set(id, new Map([[1, this.revisionFromInput(id, input)]]));
    return record;
  }

  async getMemory(id: string): Promise<{ record: MemoryRecord; current: MemoryRevision } | null> {
    const record = this.memories.get(id);
    if (!record) return null;
    const current = this.revisions.get(id)?.get(record.currentVersion);
    return current ? { record, current } : null;
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
    const record = this.memories.get(id);
    if (!record) throw new Error('memory_not_found');
    if (!options.allowSameVersion && record.currentVersion !== revision.version - 1)
      throw new Error('memory_version_conflict');
    const versions = this.revisions.get(id) ?? new Map<number, MemoryRevision>();
    versions.set(revision.version, revision);
    this.revisions.set(id, versions);
    const updated: MemoryRecord = {
      ...record,
      currentVersion: revision.version,
      lifecycle: 'accepted',
      updatedAt: new Date().toISOString(),
    };
    this.memories.set(id, updated);
    this.corpusRevision += 1n;
    return updated;
  }

  async updateMemoryLifecycle(id: string, lifecycle: MemoryLifecycle): Promise<MemoryRecord> {
    const record = this.memories.get(id);
    if (!record) throw new Error('memory_not_found');
    const updated = { ...record, lifecycle, updatedAt: new Date().toISOString() };
    this.memories.set(id, updated);
    if (lifecycle === 'accepted') this.corpusRevision += 1n;
    return updated;
  }

  async removeMemory(id: string): Promise<void> {
    if (!this.memories.delete(id)) throw new Error('memory_not_found');
    this.revisions.delete(id);
    this.corpusRevision += 1n;
  }

  async listCurrentMemories(): Promise<MemoryRevision[]> {
    return [...this.memories.values()]
      .filter((memory) => memory.lifecycle === 'accepted')
      .map((memory) => this.revisions.get(memory.id)?.get(memory.currentVersion))
      .filter((revision): revision is MemoryRevision => revision !== undefined);
  }

  async findConflicts(memoryId: string): Promise<ConflictRecord[]> {
    return [...this.conflicts.values()].filter((conflict) => conflict.memoryIds.includes(memoryId));
  }

  async createJob(job: Omit<JobRecord, 'id' | 'createdAt'>): Promise<JobRecord> {
    const record: JobRecord = {
      ...job,
      id: `job_${randomUUID()}`,
      createdAt: new Date().toISOString(),
    };
    this.jobs.set(record.id, record);
    return record;
  }

  async getJob(id: string): Promise<JobRecord | null> {
    return this.jobs.get(id) ?? null;
  }

  async getCorpusRevision(): Promise<CorpusRevision> {
    return { id: this.corpusId, epoch: this.corpusEpoch, revision: this.corpusRevision };
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

  private async requireSession(id: string): Promise<SessionRecord> {
    const session = this.sessions.get(id);
    if (!session) throw new Error('session_not_found');
    return session;
  }
}
