import type {
  ContextInput,
  ContextOutput,
  CorrectMemoryInput,
  CorrectMemoryOutput,
  MemoryActor,
  MemoryLifecycle,
  MemoryRevision,
  MemoryView,
  OpenSessionInput,
  OpenSessionOutput,
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

export interface ConflictRecord {
  id: string;
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
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  sessionId: string;
  createdAt: string;
}

export interface ProposalContext {
  actor: MemoryActor;
  explicitDirective: boolean;
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
  getMemory(id: string): Promise<{ record: MemoryRecord; current: MemoryRevision } | null>;
  createRevision(input: CorrectMemoryInput): Promise<MemoryRecord>;
  updateMemoryRevision(id: string, revision: MemoryRevision): Promise<MemoryRecord>;
  updateMemoryLifecycle(id: string, lifecycle: MemoryLifecycle): Promise<MemoryRecord>;
  removeMemory(id: string): Promise<void>;
  listCurrentMemories(): Promise<MemoryRevision[]>;
  findConflicts(memoryId: string): Promise<ConflictRecord[]>;
  createJob(job: Omit<JobRecord, 'id' | 'createdAt'>): Promise<JobRecord>;
  getJob(id: string): Promise<JobRecord | null>;
  getCorpusRevision(): Promise<CorpusRevision>;
}

export interface MemoryService {
  openSession(input: OpenSessionInput): Promise<OpenSessionOutput>;
  recordEvents(input: RecordEventsInput): Promise<RecordEventsOutput>;
  proposeMemory(input: ProposeMemoryInput, context: ProposalContext): Promise<ProposalResult>;
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
  listScopesForSession(sessionId: string): Promise<Scope[]>;
  getCorpusRevision(): Promise<string>;
}
