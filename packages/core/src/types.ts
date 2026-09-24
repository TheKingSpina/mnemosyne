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
  ConflictType,
  CorrectMemoryInput,
  CorrectMemoryOutput,
  ListAdminMemoriesInput,
  ListAdminJobsInput,
  ListAdminSessionsInput,
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
  ProposeMemoryInput,
  RecordEventsInput,
  RecordEventsOutput,
  ReviewProposalInput,
  ReviewProposalOutput,
  Scope,
  SearchMemoriesInput,
} from '@mnemosyne/contracts';

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
  currentVersion: number;
  lifecycle: MemoryLifecycle;
  createdAt: string;
  updatedAt: string;
}

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
  openSession(input: OpenSessionInput): Promise<OpenSessionOutput>;
  recordEvents(input: RecordEventsInput): Promise<RecordEventsOutput>;
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
  listScopesForSession(sessionId: string): Promise<Scope[]>;
  getCorpusRevision(): Promise<string>;
}

export interface MemoryRepository {
  createSession(input: OpenSessionInput): Promise<SessionRecord>;
  findSession(id: string): Promise<SessionRecord | null>;
  closeSession(id: string): Promise<SessionRecord>;
  appendEvents(input: RecordEventsInput): Promise<{
    accepted: EventRecord[];
    duplicates: EventRecord[];
  }>;
  findEvents(sessionId: string): Promise<EventRecord[]>;
  createMemory(input: ProposeMemoryInput): Promise<MemoryRecord>;
  getMemory(id: string): Promise<MemoryWithCurrent | null>;
  mergeMemorySources(
    id: string,
    expectedVersion: number,
    sourceEventIds: string[],
  ): Promise<MemoryRecord>;
  createRevision(input: CorrectMemoryInput): Promise<MemoryRecord>;
  updateMemoryRevision(id: string, revision: MemoryRevision): Promise<MemoryRecord>;
  updateMemoryLifecycle(id: string, lifecycle: MemoryLifecycle): Promise<MemoryRecord>;
  removeMemory(id: string): Promise<void>;
  listCurrentMemories(): Promise<MemoryRevision[]>;
  listPendingMemories(): Promise<MemoryRecord[]>;
  listMemoryViews(): Promise<MemoryWithCurrent[]>;
  listRevisions(id: string): Promise<MemoryRevision[]>;
  findConflicts(memoryId: string): Promise<ConflictRecord[]>;
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
  getCorpusRevision(): Promise<CorpusRevision>;
}
