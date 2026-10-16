import type {
  ContextInput,
  ContextOutput,
  AdminJobsOutput,
  AdminSessionDetailOutput,
  AdminSessionsOutput,
  JobAttemptView,
  ListJobAttemptsOutput,
  AdminMemoriesOutput,
  AdminOverviewOutput,
  AdminCapabilitiesOutput,
  ConflictListOutput,
  CorpusExport,
  CorpusRestoreResult,
  ConflictType,
  CorrectMemoryInput,
  CorrectMemoryOutput,
  ListAdminMemoriesInput,
  ListAdminJobsInput,
  ListAdminSessionsInput,
  ListMemoryFeedbackOutput,
  MemoryFeedbackInput,
  MemoryFeedbackOutput,
  MemoryActor,
  MemoryLifecycle,
  MemoryRevision,
  MemoryView,
  MemoryAdminView,
  ListPendingProposalsInput,
  OpenSessionInput,
  OpenSessionOutput,
  PendingProposalsOutput,
  PrepareForgetOutput,
  ProposalResult,
  PruningAnalysisOutput,
  ProposeMemoryInput,
  RecordEventsInput,
  RecordEventsOutput,
  ReviewProposalInput,
  ReviewProposalOutput,
  RetentionRunOutput,
  RetentionStatusOutput,
  PrivacyFlag,
  Scope,
  SearchMemoriesInput,
  SessionConsolidationOutput,
  WorkerRuntimeCapabilities,
  RetrievalTelemetry,
  EmbeddingIndexHealthOutput,
  EmbeddingReindexOutput,
} from '@mnemosyne/contracts';

export type { MemoryFeedbackInput, MemoryFeedbackOutput } from '@mnemosyne/contracts';
export type { PrivacyFlag } from '@mnemosyne/contracts';
import type { PruningAnalyzer } from './pruning-analyzer.js';

export interface SessionRecord {
  id: string;
  projectId: string;
  areaIds: string[];
  taskTitle?: string;
  sequence: number;
  status: 'open' | 'closed';
  createdAt: string;
  closedAt?: string;
}

// Projects are the graph roots. `name` carries the uniqueness constraint rather
// than the identifier, so renaming stays an ordinary update and a project
// remains addressable by name. The database enforces uniqueness both exactly
// and case-insensitively.
export interface ProjectRecord {
  id: string;
  name: string;
  description?: string;
  // Manual marking by the owner at creation; default local_only. Never inferred.
  privacy: PrivacyFlag;
  createdAt: string;
  updatedAt: string;
}

