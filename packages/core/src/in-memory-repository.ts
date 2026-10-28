import { memoryKinds, memoryLifecycles } from '@mnemosyne/contracts';
import type {
  CorrectMemoryInput,
  MemoryKind,
  MemoryLifecycle,
  MemoryRevision,
  OpenSessionInput,
  ProjectCorpusAggregate,
  ProjectStructure,
  ProposeMemoryInput,
  RecordEventsInput,
  Scope,
  ScopeType,
  WorkerRuntimeCapabilities,
} from '@mnemosyne/contracts';
import { randomUUID, randomUUID as createRandomId } from 'node:crypto';
import type {
  ConflictRecord,
  CorpusRevision,
  CreateMemoryArcInput,
  CreateProjectArcInput,
  MemoryArc,
  PrivacyFlag,
  CreatePruningProposalInput,
  PruningLedgerEntry,
  PruningProposal,
  PruningProposalStatus,
  RecordPruningLedgerInput,
  ProjectArc,
  CreateMemoryInput,
  ProjectRecord,
  AreaRecord,
  CreateProjectInput,
  CreateAreaInput,
  EventRecord,
  JobRecord,
  MemoryRecord,
  MemoryRepository,
  MemoryWithCurrent,
  ProjectBreakdown,
  JobAttemptRecord,
  BalancedRetentionCutoffs,
  RetentionRunCounts,
  RetentionState,
  CorpusRestore,
  CorpusRestoreCounts,
  OutboxClaim,
  OutboxEvent,
  MemoryFeedbackInput,
  MemoryFeedbackOutput,
  SessionRecord,
  RuntimeCapabilityReport,
} from './types.js';
import type { ListJobAttemptsOutput } from '@mnemosyne/contracts';

export class InMemoryRepository implements MemoryRepository {
  constructor(private readonly now: () => Date = () => new Date()) {}

  private readonly memoryArcs = new Map<string, MemoryArc>();
  private readonly projectArcs = new Map<string, ProjectArc>();
  private readonly projects = new Map<string, ProjectRecord>();
  private readonly areas = new Map<string, AreaRecord>();
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly events = new Map<string, EventRecord>();
  private readonly memories = new Map<string, MemoryRecord>();
  private readonly revisions = new Map<string, Map<number, MemoryRevision>>();
  private readonly revisionTimestamps = new Map<string, Map<number, string>>();
  private readonly conflicts = new Map<string, ConflictRecord>();
  private readonly pruningProposals = new Map<string, PruningProposal>();
  private readonly pruningLedger = new Map<string, PruningLedgerEntry>();
  private readonly jobs = new Map<string, JobRecord>();
  private readonly jobAttempts = new Map<string, JobAttemptRecord[]>();
  private readonly forgetLedger = new Map<string, string>();
  private retentionState: RetentionState = {};
  private outbox: OutboxEvent[] = [];
  private readonly outboxClaims = new Map<
    number,
    { token: string; consumerId: string; expiresAt: number }
  >();
  private nextOutboxId = 1;
  private readonly feedback = new Map<string, MemoryFeedbackOutput[]>();
  private corpusRevision: bigint = 1n;
  private corpusEpoch = randomUUID();
  private readonly corpusId = 'corpus';
  private readonly runtimeCapabilities = new Map<string, RuntimeCapabilityReport>();

  async countMemories(): Promise<number> {
    return this.memories.size;
  }

  async reportRuntimeCapabilities(
    component: string,
    capabilities: WorkerRuntimeCapabilities,
    reportedAt: string,
  ): Promise<void> {
    this.runtimeCapabilities.set(component, { component, capabilities, reportedAt });
  }

  async readRuntimeCapabilities(component: string): Promise<RuntimeCapabilityReport | null> {
    return this.runtimeCapabilities.get(component) ?? null;
  }

  async restoreCorpus(input: CorpusRestore): Promise<CorpusRestoreCounts> {
    const forgottenMemoryIds = new Set(input.forgetLedger.map((entry) => entry.memoryId));
    const restoredMemories = input.memories.filter(
      (memory) => !forgottenMemoryIds.has(memory.record.id),
    );
    const restoredMemoryIds = new Set(restoredMemories.map((memory) => memory.record.id));
    const restoredRevisions = input.revisions.filter(
      (item) => restoredMemoryIds.has(item.memoryId) && !forgottenMemoryIds.has(item.memoryId),
    );
    // Projects arrive with full rows, so they are set before the sessions,
    // areas and memories that reference them.
    for (const project of input.projects) {
      this.projects.set(project.id, {
        id: project.id,
        name: project.name,
        ...(project.description === undefined ? {} : { description: project.description }),
        privacy: project.privacy,
        status: (project as ProjectRecord).status ?? 'active',
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      });
    }
    for (const area of input.areas) {
      this.areas.set(area.id, area);
    }
    for (const session of input.sessions) {
      this.sessions.set(session.id, session);
    }
    for (const event of input.events) {
      this.events.set(`${event.sessionId}:${event.id}`, event);
    }
    for (const memory of restoredMemories) {
      this.memories.set(memory.record.id, {
        ...memory.record,
        appliedCount: (memory.record as MemoryRecord).appliedCount ?? 0,
        lastAppliedAt: (memory.record as MemoryRecord).lastAppliedAt ?? null,
      });
      const revisions = new Map<number, MemoryRevision>();
      for (const item of restoredRevisions.filter((value) => value.memoryId === memory.record.id)) {
        revisions.set(item.revision.version, item.revision);
      }
      this.revisions.set(memory.record.id, revisions);
      const restoredAt = this.now().toISOString();
      this.revisionTimestamps.set(
        memory.record.id,
        new Map([...revisions.keys()].map((version) => [version, restoredAt])),
      );
    }
    for (const conflict of input.conflicts) {
      if (conflict.memoryIds.every((memoryId) => restoredMemoryIds.has(memoryId))) {
        this.conflicts.set(conflict.id, conflict);
      }
    }
    for (const job of input.jobs) {
      this.jobs.set(job.id, job);
    }
    for (const attempt of input.jobAttempts) {
      this.jobAttempts.set(attempt.jobId, [
        ...(this.jobAttempts.get(attempt.jobId) ?? []),
        attempt,
      ]);
    }
    for (const entry of input.forgetLedger)
      this.forgetLedger.set(entry.memoryId, entry.forgottenAt);
    this.memoryArcs.clear();
    for (const arc of input.memoryArcs) {
      if (!restoredMemoryIds.has(arc.fromMemoryId)) continue;
      if (!restoredMemoryIds.has(arc.toMemoryId)) continue;
      this.memoryArcs.set(arc.id, arc);
    }
    this.projectArcs.clear();
    for (const arc of input.projectArcs) {
      this.projectArcs.set(arc.id, arc);
    }
    this.outbox = [];
    this.outboxClaims.clear();
    this.nextOutboxId = 1;
    this.feedback.clear();
    this.corpusRevision = 1n;
    this.corpusEpoch = randomUUID();
    this.retentionState = {};
    return {
      restored: {
        sessions: input.sessions.length,
        events: input.events.length,
        memories: restoredMemories.length,
        revisions: restoredRevisions.length,
        conflicts: [...this.conflicts.values()].length,
        jobs: input.jobs.length,
        jobAttempts: input.jobAttempts.length,
        forgetLedger: input.forgetLedger.length,
      },
      skipped: {
        forgottenMemories: input.memories.length - restoredMemories.length,
        forgottenRevisions: input.revisions.length - restoredRevisions.length,
        forgottenConflicts: input.conflicts.filter(
          (conflict) => !conflict.memoryIds.every((memoryId) => restoredMemoryIds.has(memoryId)),
        ).length,
      },
    };
  }