// Areas are the optional subgraph roots inside a project. They are declared,
// never inferred: the project decides which areas exist.
export interface AreaRecord {
  id: string;
  projectId: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateProjectInput {
  id: string;
  name: string;
  description?: string;
  privacy?: PrivacyFlag;
}

export interface CreateAreaInput {
  id: string;
  projectId: string;
  name: string;
}

// The project that replaces scope type `global`: memories in it are visible
// from every session. Seeded by schema.sql, so it exists without being created.
export const RESERVED_PERSONAL_PROJECT_ID = 'personal';

export interface EventRecord {
  id: string;
  sessionId: string;
  sequence: number;
  type: 'message';
  role: 'user' | 'assistant' | 'tool';
  content: string;
  occurredAt: string;
  explicitMemoryRequest: boolean;
}

export interface MemoryRecord {
  id: string;
  // Identity, not content: a memory never changes project. The database enforces
  // it with a trigger, so this is read-only after creation.
  projectId: string;
  currentVersion: number;
  lifecycle: MemoryLifecycle;
  // Per-node override; null inherits the project flag.
  privacy: PrivacyFlag | null;
  createdAt: string;
  updatedAt: string;
}

export type ArcLifecycle = 'pending_approval' | 'accepted' | 'rejected' | 'retracted';

// Arcs are governed like memories, so they carry the same lifecycle. Weight is
// nullable because "these are related" is a legitimate claim without one.
export interface MemoryArc {
  id: string;
  fromMemoryId: string;
  toMemoryId: string;
  type: string;
  weight: number | null;
  lifecycle: ArcLifecycle;
  createdAt: string;
}

export interface ProjectArc {
  id: string;
  fromProjectId: string;
  toProjectId: string;
  type: string;
  weight: number | null;
  lifecycle: ArcLifecycle;
  createdAt: string;
}

export interface CreateMemoryArcInput {
  fromMemoryId: string;
  toMemoryId: string;
  type: string;
  weight?: number;
  lifecycle?: ArcLifecycle;
}

export type PruningProposer = 'deterministic' | 'llm';
export type PruningProposalType = 'decay' | 'edge' | 'redundancy' | 'contradiction' | 'merge';
export type PruningProposalStatus = 'pending' | 'accepted' | 'rejected' | 'stale';

export interface PruningProposal {
  id: string;
  batchId: string;
  proposer: PruningProposer;
  proposalType: PruningProposalType;
  sourceIds: string[];
  // Versions (memories) or weights (arcs) read when proposing: the decide step
  // re-reads them, and anything that moved makes the proposal stale.
  sourceVersions: Record<string, number | string>;
  targetId?: string;
  rationale: string;
  confidence: number;
  scoreSnapshot: Record<string, number>;
  modelVersion?: string;
  promptHash?: string;
  status: PruningProposalStatus;
  decidedAt?: string;
  decisionReason?: string;
  createdAt: string;
}

export interface CreatePruningProposalInput {
  batchId: string;
  proposer: PruningProposer;
  proposalType: PruningProposalType;
  sourceIds: string[];
  sourceVersions: Record<string, number | string>;
  targetId?: string;
  rationale: string;
  confidence: number;
  scoreSnapshot: Record<string, number>;
  modelVersion?: string;
  promptHash?: string;
}

export type PruningSubjectType = 'memory' | 'arc';
export type PruningReason = 'decay' | 'edge_weight' | 'llm_proposal' | 'manual';

export interface PruningLedgerEntry {
  id: string;
  subjectType: PruningSubjectType;
  subjectId: string;
  reason: PruningReason;
  proposalId?: string;
  score?: number;
  scoreComponents?: Record<string, number>;
  decidedAt: string;
}

export interface RecordPruningLedgerInput {
  subjectType: PruningSubjectType;
  subjectId: string;
  reason: PruningReason;
  proposalId?: string;
  score?: number;
  scoreComponents?: Record<string, number>;
}

export interface CreateProjectArcInput {
  fromProjectId: string;
  toProjectId: string;
  type: string;
  weight?: number;
  lifecycle?: ArcLifecycle;
}

// An arc proposal reports the arc it created, whichever kind it is. The two
// shapes are a union rather than one shape with nullable halves because an arc
// always has exactly one kind of endpoints.
export type ProposalArcResult =
  | {
      status: 'accepted' | 'pending_approval';
      arcId: string;
      fromMemoryId: string;
      toMemoryId: string;
      type: string;
      weight: number | null;
      lifecycle: ArcLifecycle;
    }
  | {
      status: 'accepted' | 'pending_approval';
      arcId: string;
      fromProjectId: string;
      toProjectId: string;
      type: string;
      weight: number | null;
      lifecycle: ArcLifecycle;
    };

// A proposal resolves to exactly one root project. `proposeMemory` derives it from
// the session, so callers cannot name a project the scope does not sit in.
export type CreateMemoryInput = ProposeMemoryInput & { projectId: string };

export interface MemoryWithCurrent {
  record: MemoryRecord;
  current: MemoryRevision;
}

export interface ConflictRecord {
  id: string;
  type: ConflictType;
  memoryIds: string[];
  status: 'open' | 'resolved';
}

export interface CorpusRevision {
  id: string;
  epoch: string;
  revision: bigint;
}

export interface JobRecord {
  id: string;
  operation: 'session_consolidation' | 'memory_extraction';
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'quarantined' | 'cancelled';
  sessionId: string;
  availableAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface JobAttemptRecord extends JobAttemptView {
  jobId: string;
}

export interface ProposalContext {
  actor: MemoryActor;
  explicitDirective: boolean;
}

export interface MemoryService {
  getAdminCapabilities(): Promise<AdminCapabilitiesOutput>;
  getRetrievalTelemetry(): RetrievalTelemetry;
  getEmbeddingIndexHealth(): Promise<EmbeddingIndexHealthOutput>;
  reindexEmbeddings(): Promise<EmbeddingReindexOutput>;
  listCorpusExport(): Promise<CorpusExport>;
  restoreCorpus(input: CorpusExport): Promise<CorpusRestoreResult>;
  submitFeedback(input: MemoryFeedbackInput): Promise<MemoryFeedbackOutput>;
  listFeedback(memoryId: string): Promise<ListMemoryFeedbackOutput>;
  openSession(input: OpenSessionInput): Promise<OpenSessionOutput>;
  recordEvents(input: RecordEventsInput): Promise<RecordEventsOutput>;
  assertSessionAccessible(sessionId: string): Promise<void>;
  proposeMemoryArc(
    input: CreateMemoryArcInput,
    context?: ProposalContext,
  ): Promise<ProposalArcResult>;
  reviewMemoryArc(arcId: string, decision: 'accept' | 'reject'): Promise<MemoryArc>;
  proposeProjectArc(
    input: CreateProjectArcInput,
    context?: ProposalContext,
  ): Promise<ProposalArcResult>;
  reviewProjectArc(arcId: string, decision: 'accept' | 'reject'): Promise<ProjectArc>;
  listMemoryArcs(memoryId: string): Promise<{ from: MemoryArc[]; to: MemoryArc[] }>;
  listAllArcs(): Promise<{ memoryArcs: MemoryArc[]; projectArcs: ProjectArc[] }>;
  listProjects(): Promise<ProjectRecord[]>;
  setProjectPrivacy(projectId: string, privacy: PrivacyFlag): Promise<ProjectRecord>;
  runPruningAnalysis(analyzer?: PruningAnalyzer): Promise<PruningAnalysisOutput>;
  listProjectArcs(projectId: string): Promise<ProjectArc[]>;
  proposeMemory(input: ProposeMemoryInput, context?: ProposalContext): Promise<ProposalResult>;
  searchMemories(input: SearchMemoriesInput): Promise<MemoryRevision[]>;
  resolveContext(input: ContextInput): Promise<ContextOutput>;
  closeSession(sessionId: string): Promise<{ jobId: string }>;
  getMemory(id: string): Promise<MemoryRevision | null>;
  reviewProposal(input: ReviewProposalInput): Promise<ReviewProposalOutput>;
  correctMemory(input: CorrectMemoryInput): Promise<CorrectMemoryOutput>;
  retractMemory(memoryId: string, reason: string): Promise<MemoryView>;
  prepareForget(memoryId: string): Promise<PrepareForgetOutput>;
  forgetMemory(memoryId: string, confirmationToken: string): Promise<void>;
  getJob(id: string): Promise<JobRecord | null>;
  listPendingProposals(input: ListPendingProposalsInput): Promise<PendingProposalsOutput>;
  listAdminMemories(input: ListAdminMemoriesInput): Promise<AdminMemoriesOutput>;
  getMemoryAdminView(id: string): Promise<MemoryAdminView | null>;
  listConflicts(): Promise<ConflictListOutput>;
  resolveConflict(id: string): Promise<ConflictRecord>;
  getAdminOverview(): Promise<AdminOverviewOutput>;
  listAdminSessions(input: ListAdminSessionsInput): Promise<AdminSessionsOutput>;
  getAdminSessionDetail(sessionId: string): Promise<AdminSessionDetailOutput>;
  listAdminJobs(input: ListAdminJobsInput): Promise<AdminJobsOutput>;
  listJobAttempts(jobId: string): Promise<ListJobAttemptsOutput>;
  getRetentionStatus(): Promise<RetentionStatusOutput>;
  runRetention(): Promise<RetentionRunOutput>;
  consolidateSession(sessionId: string): Promise<SessionConsolidationOutput>;
  listScopesForSession(sessionId: string): Promise<Scope[]>;
  getCorpusRevision(): Promise<string>;
}

export interface RuntimeCapabilityReport {
  component: string;
  capabilities: WorkerRuntimeCapabilities;
  reportedAt: string;
}

export interface MemoryRepository {
  reportRuntimeCapabilities(
    component: string,
    capabilities: WorkerRuntimeCapabilities,
    reportedAt: string,
  ): Promise<void>;
  readRuntimeCapabilities(component: string): Promise<RuntimeCapabilityReport | null>;
  countMemories(): Promise<number>;
  restoreCorpus(input: CorpusRestore): Promise<CorpusRestoreCounts>;
  // Projects and areas back the graph roots. `ensureProject` exists because
  // `openSession` is the entry point of the whole system and its callers pass a
  // free-form project id: creating the project on first use keeps that contract
  // while making the reference real. It must be race-safe, because two sessions
  // can open on the same new project at once.
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;
  ensureProject(id: string): Promise<ProjectRecord>;
  findProjectById(id: string): Promise<ProjectRecord | null>;
  // Manual marking by the owner. Projects are otherwise provisioned silently,
  // so without this there would be no path from default local_only outward.
  updateProjectPrivacy(id: string, privacy: PrivacyFlag): Promise<ProjectRecord>;
  findProjectByName(name: string): Promise<ProjectRecord | null>;
  listProjects(): Promise<ProjectRecord[]>;
  createArea(input: CreateAreaInput): Promise<AreaRecord>;
  findAreaById(id: string): Promise<AreaRecord | null>;
  listAreas(projectId: string): Promise<AreaRecord[]>;
  // Arcs are governed rows, not graph internals. A client proposes them and the
  // owner accepts, exactly like a memory; only accepted arcs reach Neo4j.
  createMemoryArc(input: CreateMemoryArcInput): Promise<MemoryArc>;
  listMemoryArcsFrom(memoryId: string): Promise<MemoryArc[]>;
  listMemoryArcsTo(memoryId: string): Promise<MemoryArc[]>;
  reviewMemoryArc(id: string, decision: 'accept' | 'reject'): Promise<MemoryArc>;
  createProjectArc(input: CreateProjectArcInput): Promise<ProjectArc>;
  listProjectArcs(projectId: string): Promise<ProjectArc[]>;
  reviewProjectArc(id: string, decision: 'accept' | 'reject'): Promise<ProjectArc>;
  listAllMemoryArcs(): Promise<MemoryArc[]>;
  listAllProjectArcs(): Promise<ProjectArc[]>;
  listHierarchicalRelationTypes(): Promise<string[]>;
  deleteMemoryArc(id: string): Promise<void>;
  deleteProjectArc(id: string): Promise<void>;
  // Pruning proposals and their ledger are working state, not corpus content:
  // they reference live rows, so they are deliberately absent from the export.
  createPruningProposal(input: CreatePruningProposalInput): Promise<PruningProposal>;
  listPruningProposals(status?: PruningProposalStatus): Promise<PruningProposal[]>;
  updatePruningProposalStatus(
    id: string,
    status: PruningProposalStatus,
    decisionReason: string,
  ): Promise<PruningProposal>;
  recordPruningLedgerEntry(input: RecordPruningLedgerInput): Promise<PruningLedgerEntry>;
  listPruningLedger(): Promise<PruningLedgerEntry[]>;
  createSession(input: OpenSessionInput): Promise<SessionRecord>;
  findSession(id: string): Promise<SessionRecord | null>;
  closeSession(id: string): Promise<SessionRecord>;
  appendEvents(input: RecordEventsInput): Promise<{
    accepted: EventRecord[];
    duplicates: EventRecord[];
  }>;
  findEvents(sessionId: string): Promise<EventRecord[]>;
  createMemory(input: CreateMemoryInput): Promise<MemoryRecord>;
  getMemory(id: string): Promise<MemoryWithCurrent | null>;
  mergeMemorySources(
    id: string,
    expectedVersion: number,
    sourceEventIds: string[],
  ): Promise<MemoryRecord>;
  createRevision(input: CorrectMemoryInput): Promise<MemoryRecord>;
  updateMemoryRevision(
    id: string,
    revision: MemoryRevision,
    options?: { allowSameVersion?: boolean },
  ): Promise<MemoryRecord>;
  consolidateDuplicateCandidate(input: {
    canonicalId: string;
    canonicalVersion: number;
    duplicateId: string;
    duplicateVersion: number;
    sourceEventIds: string[];
  }): Promise<boolean>;
  updateMemoryLifecycle(id: string, lifecycle: MemoryLifecycle): Promise<MemoryRecord>;
  removeMemory(id: string): Promise<void>;
  runBalancedRetention(cutoffs: BalancedRetentionCutoffs): Promise<RetentionRunCounts>;
  listCurrentMemories(): Promise<MemoryRevision[]>;
  searchCurrentMemories?(input: {
    query: string;
    limit: number;
    scopes: Scope[];
  }): Promise<MemoryRevision[]>;
  getCurrentMemoriesByIds?(ids: string[]): Promise<MemoryRevision[]>;
  listAllEvents(): Promise<EventRecord[]>;
  listAllMemoryRevisions(): Promise<Array<{ memoryId: string; revision: MemoryRevision }>>;
  listForgetLedger(): Promise<Array<{ memoryId: string; forgottenAt: string }>>;
  listAllJobs(): Promise<JobRecord[]>;
  listAllJobAttempts(): Promise<JobAttemptRecord[]>;
  listPendingMemories(): Promise<MemoryRecord[]>;
  listMemoryViews(): Promise<MemoryWithCurrent[]>;
  listRevisions(id: string): Promise<MemoryRevision[]>;
  findConflicts(memoryId: string): Promise<ConflictRecord[]>;
  getConflict(id: string): Promise<ConflictRecord | null>;
  listAllConflicts(): Promise<ConflictRecord[]>;
  createConflict(memoryIds: string[], type?: ConflictRecord['type']): Promise<ConflictRecord>;
  resolveConflict(id: string): Promise<ConflictRecord>;
  listSessions(): Promise<SessionRecord[]>;
  listEvents(sessionId: string): Promise<EventRecord[]>;
  listJobs(sessionId?: string): Promise<JobRecord[]>;
  listJobAttempts(jobId: string): Promise<ListJobAttemptsOutput>;
  claimNextJob(workerId: string, leaseMs: number): Promise<JobRecord | null>;
  renewJobLease(id: string, workerId: string, leaseMs: number): Promise<JobRecord>;
  updateJob(id: string, status: JobRecord['status'], workerId: string): Promise<JobRecord>;
  retryJob(id: string, workerId: string, availableAt: string): Promise<JobRecord>;
  createJobAttempt(
    attempt: Omit<JobAttemptRecord, 'id' | 'workerId' | 'createdAt' | 'updatedAt'>,
    workerId: string,
  ): Promise<JobAttemptRecord>;
  finishJobAttempt(
    id: string,
    status: JobAttemptRecord['status'],
    workerId: string,
    errorCode?: string,
  ): Promise<JobAttemptRecord>;
  createJob(job: Omit<JobRecord, 'id' | 'createdAt' | 'updatedAt'>): Promise<JobRecord>;
  getJob(id: string): Promise<JobRecord | null>;
  getRetentionState(): Promise<RetentionState>;
  recordRetentionRun(lastRunAt: string): Promise<void>;
  claimOutboxEvents(
    limit: number,
    consumerId: string,
    leaseMs: number,
  ): Promise<OutboxClaim | null>;
  markOutboxProcessed(claim: OutboxClaim): Promise<void>;
  createFeedback(
    input: MemoryFeedbackInput & { id: string; createdAt: string },
  ): Promise<MemoryFeedbackOutput>;
  listFeedback(memoryId: string): Promise<MemoryFeedbackOutput[]>;
  getCorpusRevision(): Promise<CorpusRevision>;
}

export interface BalancedRetentionCutoffs {
  closedEvents: string;
  pendingCandidates: string;
  rejectedCandidates: string;
  supersededRevisions: string;
  retractedMemories: string;
  processedOutboxEvents: string;
}

export interface RetentionRunCounts {
  closedSessionEvents: number;
  pendingCandidates: number;
  rejectedCandidates: number;
  supersededRevisions: number;
  retractedMemories: number;
  conflicts: number;
  processedOutboxEvents: number;
}

export interface RetentionState {
  lastRunAt?: string;
}

export interface OutboxEvent {
  id: number;
  eventType: string;
  aggregateId: string;
  storeRevision: bigint;
  payload: Record<string, unknown>;
}

export interface OutboxClaim {
  token: string;
  consumerId: string;
  events: OutboxEvent[];
}

export interface CorpusRestore {
  sourceCorpusRevision: string;
  sessions: CorpusExport['sessions'];
  projects: CorpusExport['projects'];
  areas: CorpusExport['areas'];
  events: CorpusExport['events'];
  memories: CorpusExport['memories'];
  revisions: CorpusExport['revisions'];
  conflicts: CorpusExport['conflicts'];
  jobs: CorpusExport['jobs'];
  jobAttempts: CorpusExport['jobAttempts'];
  forgetLedger: CorpusExport['forgetLedger'];
  memoryArcs: CorpusExport['memoryArcs'];
  projectArcs: CorpusExport['projectArcs'];
}

export interface CorpusRestoreCounts {
  restored: {
    sessions: number;
    events: number;
    memories: number;
    revisions: number;
    conflicts: number;
    jobs: number;
    jobAttempts: number;
    forgetLedger: number;
  };
  skipped: {
    forgottenMemories: number;
    forgottenRevisions: number;
    forgottenConflicts: number;
  };
}