  async createProject(input: CreateProjectInput): Promise<ProjectRecord> {
    const nameTaken = [...this.projects.values()].some(
      (project) => project.name.toLowerCase() === input.name.toLowerCase(),
    );
    if (nameTaken) throw new Error('project_name_taken');
    const timestamp = this.now().toISOString();
    const project: ProjectRecord = {
      id: input.id,
      name: input.name,
      ...(input.description === undefined ? {} : { description: input.description }),
      privacy: input.privacy ?? 'local_only',
      status: 'active',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.projects.set(project.id, project);
    return project;
  }

  async ensureProject(id: string): Promise<ProjectRecord> {
    const existing = this.projects.get(id);
    if (existing) return existing;
    const byName = await this.findProjectByName(id);
    if (byName) return byName;
    return this.createProject({ id, name: id });
  }

  async findProjectById(id: string): Promise<ProjectRecord | null> {
    return this.projects.get(id) ?? null;
  }

  async updateProjectPrivacy(id: string, privacy: PrivacyFlag): Promise<ProjectRecord> {
    const project = this.projects.get(id);
    if (!project) throw new Error('project_not_found');
    const marked: ProjectRecord = { ...project, privacy, updatedAt: this.now().toISOString() };
    this.projects.set(id, marked);
    return marked;
  }

  async updateProjectStatus(
    id: string,
    status: 'active' | 'dormant' | 'archived',
  ): Promise<ProjectRecord> {
    const project = this.projects.get(id);
    if (!project) throw new Error('project_not_found');
    const marked: ProjectRecord = { ...project, status, updatedAt: this.now().toISOString() };
    this.projects.set(id, marked);
    return marked;
  }

  async findProjectByName(name: string): Promise<ProjectRecord | null> {
    const wanted = name.toLowerCase();
    return [...this.projects.values()].find((p) => p.name.toLowerCase() === wanted) ?? null;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    return [...this.projects.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async createArea(input: CreateAreaInput): Promise<AreaRecord> {
    if (!this.projects.has(input.projectId)) throw new Error('project_not_found');
    const duplicate = [...this.areas.values()].some(
      (area) => area.projectId === input.projectId && area.name === input.name,
    );
    if (duplicate) throw new Error('area_name_taken');
    const timestamp = this.now().toISOString();
    const area: AreaRecord = {
      id: input.id,
      projectId: input.projectId,
      name: input.name,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.areas.set(area.id, area);
    return area;
  }

  async findAreaById(id: string): Promise<AreaRecord | null> {
    return this.areas.get(id) ?? null;
  }

  async listAreas(projectId: string): Promise<AreaRecord[]> {
    return [...this.areas.values()]
      .filter((area) => area.projectId === projectId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  // The corpus part of every project. The counts are what the PostgreSQL
  // backend computes with GROUP BY, and the in-memory backend has to answer
  // the same question the same way: the deterministic suite has to pass on
  // rules the real database would agree with.
  async listProjectCorpusAggregates(): Promise<ProjectCorpusAggregate[]> {
    const aggregates = new Map<string, ProjectCorpusAggregate>();
    const aggregate = (projectId: string): ProjectCorpusAggregate => {
      const existing = aggregates.get(projectId);
      if (existing) return existing;
      const created: ProjectCorpusAggregate = {
        projectId,
        memoryCount: 0,
        acceptedCount: 0,
        pendingApprovalCount: 0,
        rejectedCount: 0,
        retractedCount: 0,
        openConflictCount: 0,
        arcCount: 0,
      };
      aggregates.set(projectId, created);
      return created;
    };
    const projectOfMemory = new Map<string, string>();
    for (const record of this.memories.values()) {
      projectOfMemory.set(record.id, record.projectId);
      const entry = aggregate(record.projectId);
      entry.memoryCount += 1;
      if (record.lifecycle === 'accepted') entry.acceptedCount += 1;
      if (record.lifecycle === 'pending_approval') entry.pendingApprovalCount += 1;
      if (record.lifecycle === 'rejected') entry.rejectedCount += 1;
      if (record.lifecycle === 'retracted') entry.retractedCount += 1;
      if (entry.latestMemoryAt === undefined || record.updatedAt > entry.latestMemoryAt) {
        entry.latestMemoryAt = record.updatedAt;
      }
    }
    for (const conflict of this.conflicts.values()) {
      if (conflict.status !== 'open') continue;
      const projects = new Set(
        conflict.memoryIds
          .map((memoryId) => projectOfMemory.get(memoryId))
          .filter((projectId): projectId is string => projectId !== undefined),
      );
      for (const projectId of projects) aggregate(projectId).openConflictCount += 1;
    }
    for (const arc of this.memoryArcs.values()) {
      const projects = new Set(
        [arc.fromMemoryId, arc.toMemoryId]
          .map((memoryId) => projectOfMemory.get(memoryId))
          .filter((projectId): projectId is string => projectId !== undefined),
      );
      for (const projectId of projects) aggregate(projectId).arcCount += 1;
    }
    for (const arc of this.projectArcs.values()) {
      aggregate(arc.fromProjectId).arcCount += 1;
      if (arc.toProjectId !== arc.fromProjectId) aggregate(arc.toProjectId).arcCount += 1;
    }
    return [...aggregates.values()];
  }

  async listProjectStructure(): Promise<ProjectStructure[]> {
    return [...this.projects.values()].map((project) => ({
      projectId: project.id,
      areaCount: [...this.areas.values()].filter((area) => area.projectId === project.id).length,
      sessionCount: [...this.sessions.values()].filter(
        (session) => session.projectId === project.id,
      ).length,
    }));
  }

  async listProjectMemoryViews(projectId: string): Promise<MemoryWithCurrent[]> {
    return [...this.memories.values()]
      .filter((record) => record.projectId === projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .flatMap((record) => {
        const current = this.revisions.get(record.id)?.get(record.currentVersion);
        return current ? [{ record, current }] : [];
      });
  }

  async listRecentProjectMemories(input: {
    projectId: string;
    limit: number;
    scopes: Scope[] | null;
  }): Promise<MemoryWithCurrent[]> {
    const views = [...this.memories.values()]
      .filter((record) => record.projectId === input.projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .flatMap((record) => {
        const current = this.revisions.get(record.id)?.get(record.currentVersion);
        return current ? [{ record, current }] : [];
      });
    if (input.scopes === null) return views.slice(0, input.limit);
    return views
      .filter(
        (view) =>
          view.record.lifecycle === 'accepted' &&
          input.scopes!.some(
            (scope) => scope.type === view.current.scope.type && scope.id === view.current.scope.id,
          ),
      )
      .slice(0, input.limit);
  }

  async listProjectConflicts(projectId: string): Promise<ConflictRecord[]> {
    const projectOfMemory = new Map<string, string>();
    for (const record of this.memories.values()) projectOfMemory.set(record.id, record.projectId);
    return [...this.conflicts.values()].filter(
      (conflict) =>
        conflict.status === 'open' &&
        conflict.memoryIds.some((memoryId) => projectOfMemory.get(memoryId) === projectId),
    );
  }

  async listProjectBreakdown(projectId: string): Promise<ProjectBreakdown> {
    const byKind = Object.fromEntries(memoryKinds.map((kind) => [kind, 0])) as Record<
      MemoryKind,
      number
    >;
    const byLifecycle = Object.fromEntries(
      memoryLifecycles.map((lifecycle) => [lifecycle, 0]),
    ) as Record<MemoryLifecycle, number>;
    const byScope = { session: 0, project: 0, area: 0 };
    for (const view of await this.listProjectMemoryViews(projectId)) {
      byKind[view.current.kind] += 1;
      byLifecycle[view.record.lifecycle] += 1;
      byScope[view.current.scope.type] += 1;
    }
    return { byKind, byLifecycle, byScope };
  }

  async listProjectMemories(input: {
    projectId: string;
    kind?: MemoryKind;
    lifecycle?: MemoryLifecycle;
    scopeType?: ScopeType;
    scopeId?: string;
    q?: string;
    limit: number;
    offset: number;
    scopes: Scope[] | null;
  }): Promise<{ items: MemoryWithCurrent[]; total: number }> {
    const query = (input.q ?? '').trim().toLocaleLowerCase();
    const views = [...this.memories.values()]
      .filter((record) => record.projectId === input.projectId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .flatMap((record) => {
        const current = this.revisions.get(record.id)?.get(record.currentVersion);
        return current ? [{ record, current }] : [];
      })
      .filter((view) => {
        if (input.scopes !== null) {
          if (view.record.lifecycle !== 'accepted') return false;
          const visible = input.scopes.some(
            (scope) => scope.type === view.current.scope.type && scope.id === view.current.scope.id,
          );
          if (!visible) return false;
        }
        if (input.kind && view.current.kind !== input.kind) return false;
        if (input.lifecycle && view.record.lifecycle !== input.lifecycle) return false;
        if (input.scopeType && view.current.scope.type !== input.scopeType) return false;
        if (input.scopeId && view.current.scope.id !== input.scopeId) return false;
        if (query.length > 0 && !view.current.content.toLocaleLowerCase().includes(query)) {
          return false;
        }
        return true;
      });
    return {
      items: views.slice(input.offset, input.offset + input.limit),
      total: views.length,
    };
  }

  async createMemoryArc(input: CreateMemoryArcInput): Promise<MemoryArc> {
    const duplicate = [...this.memoryArcs.values()].some(
      (arc) =>
        arc.fromMemoryId === input.fromMemoryId &&
        arc.toMemoryId === input.toMemoryId &&
        arc.type === input.type,
    );
    if (duplicate) throw new Error('arc_duplicate');
    if (input.fromMemoryId === input.toMemoryId) throw new Error('arc_self_reference');
    if (!this.memories.has(input.fromMemoryId) || !this.memories.has(input.toMemoryId)) {
      throw new Error('memory_not_found');
    }
    const arc: MemoryArc = {
      id: `arc_${randomUUID()}`,
      fromMemoryId: input.fromMemoryId,
      toMemoryId: input.toMemoryId,
      type: input.type,
      weight: input.weight ?? null,
      lifecycle: input.lifecycle ?? 'pending_approval',
      createdAt: this.now().toISOString(),
    };
    this.memoryArcs.set(arc.id, arc);
    this.corpusRevision += 1n;
    this.enqueueOutbox(
      arc.lifecycle === 'accepted' ? 'arc.accepted' : 'arc.proposed',
      arc.id,
      undefined,
      { ...arc },
    );
    return arc;
  }

  async listMemoryArcsFrom(memoryId: string): Promise<MemoryArc[]> {
    return [...this.memoryArcs.values()].filter((arc) => arc.fromMemoryId === memoryId);
  }

  async listMemoryArcsTo(memoryId: string): Promise<MemoryArc[]> {
    return [...this.memoryArcs.values()].filter((arc) => arc.toMemoryId === memoryId);
  }

  async reviewMemoryArc(id: string, decision: 'accept' | 'reject'): Promise<MemoryArc> {
    const arc = this.memoryArcs.get(id);
    if (!arc) throw new Error('arc_not_found');
    if (arc.lifecycle !== 'pending_approval') throw new Error('arc_not_pending');
    const reviewed: MemoryArc = {
      ...arc,
      lifecycle: decision === 'accept' ? 'accepted' : 'rejected',
    };
    this.memoryArcs.set(id, reviewed);
    if (reviewed.lifecycle === 'accepted') {
      this.corpusRevision += 1n;
      this.enqueueOutbox('arc.accepted', reviewed.id, undefined, { ...reviewed });
    }
    return reviewed;
  }

  async createProjectArc(input: CreateProjectArcInput): Promise<ProjectArc> {
    const duplicate = [...this.projectArcs.values()].some(
      (arc) =>
        arc.fromProjectId === input.fromProjectId &&
        arc.toProjectId === input.toProjectId &&
        arc.type === input.type,
    );
    if (duplicate) throw new Error('arc_duplicate');
    if (input.fromProjectId === input.toProjectId) throw new Error('arc_self_reference');
    if (!this.projects.has(input.fromProjectId) || !this.projects.has(input.toProjectId)) {
      throw new Error('project_not_found');
    }
    const arc: ProjectArc = {
      id: `arc_${randomUUID()}`,
      fromProjectId: input.fromProjectId,
      toProjectId: input.toProjectId,
      type: input.type,
      weight: input.weight ?? null,
      lifecycle: input.lifecycle ?? 'pending_approval',
      createdAt: this.now().toISOString(),
    };
    this.projectArcs.set(arc.id, arc);
    this.corpusRevision += 1n;
    this.enqueueOutbox(
      arc.lifecycle === 'accepted' ? 'project_arc.accepted' : 'project_arc.proposed',
      arc.id,
      undefined,
      { ...arc },
    );
    return arc;
  }

  async listProjectArcs(projectId: string): Promise<ProjectArc[]> {
    return [...this.projectArcs.values()].filter(
      (arc) => arc.fromProjectId === projectId || arc.toProjectId === projectId,
    );
  }

  async reviewProjectArc(id: string, decision: 'accept' | 'reject'): Promise<ProjectArc> {
    const arc = this.projectArcs.get(id);
    if (!arc) throw new Error('arc_not_found');
    if (arc.lifecycle !== 'pending_approval') throw new Error('arc_not_pending');
    const reviewed: ProjectArc = {
      ...arc,
      lifecycle: decision === 'accept' ? 'accepted' : 'rejected',
    };
    this.projectArcs.set(id, reviewed);
    if (reviewed.lifecycle === 'accepted') {
      this.corpusRevision += 1n;
      this.enqueueOutbox('project_arc.accepted', reviewed.id, undefined, { ...reviewed });
    }
    return reviewed;
  }

  async listAllMemoryArcs(): Promise<MemoryArc[]> {
    return [...this.memoryArcs.values()];
  }

  async listAllProjectArcs(): Promise<ProjectArc[]> {
    return [...this.projectArcs.values()];
  }

  // Mirrors the seeded rows in schema.sql. The in-memory backend does not
  // enforce acyclicity (pre-existing parity gap, trigger only in PostgreSQL),
  // but the pruning job must still know which types are structural.
  async listHierarchicalRelationTypes(): Promise<string[]> {
    return ['sotto-progetto', 'sovraprogetto'];
  }

  async deleteMemoryArc(id: string): Promise<void> {
    if (!this.memoryArcs.delete(id)) throw new Error('arc_not_found');
    this.corpusRevision += 1n;
    this.enqueueOutbox('arc.deleted', id, undefined, { arcId: id, kind: 'memory' });
  }

  async deleteProjectArc(id: string): Promise<void> {
    if (!this.projectArcs.delete(id)) throw new Error('arc_not_found');
    this.corpusRevision += 1n;
    this.enqueueOutbox('arc.deleted', id, undefined, { arcId: id, kind: 'project' });
  }

  async createPruningProposal(input: CreatePruningProposalInput): Promise<PruningProposal> {
    const proposal: PruningProposal = {
      id: `pruning_${randomUUID()}`,
      batchId: input.batchId,
      proposer: input.proposer,
      proposalType: input.proposalType,
      sourceIds: [...input.sourceIds],
      sourceVersions: { ...input.sourceVersions },
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      rationale: input.rationale,
      confidence: input.confidence,
      scoreSnapshot: { ...input.scoreSnapshot },
      ...(input.modelVersion === undefined ? {} : { modelVersion: input.modelVersion }),
      ...(input.promptHash === undefined ? {} : { promptHash: input.promptHash }),
      status: 'pending',
      createdAt: this.now().toISOString(),
    };
    this.pruningProposals.set(proposal.id, proposal);
    return proposal;
  }

  async listPruningProposals(status?: PruningProposalStatus): Promise<PruningProposal[]> {
    const all = [...this.pruningProposals.values()];
    return status === undefined ? all : all.filter((proposal) => proposal.status === status);
  }

  async updatePruningProposalStatus(
    id: string,
    status: PruningProposalStatus,
    decisionReason: string,
  ): Promise<PruningProposal> {
    const proposal = this.pruningProposals.get(id);
    if (!proposal) throw new Error('pruning_proposal_not_found');
    const decided: PruningProposal = {
      ...proposal,
      status,
      decidedAt: this.now().toISOString(),
      decisionReason,
    };
    this.pruningProposals.set(id, decided);
    return decided;
  }

  async recordPruningLedgerEntry(input: RecordPruningLedgerInput): Promise<PruningLedgerEntry> {
    const entry: PruningLedgerEntry = {
      id: `pruning_ledger_${randomUUID()}`,
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      reason: input.reason,
      ...(input.proposalId === undefined ? {} : { proposalId: input.proposalId }),
      ...(input.score === undefined ? {} : { score: input.score }),
      ...(input.scoreComponents === undefined
        ? {}
        : { scoreComponents: { ...input.scoreComponents } }),
      decidedAt: this.now().toISOString(),
    };
    this.pruningLedger.set(entry.id, entry);
    return entry;
  }

  async listPruningLedger(): Promise<PruningLedgerEntry[]> {
    return [...this.pruningLedger.values()];
  }

  async createSession(input: OpenSessionInput): Promise<SessionRecord> {
    const session: SessionRecord = {
      id: `ses_${randomUUID()}`,
      projectId: input.projectId,
      areaIds: [...(input.areaIds ?? [])],
      taskTitle: input.taskTitle,
      sequence: 0,
      status: 'open',
      createdAt: this.now().toISOString(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  async findSession(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async closeSession(id: string): Promise<SessionRecord> {
    const session = await this.requireSession(id);
    const closed = {
      ...session,
      status: 'closed' as const,
      closedAt: this.now().toISOString(),
    };
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

  async createMemory(input: CreateMemoryInput): Promise<MemoryRecord> {
    // Project membership is identity, and PostgreSQL refuses a memory without
    // one. The in-memory backend has to refuse it too, or the deterministic
    // suite passes on a shape the real database rejects.
    if (!input.projectId) throw new Error('memory_requires_project');
    const id = `mem_${randomUUID()}`;
    const now = this.now().toISOString();
    const record: MemoryRecord = {
      id,
      projectId: input.projectId,
      currentVersion: 1,
      lifecycle: 'pending_approval',
      privacy: input.privacy ?? null,
      createdAt: now,
      updatedAt: now,
      appliedCount: 0,
      lastAppliedAt: null,
    };
    this.memories.set(id, record);
    this.revisions.set(id, new Map([[1, this.revisionFromInput(id, input)]]));
    this.revisionTimestamps.set(id, new Map([[1, now]]));
    this.corpusRevision += 1n;
    this.enqueueOutbox('memory.proposed', id);
    return record;
  }

  async getMemory(id: string): Promise<{ record: MemoryRecord; current: MemoryRevision } | null> {
    const record = this.memories.get(id);
    if (!record) return null;
    const current = this.revisions.get(id)?.get(record.currentVersion);
    return current ? { record, current } : null;
  }

  async mergeMemorySources(
    id: string,
    expectedVersion: number,
    sourceEventIds: string[],
  ): Promise<MemoryRecord> {
    const record = this.memories.get(id);
    if (!record) throw new Error('memory_not_found');
    if (record.currentVersion !== expectedVersion) throw new Error('memory_version_conflict');
    const versions = this.revisions.get(id);
    const current = versions?.get(expectedVersion);
    if (!versions || !current) throw new Error('memory_revision_not_found');
    const nextVersion = expectedVersion + 1;
    const updatedAt = this.now().toISOString();
    versions.set(nextVersion, {
      ...current,
      version: nextVersion,
      sourceEventIds: [...new Set([...current.sourceEventIds, ...sourceEventIds])],
    });
    this.revisionTimestamps.get(id)?.set(nextVersion, updatedAt);
    const updated = {
      ...record,
      currentVersion: nextVersion,
      updatedAt,
    };
    this.memories.set(id, updated);
    this.corpusRevision += 1n;
    this.enqueueOutbox('memory.sources.merged', id, nextVersion);
    return updated;
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
    if (options.allowSameVersion) {
      if (revision.version !== record.currentVersion) throw new Error('memory_version_conflict');
    } else if (record.currentVersion !== revision.version - 1) {
      throw new Error('memory_version_conflict');
    }
    const versions = this.revisions.get(id) ?? new Map<number, MemoryRevision>();
    const updatedAt = this.now().toISOString();
    versions.set(revision.version, revision);
    const timestamps = this.revisionTimestamps.get(id) ?? new Map<number, string>();
    timestamps.set(revision.version, updatedAt);
    this.revisionTimestamps.set(id, timestamps);
    this.revisions.set(id, versions);
    const updated: MemoryRecord = {
      ...record,
      currentVersion: revision.version,
      lifecycle: 'accepted',
      updatedAt,
    };
    this.memories.set(id, updated);
    this.corpusRevision += 1n;
    this.enqueueOutbox('memory.revision.created', id, revision.version);
    return updated;
  }

  async consolidateDuplicateCandidate(input: {
    canonicalId: string;
    canonicalVersion: number;
    duplicateId: string;
    duplicateVersion: number;
    sourceEventIds: string[];
  }): Promise<boolean> {
    const canonical = this.memories.get(input.canonicalId);
    const duplicate = this.memories.get(input.duplicateId);
    if (
      !canonical ||
      !duplicate ||
      canonical.currentVersion !== input.canonicalVersion ||
      duplicate.currentVersion !== input.duplicateVersion ||
      canonical.lifecycle !== 'pending_approval' ||
      duplicate.lifecycle !== 'pending_approval'
    ) {
      return false;
    }
    const versions = this.revisions.get(input.canonicalId);
    const current = versions?.get(input.canonicalVersion);
    if (!versions || !current) throw new Error('memory_revision_not_found');
    const updatedAt = this.now().toISOString();
    if (input.sourceEventIds.length > 0) {
      const nextVersion = input.canonicalVersion + 1;
      versions.set(nextVersion, {
        ...current,
        version: nextVersion,
        sourceEventIds: [...new Set([...current.sourceEventIds, ...input.sourceEventIds])],
      });
      const timestamps =
        this.revisionTimestamps.get(input.canonicalId) ?? new Map<number, string>();
      timestamps.set(nextVersion, updatedAt);
      this.revisionTimestamps.set(input.canonicalId, timestamps);
      this.memories.set(input.canonicalId, {
        ...canonical,
        currentVersion: nextVersion,
        updatedAt,
      });
      this.corpusRevision += 1n;
      this.enqueueOutbox('memory.sources.merged', input.canonicalId, nextVersion);
    }
    this.memories.set(input.duplicateId, {
      ...duplicate,
      lifecycle: 'rejected',
      updatedAt,
    });
    this.corpusRevision += 1n;
    this.enqueueOutbox('memory.rejected', input.duplicateId);
    return true;
  }

  async updateMemoryLifecycle(id: string, lifecycle: MemoryLifecycle): Promise<MemoryRecord> {
    const record = this.memories.get(id);
    if (!record) throw new Error('memory_not_found');
    const updated = { ...record, lifecycle, updatedAt: this.now().toISOString() };
    this.memories.set(id, updated);
    this.corpusRevision += 1n;
    this.enqueueOutbox(lifecycle === 'accepted' ? 'memory.accepted' : `memory.${lifecycle}`, id);
    return updated;
  }

  async incrementApplied(id: string): Promise<void> {
    const record = this.memories.get(id);
    if (!record) return;
    this.memories.set(id, {
      ...record,
      appliedCount: record.appliedCount + 1,
      lastAppliedAt: this.now().toISOString(),
    });
  }

  async removeMemory(id: string): Promise<void> {
    if (!this.memories.delete(id)) throw new Error('memory_not_found');
    const updatedConflictIds: string[] = [];
    for (const [conflictId, conflict] of this.conflicts) {
      if (!conflict.memoryIds.includes(id)) continue;
      const remainingMemoryIds = conflict.memoryIds.filter((memoryId) => memoryId !== id);
      if (remainingMemoryIds.length < 2) {
        this.conflicts.delete(conflictId);
      } else {
        this.conflicts.set(conflictId, { ...conflict, memoryIds: remainingMemoryIds });
        updatedConflictIds.push(conflictId);
      }
    }
    for (const conflictId of updatedConflictIds) {
      this.corpusRevision += 1n;
      this.enqueueOutbox('memory.conflict.updated', conflictId);
    }
    this.revisions.delete(id);
    this.revisionTimestamps.delete(id);
    this.forgetLedger.set(id, this.now().toISOString());
    this.corpusRevision += 1n;
    this.enqueueOutbox('memory.forgotten', id);
  }

  async runBalancedRetention(cutoffs: BalancedRetentionCutoffs): Promise<RetentionRunCounts> {
    const closedEvents = [...this.events.values()].filter((event) => {
      const session = this.sessions.get(event.sessionId);
      return (
        session?.status === 'closed' &&
        session.closedAt !== undefined &&
        session.closedAt < cutoffs.closedEvents
      );
    });
    for (const event of closedEvents) this.events.delete(`${event.sessionId}:${event.id}`);

    const pendingCandidates = this.memoryIdsOlderThan(
      'pending_approval',
      cutoffs.pendingCandidates,
    );
    const rejectedCandidates = this.memoryIdsOlderThan('rejected', cutoffs.rejectedCandidates);
    const retractedMemories = this.memoryIdsOlderThan('retracted', cutoffs.retractedMemories);
    const expiredMemoryIds = [...pendingCandidates, ...rejectedCandidates, ...retractedMemories];
    for (const memoryId of expiredMemoryIds) {
      this.memories.delete(memoryId);
      this.revisions.delete(memoryId);
      this.revisionTimestamps.delete(memoryId);
    }

    const conflicts = [...this.conflicts.values()].filter(
      (conflict) =>
        conflict.status === 'open' &&
        conflict.memoryIds.every(
          (memoryId) => expiredMemoryIds.includes(memoryId) && !this.forgetLedger.has(memoryId),
        ),
    );
    for (const conflict of conflicts) this.conflicts.delete(conflict.id);
    let supersededRevisions = 0;
    for (const [memoryId, revisions] of this.revisions) {
      const record = this.memories.get(memoryId);
      if (!record || !revisions.has(record.currentVersion)) continue;
      const timestamps = this.revisionTimestamps.get(memoryId);
      for (const [version, createdAt] of timestamps ?? []) {
        if (version === record.currentVersion || createdAt >= cutoffs.supersededRevisions) {
          continue;
        }
        revisions.delete(version);
        timestamps?.delete(version);
        supersededRevisions += 1;
      }
    }
    const terminalJobs = [...this.jobs.values()].filter(
      (job) =>
        ['succeeded', 'failed', 'quarantined', 'cancelled'].includes(job.status) &&
        job.updatedAt < cutoffs.terminalJobs,
    );
    for (const job of terminalJobs) {
      this.jobs.delete(job.id);
      this.jobAttempts.delete(job.id);
    }

    if (closedEvents.length + expiredMemoryIds.length + supersededRevisions > 0) {
      this.corpusRevision += 1n;
    }
    return {
      closedSessionEvents: closedEvents.length,
      pendingCandidates: pendingCandidates.length,
      rejectedCandidates: rejectedCandidates.length,
      supersededRevisions,
      retractedMemories: retractedMemories.length,
      conflicts: conflicts.length,
      // Already zero here: this backend removes rows in markOutboxProcessed
      // rather than marking them, so there is nothing left for retention to
      // prune. The PostgreSQL backend keeps them and prunes on this window,
      // which is why the leak was invisible to every in-memory test.
      processedOutboxEvents: 0,
      terminalJobs: terminalJobs.length,
      // The in-memory idempotency store is an ephemeral Map that does not
      // persist across runs or record timestamps.
      expiredIdempotencyKeys: 0,
    };
  }

  async listCurrentMemories(): Promise<MemoryRevision[]> {
    return [...this.memories.values()]
      .filter((memory) => memory.lifecycle === 'accepted')
      .map((memory) => this.revisions.get(memory.id)?.get(memory.currentVersion))
      .filter((revision): revision is MemoryRevision => revision !== undefined);
  }

  async listAllEvents(): Promise<EventRecord[]> {
    return [...this.events.values()].sort(
      (left, right) =>
        left.sessionId.localeCompare(right.sessionId) || left.sequence - right.sequence,
    );
  }

  async listAllMemoryRevisions(): Promise<Array<{ memoryId: string; revision: MemoryRevision }>> {
    return [...this.revisions.entries()].flatMap(([memoryId, revisions]) =>
      [...revisions.values()].map((revision) => ({ memoryId, revision })),
    );
  }

  async listForgetLedger(): Promise<Array<{ memoryId: string; forgottenAt: string }>> {
    return [...this.forgetLedger.entries()].map(([memoryId, forgottenAt]) => ({
      memoryId,
      forgottenAt,
    }));
  }

  async listAllJobs(): Promise<JobRecord[]> {
    return [...this.jobs.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  async listAllJobAttempts(): Promise<JobAttemptRecord[]> {
    return [...this.jobAttempts.values()].flatMap((attempts) =>
      attempts.map((attempt) => ({ ...attempt })),
    );
  }

  async listPendingMemories(): Promise<MemoryRecord[]> {
    return [...this.memories.values()]
      .filter((memory) => memory.lifecycle === 'pending_approval')
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async listMemoryViews(): Promise<MemoryWithCurrent[]> {
    return [...this.memories.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .flatMap((record) => {
        const current = this.revisions.get(record.id)?.get(record.currentVersion);
        return current ? [{ record, current }] : [];
      });
  }

  async listRevisions(id: string): Promise<MemoryRevision[]> {
    return [...(this.revisions.get(id)?.values() ?? [])].sort(
      (left, right) => right.version - left.version,
    );
  }

  async findConflicts(memoryId: string): Promise<ConflictRecord[]> {
    return [...this.conflicts.values()].filter((conflict) => conflict.memoryIds.includes(memoryId));
  }

  async getConflict(id: string): Promise<ConflictRecord | null> {
    return this.conflicts.get(id) ?? null;
  }

  async listAllConflicts(): Promise<ConflictRecord[]> {
    return [...this.conflicts.values()];
  }

  async createConflict(
    memoryIds: string[],
    type: ConflictRecord['type'] = 'direct_contradiction',
  ): Promise<ConflictRecord> {
    const uniqueMemoryIds = [...new Set(memoryIds)];
    if (uniqueMemoryIds.length < 2) throw new Error('conflict_requires_two_memories');
    const existing = [...this.conflicts.values()].find(
      (conflict) =>
        conflict.status === 'open' &&
        conflict.type === type &&
        conflict.memoryIds.length === uniqueMemoryIds.length &&
        uniqueMemoryIds.every((memoryId) => conflict.memoryIds.includes(memoryId)),
    );
    if (existing) {
      this.corpusRevision += 1n;
      this.enqueueOutbox('memory.conflict.created', existing.id);
      return existing;
    }
    const conflict: ConflictRecord = {
      id: `conf_${randomUUID()}`,
      type,
      memoryIds: uniqueMemoryIds,
      status: 'open',
    };
    this.conflicts.set(conflict.id, conflict);
    this.corpusRevision += 1n;
    this.enqueueOutbox('memory.conflict.created', conflict.id);
    return conflict;
  }

  async resolveConflict(id: string): Promise<ConflictRecord> {
    const conflict = this.conflicts.get(id);
    if (!conflict) throw new Error('conflict_not_found');
    const resolved = { ...conflict, status: 'resolved' as const };
    this.conflicts.set(id, resolved);
    this.corpusRevision += 1n;
    this.enqueueOutbox('memory.conflict.resolved', id);
    return resolved;
  }

  async createJob(job: Omit<JobRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<JobRecord> {
    const createdAt = this.now().toISOString();
    const record: JobRecord = {
      ...job,
      id: `job_${randomUUID()}`,
      createdAt,
      updatedAt: createdAt,
    };
    this.jobs.set(record.id, record);
    return record;
  }

  async getJob(id: string): Promise<JobRecord | null> {
    return this.jobs.get(id) ?? null;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return [...this.sessions.values()].sort((left, right) =>
      right.createdAt.localeCompare(left.createdAt),
    );
  }

  async listEvents(sessionId: string): Promise<EventRecord[]> {
    return this.findEvents(sessionId);
  }

  async listJobs(sessionId?: string): Promise<JobRecord[]> {
    return [...this.jobs.values()]
      .filter((job) => !sessionId || job.sessionId === sessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async listJobAttempts(jobId: string): Promise<ListJobAttemptsOutput> {
    return { items: this.jobAttempts.get(jobId) ?? [] };
  }

  async claimNextJob(workerId: string, leaseMs: number): Promise<JobRecord | null> {
    const now = this.now();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs).toISOString();
    const candidates = [...this.jobs.values()]
      .filter(
        (value) =>
          value.status === 'running' &&
          value.leaseExpiresAt !== undefined &&
          value.leaseExpiresAt <= now.toISOString(),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    for (const expired of candidates.filter((value) => value.status === 'running')) {
      const attempts = this.jobAttempts.get(expired.id) ?? [];
      for (const [index, attempt] of attempts.entries()) {
        if (attempt.status !== 'running') continue;
        attempts[index] = {
          ...attempt,
          status: 'failed',
          errorCode: 'lease_expired',
          updatedAt: now.toISOString(),
        };
      }
      this.jobAttempts.set(expired.id, attempts);
      this.jobs.set(expired.id, {
        ...expired,
        status: 'queued',
        availableAt: now.toISOString(),
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        updatedAt: now.toISOString(),
      });
    }
    const job = [...this.jobs.values()]
      .filter(
        (value) =>
          value.status === 'queued' &&
          (value.availableAt === undefined || value.availableAt <= now.toISOString()),
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
    if (!job) return null;
    const running = {
      ...job,
      status: 'running' as const,
      availableAt: undefined,
      leaseOwner: workerId,
      leaseExpiresAt,
      updatedAt: now.toISOString(),
    };
    this.jobs.set(job.id, running);
    return running;
  }

  async renewJobLease(id: string, workerId: string, leaseMs: number): Promise<JobRecord> {
    const job = this.jobs.get(id);
    if (!job) throw new Error('job_not_found');
    if (job.status !== 'running' || job.leaseOwner !== workerId) {
      throw new Error('job_lease_lost');
    }
    const updated = {
      ...job,
      leaseExpiresAt: new Date(this.now().getTime() + leaseMs).toISOString(),
      updatedAt: this.now().toISOString(),
    };
    this.jobs.set(id, updated);
    return updated;
  }

  async updateJob(id: string, status: JobRecord['status'], workerId: string): Promise<JobRecord> {
    const job = this.jobs.get(id);
    if (!job) throw new Error('job_not_found');
    if (job.status !== 'running' || job.leaseOwner !== workerId) {
      throw new Error('job_lease_lost');
    }
    const updated = {
      ...job,
      status,
      availableAt: undefined,
      leaseOwner: status === 'running' ? workerId : undefined,
      leaseExpiresAt: status === 'running' ? job.leaseExpiresAt : undefined,
      updatedAt: this.now().toISOString(),
    };
    this.jobs.set(id, updated);
    return updated;
  }

  async retryJob(id: string, workerId: string, availableAt: string): Promise<JobRecord> {
    const job = this.jobs.get(id);
    if (!job) throw new Error('job_not_found');
    if (job.status !== 'running' || job.leaseOwner !== workerId) {
      throw new Error('job_lease_lost');
    }
    const updated = {
      ...job,
      status: 'queued' as const,
      availableAt,
      leaseOwner: undefined,
      leaseExpiresAt: undefined,
      updatedAt: this.now().toISOString(),
    };
    this.jobs.set(id, updated);
    return updated;
  }

  async createJobAttempt(
    attempt: Omit<JobAttemptRecord, 'id' | 'workerId' | 'createdAt' | 'updatedAt'>,
    workerId: string,
  ): Promise<JobAttemptRecord> {
    const now = this.now().toISOString();
    const job = this.jobs.get(attempt.jobId);
    if (!job || job.status !== 'running' || job.leaseOwner !== workerId) {
      throw new Error('job_lease_lost');
    }
    const record: JobAttemptRecord = {
      ...attempt,
      id: `attempt_${createRandomId()}`,
      workerId,
      createdAt: now,
      updatedAt: now,
    };
    const attempts = this.jobAttempts.get(attempt.jobId) ?? [];
    if (attempts.some((value) => value.attempt === attempt.attempt)) {
      throw new Error('job_attempt_already_exists');
    }
    attempts.push(record);
    this.jobAttempts.set(attempt.jobId, attempts);
    return record;
  }

  async finishJobAttempt(
    id: string,
    status: JobAttemptRecord['status'],
    workerId: string,
    errorCode?: string,
  ): Promise<JobAttemptRecord> {
    for (const [jobId, attempts] of this.jobAttempts) {
      const index = attempts.findIndex((attempt) => attempt.id === id);
      if (index < 0) continue;
      if (attempts[index]?.status !== 'running') throw new Error('job_attempt_not_running');
      const job = this.jobs.get(jobId);
      if (!job || job.status !== 'running' || job.leaseOwner !== workerId) {
        throw new Error('job_lease_lost');
      }
      const updated = {
        ...attempts[index],
        status,
        errorCode: errorCode ?? attempts[index].errorCode,
        updatedAt: this.now().toISOString(),
      };
      attempts[index] = updated;
      this.jobAttempts.set(jobId, attempts);
      return updated;
    }
    throw new Error('job_attempt_not_found');
  }

  async getCorpusRevision(): Promise<CorpusRevision> {
    return { id: this.corpusId, epoch: this.corpusEpoch, revision: this.corpusRevision };
  }

  async getRetentionState(): Promise<RetentionState> {
    return { ...this.retentionState };
  }

  async recordRetentionRun(lastRunAt: string): Promise<void> {
    this.retentionState = { lastRunAt };
  }

  async claimOutboxEvents(
    limit: number,
    consumerId: string,
    leaseMs: number,
  ): Promise<OutboxClaim | null> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new Error('outbox_batch_size_invalid');
    }
    if (consumerId.trim().length === 0) throw new Error('outbox_consumer_id_required');
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) {
      throw new Error('outbox_lease_invalid');
    }
    const now = this.now().getTime();
    const events = this.outbox
      .filter((event) => {
        const claim = this.outboxClaims.get(event.id);
        return claim === undefined || claim.expiresAt <= now;
      })
      .slice(0, limit);
    if (events.length === 0) return null;
    const token = randomUUID();
    const expiresAt = now + leaseMs;
    for (const event of events) {
      this.outboxClaims.set(event.id, { token, consumerId, expiresAt });
    }
    return {
      token,
      consumerId,
      events: events.map((event) => ({ ...event, payload: { ...event.payload } })),
    };
  }

  async markOutboxProcessed(claim: OutboxClaim): Promise<void> {
    for (const event of claim.events) {
      const current = this.outboxClaims.get(event.id);
      if (current?.token !== claim.token || current.consumerId !== claim.consumerId) {
        throw new Error('outbox_claim_lost');
      }
    }
    const processed = new Set(claim.events.map((event) => event.id));
    this.outbox = this.outbox.filter((event) => !processed.has(event.id));
    for (const id of processed) this.outboxClaims.delete(id);
  }

  async createFeedback(
    input: MemoryFeedbackInput & { id: string; createdAt: string },
  ): Promise<MemoryFeedbackOutput> {
    const record: MemoryFeedbackOutput = { ...input };
    this.feedback.set(input.memoryId, [...(this.feedback.get(input.memoryId) ?? []), record]);
    return record;
  }

  async listFeedback(memoryId: string): Promise<MemoryFeedbackOutput[]> {
    return [...(this.feedback.get(memoryId) ?? [])];
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

  private memoryIdsOlderThan(lifecycle: MemoryLifecycle, cutoff: string): string[] {
    return [...this.memories.values()]
      .filter((memory) => memory.lifecycle === lifecycle && memory.updatedAt < cutoff)
      .map((memory) => memory.id);
  }

  private enqueueOutbox(
    eventType: string,
    aggregateId: string,
    version?: number,
    payload?: Record<string, unknown>,
  ): void {
    this.outbox.push({
      id: this.nextOutboxId++,
      eventType,
      aggregateId,
      storeRevision: this.corpusRevision,
      payload:
        payload ??
        (version === undefined ? { memoryId: aggregateId } : { memoryId: aggregateId, version }),
    });
  }
}
