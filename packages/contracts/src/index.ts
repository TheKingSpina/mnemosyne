import { z } from 'zod';

export const scopeTypeSchema = z.enum(['session', 'project', 'area']);
export type ScopeType = z.infer<typeof scopeTypeSchema>;

export const scopeSchema = z.object({
  type: scopeTypeSchema,
  id: z.string().min(1),
});
export type Scope = z.infer<typeof scopeSchema>;

export const privacyFlagSchema = z.enum(['local_only', 'anonymized', 'public']);
export type PrivacyFlag = z.infer<typeof privacyFlagSchema>;

export const memoryKindSchema = z.enum([
  'fact',
  'preference',
  'instruction',
  'decision',
  'convention',
  'constraint',
  'goal',
  'hypothesis',
  'episode',
]);
export type MemoryKind = z.infer<typeof memoryKindSchema>;
// The stable sets, read from the schemas so a breakdown cannot drift from
// the contract that validates it.
export const memoryKinds = memoryKindSchema.options;

export const epistemicBasisSchema = z.enum([
  'user_asserted',
  'observed',
  'verified',
  'inferred',
  'unknown',
]);
export type EpistemicBasis = z.infer<typeof epistemicBasisSchema>;

export const assessmentSchema = z.enum(['uncontested', 'disputed']);
export type Assessment = z.infer<typeof assessmentSchema>;

export const sensitivitySchema = z.enum(['normal', 'private', 'sensitive', 'secret']);
export type Sensitivity = z.infer<typeof sensitivitySchema>;

export const activationSchema = z.enum(['always', 'on_demand']);
export type Activation = z.infer<typeof activationSchema>;

export const memoryActorSchema = z.enum(['owner', 'harness']);
export type MemoryActor = z.infer<typeof memoryActorSchema>;

export const memoryLifecycleSchema = z.enum([
  'candidate',
  'pending_approval',
  'accepted',
  'rejected',
  'superseded',
  'expired',
  'retracted',
  'forgotten',
]);
export type MemoryLifecycle = z.infer<typeof memoryLifecycleSchema>;
export const memoryLifecycles = memoryLifecycleSchema.options;

export const memoryRevisionSchema = z.object({
  memoryId: z.string().min(1),
  version: z.number().int().positive(),
  content: z.string().min(1).max(10_000),
  kind: memoryKindSchema,
  scope: scopeSchema,
  epistemicBasis: epistemicBasisSchema,
  assessment: assessmentSchema,
  confidence: z.number().min(0).max(1).nullable(),
  sensitivity: sensitivitySchema,
  activation: activationSchema,
  sourceEventIds: z.array(z.string().min(1)).default([]),
});
export type MemoryRevision = z.infer<typeof memoryRevisionSchema>;

export const memoryViewSchema = memoryRevisionSchema.extend({
  lifecycle: memoryLifecycleSchema,
  currentVersion: z.number().int().positive(),
  // The root project the memory belongs to. It is identity, not content: a
  // memory never changes project, so a view can always say where it lives.
  projectId: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type MemoryView = z.infer<typeof memoryViewSchema>;

export const memoryPatchSchema = z
  .object({
    content: z.string().min(1).max(10_000),
    kind: memoryKindSchema,
    scope: scopeSchema,
    epistemicBasis: epistemicBasisSchema,
    assessment: assessmentSchema,
    confidence: z.number().min(0).max(1).nullable(),
    sensitivity: sensitivitySchema,
    activation: activationSchema,
  })
  .partial();
export type MemoryPatch = z.infer<typeof memoryPatchSchema>;

export const openSessionInputSchema = z.object({
  projectId: z.string().min(1),
  areaIds: z.array(z.string().min(1)).optional(),
  taskTitle: z.string().max(500).optional(),
});
export type OpenSessionInput = z.infer<typeof openSessionInputSchema>;

export const openSessionOutputSchema = z.object({
  sessionId: z.string().min(1),
  projectId: z.string().min(1),
  areaIds: z.array(z.string()),
  corpusRevision: z.string().min(1),
});
export type OpenSessionOutput = z.infer<typeof openSessionOutputSchema>;

// Arcs are proposed by clients and accepted by the owner, exactly like memories,
// so they carry the same lifecycle in the contract.
export const arcLifecycleSchema = z.enum(['pending_approval', 'accepted', 'rejected', 'retracted']);

export const proposeMemoryArcInputSchema = z.object({
  sessionId: z.string().min(1),
  fromMemoryId: z.string().min(1),
  toMemoryId: z.string().min(1),
  type: z.string().min(1).max(100),
  weight: z.number().min(0).max(1).optional(),
});
export type ProposeMemoryArcInput = z.infer<typeof proposeMemoryArcInputSchema>;

export const proposeProjectArcInputSchema = z.object({
  fromProjectId: z.string().min(1),
  toProjectId: z.string().min(1),
  type: z.string().min(1).max(100),
  weight: z.number().min(0).max(1).optional(),
});
export type ProposeProjectArcInput = z.infer<typeof proposeProjectArcInputSchema>;

export const memoryArcViewSchema = z.object({
  arcId: z.string().min(1),
  fromMemoryId: z.string().min(1),
  toMemoryId: z.string().min(1),
  type: z.string().min(1),
  weight: z.number().min(0).max(1).nullable(),
  lifecycle: arcLifecycleSchema,
});
export type MemoryArcView = z.infer<typeof memoryArcViewSchema>;

export const projectArcViewSchema = z.object({
  arcId: z.string().min(1),
  fromProjectId: z.string().min(1),
  toProjectId: z.string().min(1),
  type: z.string().min(1),
  weight: z.number().min(0).max(1).nullable(),
  lifecycle: arcLifecycleSchema,
});
export type ProjectArcView = z.infer<typeof projectArcViewSchema>;

export const proposalArcResultSchema = z.union([
  memoryArcViewSchema.extend({ status: z.enum(['accepted', 'pending_approval']) }),
  projectArcViewSchema.extend({ status: z.enum(['accepted', 'pending_approval']) }),
]);
export type ProposalArcResult = z.infer<typeof proposalArcResultSchema>;

export const listMemoryArcsInputSchema = z.object({
  memoryId: z.string().min(1),
});
export type ListMemoryArcsInput = z.infer<typeof listMemoryArcsInputSchema>;

export const listMemoryArcsOutputSchema = z.object({
  from: z.array(memoryArcViewSchema),
  to: z.array(memoryArcViewSchema),
});
export type ListMemoryArcsOutput = z.infer<typeof listMemoryArcsOutputSchema>;

export const listProjectArcsInputSchema = z.object({
  projectId: z.string().min(1),
});
export type ListProjectArcsInput = z.infer<typeof listProjectArcsInputSchema>;

export const listProjectArcsOutputSchema = z.object({
  items: z.array(projectArcViewSchema),
});
export type ListProjectArcsOutput = z.infer<typeof listProjectArcsOutputSchema>;

export const projectViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  privacy: privacyFlagSchema,
});
export type ProjectView = z.infer<typeof projectViewSchema>;

// A project seen from the outside: the same identity plus the size of what it
// holds. The counts are corpus-level aggregates, so every profile reads the
// same numbers; only the memory content behind them is scoped. An agent that
// cannot see the shape of the corpus cannot decide where to explore.
export const projectSummarySchema = projectViewSchema.extend({
  areaCount: z.number().int().nonnegative(),
  memoryCount: z.number().int().nonnegative(),
  acceptedCount: z.number().int().nonnegative(),
  pendingApprovalCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  retractedCount: z.number().int().nonnegative(),
  openConflictCount: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  arcCount: z.number().int().nonnegative(),
  latestMemoryAt: z.string().datetime({ offset: true }).optional(),
});
export type ProjectSummary = z.infer<typeof projectSummarySchema>;

export const listProjectsOutputSchema = z.object({
  projects: z.array(projectSummarySchema),
});
export type ListProjectsOutput = z.infer<typeof listProjectsOutputSchema>;

// The corpus part of a project: the numbers that move when the corpus moves,
// and therefore the numbers a cache may hold. The structural part (areas,
// sessions) is deliberately not here: the corpus revision does not cover it,
// because creating a project or a session does not bump the revision. A
// cached directory that missed a new project would hide the very thing it
// exists to show.
export const projectCorpusAggregateSchema = z.object({
  projectId: z.string().min(1),
  memoryCount: z.number().int().nonnegative(),
  acceptedCount: z.number().int().nonnegative(),
  pendingApprovalCount: z.number().int().nonnegative(),
  rejectedCount: z.number().int().nonnegative(),
  retractedCount: z.number().int().nonnegative(),
  openConflictCount: z.number().int().nonnegative(),
  arcCount: z.number().int().nonnegative(),
  latestMemoryAt: z.string().datetime({ offset: true }).optional(),
});
export type ProjectCorpusAggregate = z.infer<typeof projectCorpusAggregateSchema>;

export const projectStructureSchema = z.object({
  projectId: z.string().min(1),
  areaCount: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
});
export type ProjectStructure = z.infer<typeof projectStructureSchema>;

export const setProjectPrivacyInputSchema = z.object({
  privacy: privacyFlagSchema,
});
export type SetProjectPrivacyInput = z.infer<typeof setProjectPrivacyInputSchema>;

export const listAllArcsOutputSchema = z.object({
  memoryArcs: z.array(memoryArcViewSchema),
  projectArcs: z.array(projectArcViewSchema),
});
export type ListAllArcsOutput = z.infer<typeof listAllArcsOutputSchema>;

export const reviewArcInputSchema = z.object({
  expectedLifecycle: z.literal('pending_approval').default('pending_approval'),
  decision: z.enum(['accept', 'reject']),
});
export type ReviewArcInput = z.infer<typeof reviewArcInputSchema>;

export const reviewArcOutputSchema = z.union([memoryArcViewSchema, projectArcViewSchema]);
export type ReviewArcOutput = z.infer<typeof reviewArcOutputSchema>;

export const listPendingProposalsInputSchema = z.object({
  sessionId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListPendingProposalsInput = z.infer<typeof listPendingProposalsInputSchema>;

export const pendingProposalsOutputSchema = z.object({
  items: z.array(memoryViewSchema),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type PendingProposalsOutput = z.infer<typeof pendingProposalsOutputSchema>;

export const listAdminMemoriesInputSchema = z.object({
  q: z.string().max(2_000).default(''),
  lifecycle: memoryLifecycleSchema.optional(),
  kind: memoryKindSchema.optional(),
  scopeType: scopeTypeSchema.optional(),
  scopeId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListAdminMemoriesInput = z.infer<typeof listAdminMemoriesInputSchema>;

export const adminMemoriesOutputSchema = z.object({
  items: z.array(memoryViewSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type AdminMemoriesOutput = z.infer<typeof adminMemoriesOutputSchema>;

export const conflictViewSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    'direct_contradiction',
    'scope_mismatch',
    'temporal_overlap',
    'different_subject',
    'semantic_tension',
  ]),
  memoryIds: z.array(z.string().min(1)).min(2),
  status: z.enum(['open', 'resolved']),
});
export type ConflictView = z.infer<typeof conflictViewSchema>;
export type ConflictType = ConflictView['type'];

export const memoryAdminViewSchema = z.object({
  memory: memoryViewSchema,
  revisions: z.array(memoryRevisionSchema),
  conflicts: z.array(conflictViewSchema).default([]),
});
export type MemoryAdminView = z.infer<typeof memoryAdminViewSchema>;

// Exploration. An agent that can only search cannot explore: it has to guess
// the terms, and a miss looks like an empty corpus. These shapes let it walk
// the corpus from the outside in, without turning the corpus into a dump.
export const areaViewSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type AreaView = z.infer<typeof areaViewSchema>;

export const projectOutlineSchema = z.object({
  project: projectSummarySchema,
  areas: z.array(areaViewSchema),
  counts: z.object({
    // Every key is always present, zero included: a stable shape is what lets
    // a reader compare projects without probing for the missing ones.
    byKind: z.record(memoryKindSchema, z.number().int().nonnegative()),
    byLifecycle: z.record(memoryLifecycleSchema, z.number().int().nonnegative()),
    byScope: z.object({
      session: z.number().int().nonnegative(),
      project: z.number().int().nonnegative(),
      area: z.number().int().nonnegative(),
    }),
  }),
  recentMemories: z.array(memoryViewSchema),
  openConflicts: z.array(conflictViewSchema),
  projectArcs: z.array(projectArcViewSchema),
});
export type ProjectOutline = z.infer<typeof projectOutlineSchema>;

export const listProjectMemoriesInputSchema = z.object({
  projectId: z.string().min(1),
  kind: memoryKindSchema.optional(),
  lifecycle: memoryLifecycleSchema.optional(),
  scopeType: scopeTypeSchema.optional(),
  scopeId: z.string().min(1).optional(),
  q: z.string().max(2_000).default(''),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListProjectMemoriesInput = z.infer<typeof listProjectMemoriesInputSchema>;

export const projectMemoriesOutputSchema = z.object({
  items: z.array(memoryViewSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type ProjectMemoriesOutput = z.infer<typeof projectMemoriesOutputSchema>;

// The single-memory read. `revisions` is owner-only: the history of a memory
// is governance state, not something a harness needs to read a memory.
export const memoryDetailSchema = z.object({
  memory: memoryViewSchema,
  arcs: z.object({
    from: z.array(memoryArcViewSchema),
    to: z.array(memoryArcViewSchema),
  }),
  conflicts: z.array(conflictViewSchema),
  revisions: z.array(memoryRevisionSchema).optional(),
});
export type MemoryDetail = z.infer<typeof memoryDetailSchema>;

export const conflictListOutputSchema = z.object({
  items: z.array(conflictViewSchema),
});
export type ConflictListOutput = z.infer<typeof conflictListOutputSchema>;

export const resolveConflictOutputSchema = conflictViewSchema;
export type ResolveConflictOutput = z.infer<typeof resolveConflictOutputSchema>;

export const adminOverviewOutputSchema = z.object({
  total: z.number().int().nonnegative(),
  accepted: z.number().int().nonnegative(),
  pendingApproval: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  retracted: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  corpusRevision: z.string().min(1),
});
export type AdminOverviewOutput = z.infer<typeof adminOverviewOutputSchema>;

export const sessionViewSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  areaIds: z.array(z.string().min(1)),
  taskTitle: z.string().optional(),
  sequence: z.number().int().nonnegative(),
  status: z.enum(['open', 'closed']),
  createdAt: z.string().datetime({ offset: true }),
  closedAt: z.string().datetime({ offset: true }).optional(),
});
export type SessionView = z.infer<typeof sessionViewSchema>;

export const listAdminSessionsInputSchema = z.object({
  projectId: z.string().min(1).optional(),
  status: z.enum(['open', 'closed']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListAdminSessionsInput = z.infer<typeof listAdminSessionsInputSchema>;

export const adminSessionsOutputSchema = z.object({
  items: z.array(sessionViewSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type AdminSessionsOutput = z.infer<typeof adminSessionsOutputSchema>;

export const jobViewSchema = z.object({
  id: z.string().min(1),
  operation: z.enum(['session_consolidation', 'memory_extraction']),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'quarantined', 'cancelled']),
  sessionId: z.string().min(1),
  availableAt: z.string().datetime({ offset: true }).optional(),
  leaseOwner: z.string().min(1).optional(),
  leaseExpiresAt: z.string().datetime({ offset: true }).optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type JobView = z.infer<typeof jobViewSchema>;

export const listAdminJobsInputSchema = z.object({
  status: z
    .enum(['queued', 'running', 'succeeded', 'failed', 'quarantined', 'cancelled'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListAdminJobsInput = z.infer<typeof listAdminJobsInputSchema>;

export const adminJobsOutputSchema = z.object({
  items: z.array(jobViewSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  offset: z.number().int().nonnegative(),
});
export type AdminJobsOutput = z.infer<typeof adminJobsOutputSchema>;

export const eventViewSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: z.literal('message'),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string(),
  occurredAt: z.string().datetime({ offset: true }),
  explicitMemoryRequest: z.boolean(),
});
export type EventView = z.infer<typeof eventViewSchema>;

export const adminSessionDetailOutputSchema = z.object({
  session: sessionViewSchema,
  events: z.array(eventViewSchema),
  jobs: z.array(jobViewSchema),
});
export type AdminSessionDetailOutput = z.infer<typeof adminSessionDetailOutputSchema>;

export const jobAttemptViewSchema = z.object({
  id: z.string().min(1),
  jobId: z.string().min(1),
  workerId: z.string().min(1),
  attempt: z.number().int().positive(),
  status: z.enum(['running', 'succeeded', 'failed', 'quarantined']),
  errorCode: z.string().max(200).optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});
export type JobAttemptView = z.infer<typeof jobAttemptViewSchema>;

export const analyzerCandidateSchema = z.object({
  proposalType: z.enum(['decay', 'edge', 'redundancy', 'contradiction', 'merge']),
  sourceIds: z.array(z.string().min(1)).min(1),
  targetId: z.string().min(1).optional(),
  rationale: z.string().min(1).max(2000),
  confidence: z.number().min(0).max(1),
});
export type AnalyzerCandidate = z.infer<typeof analyzerCandidateSchema>;

export const analyzerNodeSchema = z.object({
  memoryId: z.string().min(1),
  kind: memoryKindSchema,
  scopeKind: z.enum(['session', 'project', 'area']),
  ageBucket: z.enum(['<7d', '<30d', '<180d', 'older']),
  incidentArcTypes: z.array(z.string()),
  content: z.string().max(10_000).optional(),
});
export type AnalyzerNode = z.infer<typeof analyzerNodeSchema>;

export const analyzerBatchSchema = z.object({
  privacy: z.enum(['public', 'anonymized']),
  items: z.array(analyzerNodeSchema).min(1),
});
export type AnalyzerBatch = z.infer<typeof analyzerBatchSchema>;

export const analyzerResultSchema = z.object({
  candidates: z.array(analyzerCandidateSchema).default([]),
});
export type AnalyzerResult = z.infer<typeof analyzerResultSchema>;

export const rerankResultItemSchema = z.object({
  index: z.number().int().nonnegative(),
  relevance_score: z.number(),
});
export type RerankResultItem = z.infer<typeof rerankResultItemSchema>;

export const rerankResponseSchema = z.object({
  results: z.array(rerankResultItemSchema),
});
export type RerankResponse = z.infer<typeof rerankResponseSchema>;

export const judgeVerdictSchema = z.object({
  verdict: z.enum(['accept', 'reject']),
  citedIds: z.array(z.string().min(1)).min(1),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(500),
});
export type JudgeVerdict = z.infer<typeof judgeVerdictSchema>;

export const pruningAnalysisOutputSchema = z.object({
  status: z.enum(['ran', 'disabled']),
  batches: z.number().int().nonnegative(),
  proposalsWritten: z.number().int().nonnegative(),
  // Re-entry is visible, not silent: batches already analyzed (same members)
  // and candidate signatures already proposed are skipped, never re-sent.
  skipped: z.object({
    batches: z.number().int().nonnegative(),
    proposals: z.number().int().nonnegative(),
  }),
  reason: z.string().min(1).optional(),
});
export type PruningAnalysisOutput = z.infer<typeof pruningAnalysisOutputSchema>;

export const extractionCandidateSchema = z.object({
  sessionId: z.string().min(1),
  eventIds: z.array(z.string().min(1)).min(1),
  content: z.string().min(1).max(10_000),
  kind: memoryKindSchema,
  scope: scopeSchema,
  epistemicBasis: epistemicBasisSchema,
  assessment: assessmentSchema.default('uncontested'),
  confidence: z.number().min(0).max(1).nullable().default(null),
  sensitivity: sensitivitySchema.default('normal'),
  activation: activationSchema.default('on_demand'),
});
export type ExtractionCandidate = z.infer<typeof extractionCandidateSchema>;

export const extractionResultSchema = z.object({
  candidates: z.array(extractionCandidateSchema).default([]),
});
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

export const listJobAttemptsOutputSchema = z.object({
  items: z.array(jobAttemptViewSchema),
});
export type ListJobAttemptsOutput = z.infer<typeof listJobAttemptsOutputSchema>;

export const recordEventSchema = z.object({
  eventId: z.string().min(1),
  type: z.literal('message'),
  role: z.enum(['user', 'assistant', 'tool']),
  content: z.string().min(1).max(100_000),
  occurredAt: z.string().datetime({ offset: true }),
  explicitMemoryRequest: z.boolean().default(false),
});
export type RecordEvent = z.infer<typeof recordEventSchema>;

export const recordEventsInputSchema = z.object({
  sessionId: z.string().min(1),
  events: z.array(recordEventSchema).min(1).max(100),
});
export type RecordEventsInput = z.infer<typeof recordEventsInputSchema>;

export const recordEventsOutputSchema = z.object({
  acceptedEventIds: z.array(z.string()),
  duplicateEventIds: z.array(z.string()),
  jobIds: z.array(z.string()),
});
export type RecordEventsOutput = z.infer<typeof recordEventsOutputSchema>;

export const proposeMemoryInputSchema = z.object({
  sessionId: z.string().min(1),
  content: z.string().min(1).max(10_000),
  kind: memoryKindSchema,
  scope: scopeSchema,
  // Optional per-node privacy override; null/absent inherits the project flag.
  // Manual marking only: nothing infers this value.
  privacy: privacyFlagSchema.optional(),
  epistemicBasis: epistemicBasisSchema,
  assessment: assessmentSchema.default('uncontested'),
  confidence: z.number().min(0).max(1).nullable().default(null),
  sensitivity: sensitivitySchema.default('normal'),
  activation: activationSchema.default('on_demand'),
  sourceEventIds: z.array(z.string().min(1)).default([]),
  // Optional relations to existing memories: when present, the service also
  // proposes an arc (pending approval) from the new memory to each of them, so
  // the graph is populated in the same call instead of being forgotten.
  relatedMemoryIds: z.array(z.string().min(1)).optional(),
  relationType: z.string().min(1).max(100).optional(),
  relationWeight: z.number().min(0).max(1).optional(),
});
export type ProposeMemoryInput = z.infer<typeof proposeMemoryInputSchema>;

export const ownerProposalSubmissionSchema = proposeMemoryInputSchema.extend({
  explicitDirective: z.boolean().default(false),
});
export type OwnerProposalSubmission = z.infer<typeof ownerProposalSubmissionSchema>;

export const proposalResultSchema = z.object({
  status: z.enum(['accepted', 'pending_approval', 'rejected', 'merged']),
  memoryId: z.string().optional(),
  proposalId: z.string().optional(),
  conflictId: z.string().optional(),
  jobId: z.string().optional(),
  reason: z.string().optional(),
  // Arcs proposed alongside the memory, when relatedMemoryIds was provided.
  arcIds: z.array(z.string().min(1)).optional(),
});
export type ProposalResult = z.infer<typeof proposalResultSchema>;

export const reviewProposalInputSchema = z.object({
  memoryId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  decision: z.enum(['accept', 'reject']),
  finalContent: z.string().min(1).max(10_000).optional(),
  finalKind: memoryKindSchema.optional(),
  finalScope: scopeSchema.optional(),
  finalEpistemicBasis: epistemicBasisSchema.optional(),
  finalAssessment: assessmentSchema.optional(),
  finalConfidence: z.number().min(0).max(1).nullable().optional(),
  finalSensitivity: sensitivitySchema.optional(),
  finalActivation: activationSchema.optional(),
});
export type ReviewProposalInput = z.infer<typeof reviewProposalInputSchema>;

export const reviewProposalOutputSchema = z.object({
  memory: memoryViewSchema,
});
export type ReviewProposalOutput = z.infer<typeof reviewProposalOutputSchema>;

export const correctMemoryInputSchema = z.object({
  memoryId: z.string().min(1),
  expectedVersion: z.number().int().positive(),
  content: z.string().min(1).max(10_000),
  kind: memoryKindSchema.optional(),
  scope: scopeSchema.optional(),
  epistemicBasis: epistemicBasisSchema.optional(),
  assessment: assessmentSchema.optional(),
  confidence: z.number().min(0).max(1).nullable().optional(),
  sensitivity: sensitivitySchema.optional(),
  activation: activationSchema.optional(),
});
export type CorrectMemoryInput = z.infer<typeof correctMemoryInputSchema>;

export const correctMemoryOutputSchema = z.object({
  memory: memoryViewSchema,
});
export type CorrectMemoryOutput = z.infer<typeof correctMemoryOutputSchema>;

export const retractMemoryInputSchema = z.object({
  memoryId: z.string().min(1),
  reason: z.string().min(1).max(2_000),
});
export type RetractMemoryInput = z.infer<typeof retractMemoryInputSchema>;

export const forgetMemoryInputSchema = z.object({
  memoryId: z.string().min(1),
  confirmationToken: z.string().min(1),
});
export type ForgetMemoryInput = z.infer<typeof forgetMemoryInputSchema>;

export const prepareForgetOutputSchema = z.object({
  memoryId: z.string().min(1),
  confirmationToken: z.string().min(16),
  expiresAt: z.string().datetime({ offset: true }),
});
export type PrepareForgetOutput = z.infer<typeof prepareForgetOutputSchema>;

export const searchMemoriesInputSchema = z.object({
  sessionId: z.string().min(1),
  query: z.string().min(1).max(2_000),
  scope: scopeSchema.optional(),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().min(0).default(0),
});
export type SearchMemoriesInput = z.input<typeof searchMemoriesInputSchema>;

export const conflictPolicySchema = z.enum(['include_disputed', 'quarantine_conflicts']);
export type ConflictPolicy = z.infer<typeof conflictPolicySchema>;

export const contextInputSchema = z.object({
  sessionId: z.string().min(1),
  query: z.string().min(1).max(2_000),
  budgetTokens: z.number().int().min(100).max(100_000).default(1_200),
  conflictPolicy: conflictPolicySchema.default('include_disputed'),
});
export type ContextInput = z.input<typeof contextInputSchema>;

export const contextOutputSchema = z.object({
  context: z.array(memoryRevisionSchema),
  conflicts: z.array(
    z.object({
      id: z.string(),
      type: conflictViewSchema.shape.type,
      memoryIds: z.array(z.string()).min(2),
    }),
  ),
  requiredContextComplete: z.boolean(),
  tokensEstimated: z.number().int().nonnegative(),
  budgetTokens: z.number().int().positive(),
  excludedResults: z.number().int().nonnegative(),
  serviceStatus: z.enum(['available', 'degraded', 'maintenance', 'unavailable']),
  corpusRevision: z.string().min(1),
  degradations: z.array(
    z.object({
      component: z.string(),
      missingCapability: z.string(),
      impact: z.string(),
    }),
  ),
});
export type ContextOutput = z.infer<typeof contextOutputSchema>;

export const corpusExportSchema = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.string().datetime({ offset: true }),
  corpusRevision: z.string().min(1),
  sessions: z.array(sessionViewSchema),
  projects: z.array(
    z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().min(1).optional(),
      privacy: privacyFlagSchema,
      createdAt: z.string().datetime({ offset: true }),
      updatedAt: z.string().datetime({ offset: true }),
    }),
  ),
  areas: z.array(
    z.object({
      id: z.string().min(1),
      projectId: z.string().min(1),
      name: z.string().min(1),
      createdAt: z.string().datetime({ offset: true }),
      updatedAt: z.string().datetime({ offset: true }),
    }),
  ),
  events: z.array(eventViewSchema),
  memories: z.array(
    z.object({
      record: z.object({
        id: z.string().min(1),
        projectId: z.string().min(1),
        currentVersion: z.number().int().positive(),
        lifecycle: memoryLifecycleSchema,
        privacy: privacyFlagSchema.nullable(),
        createdAt: z.string().datetime({ offset: true }),
        updatedAt: z.string().datetime({ offset: true }),
      }),
      current: memoryRevisionSchema,
    }),
  ),
  revisions: z.array(z.object({ memoryId: z.string().min(1), revision: memoryRevisionSchema })),
  conflicts: z.array(conflictViewSchema),
  jobs: z.array(
    z.object({
      id: z.string().min(1),
      operation: z.enum(['session_consolidation', 'memory_extraction']),
      status: z.enum(['queued', 'running', 'succeeded', 'failed', 'quarantined', 'cancelled']),
      sessionId: z.string().min(1),
      availableAt: z.string().datetime({ offset: true }).optional(),
      leaseOwner: z.string().min(1).optional(),
      leaseExpiresAt: z.string().datetime({ offset: true }).optional(),
      createdAt: z.string().datetime({ offset: true }),
      updatedAt: z.string().datetime({ offset: true }),
    }),
  ),
  jobAttempts: z.array(
    z.object({
      id: z.string().min(1),
      jobId: z.string().min(1),
      workerId: z.string().min(1),
      attempt: z.number().int().positive(),
      status: z.enum(['running', 'succeeded', 'failed', 'quarantined']),
      errorCode: z.string().max(200).optional(),
      createdAt: z.string().datetime({ offset: true }),
      updatedAt: z.string().datetime({ offset: true }),
    }),
  ),
  memoryArcs: z.array(
    z.object({
      id: z.string().min(1),
      fromMemoryId: z.string().min(1),
      toMemoryId: z.string().min(1),
      type: z.string().min(1),
      weight: z.number().min(0).max(1).nullable(),
      lifecycle: z.enum(['pending_approval', 'accepted', 'rejected', 'retracted']),
      createdAt: z.string().datetime({ offset: true }),
    }),
  ),
  projectArcs: z.array(
    z.object({
      id: z.string().min(1),
      fromProjectId: z.string().min(1),
      toProjectId: z.string().min(1),
      type: z.string().min(1),
      weight: z.number().min(0).max(1).nullable(),
      lifecycle: z.enum(['pending_approval', 'accepted', 'rejected', 'retracted']),
      createdAt: z.string().datetime({ offset: true }),
    }),
  ),
  forgetLedger: z.array(
    z.object({ memoryId: z.string().min(1), forgottenAt: z.string().datetime({ offset: true }) }),
  ),
});
export type CorpusExport = z.infer<typeof corpusExportSchema>;

export const corpusRestoreResultSchema = z.object({
  sourceCorpusRevision: z.string().min(1),
  corpusRevision: z.string().min(1),
  restored: z.object({
    sessions: z.number().int().nonnegative(),
    events: z.number().int().nonnegative(),
    memories: z.number().int().nonnegative(),
    revisions: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    jobs: z.number().int().nonnegative(),
    jobAttempts: z.number().int().nonnegative(),
    forgetLedger: z.number().int().nonnegative(),
  }),
  skipped: z.object({
    forgottenMemories: z.number().int().nonnegative(),
    forgottenRevisions: z.number().int().nonnegative(),
    forgottenConflicts: z.number().int().nonnegative(),
  }),
});
export type CorpusRestoreResult = z.infer<typeof corpusRestoreResultSchema>;

export const balancedRetentionPolicy = {
  profile: 'balanced',
  closedEventDays: 30,
  pendingCandidateDays: 30,
  rejectedCandidateDays: 7,
  supersededRevisionDays: 90,
  retractedMemoryDays: 30,
  // Processed outbox rows are derived projection feed, not corpus content, so
  // they need a much shorter window than anything the owner can see.
  processedOutboxEventDays: 3,
  // Jobs in a terminal state (completed, failed, cancelled) and their attempts
  // grow without bound: the worker never cleans them up. 30 days gives enough
  // history for manual inspection while preventing unbounded accumulation.
  terminalJobDays: 30,
  // Idempotency keys exist only for in-flight deduplication. A key older than
  // this window cannot belong to an active request, so it is safe to remove.
  expiredIdempotencyKeyDays: 30,
} as const;

// Deterministic pruning coefficients. Data, not code: tuning decay is an edit
// here, not a migration, the same way hierarchical_relation tunes acyclicity.
// Phase (a) uses recency, edge weight and kind only; access frequency does not
// exist in the system and is not promised.
export const pruningPolicy = {
  weights: { recency: 0.5, edgeWeight: 0.3, kind: 0.2 },
  recencyHalfLifeDays: 180,
  // Neutral component when a memory has no weighted arcs: isolation must not
  // read as worthlessness, or every young unlinked memory would decay.
  noArcNeutralWeight: 0.5,
  // Below this score an accepted memory is proposed for expiry.
  memoryScoreThreshold: 0.25,
  // Below this raw weight an accepted non-hierarchical arc is proposed for pruning.
  edgeWeightThreshold: 0.2,
  // Analyzer batches never mix privacy flags; this caps each batch.
  analyzerMaxBatchSize: 20,
  // Calibrated judge (phase b on llama.cpp): minimum /v1/rerank relevance score
  // and embedding cosine similarity for redundancy, minimum confidence for
  // constrained JSON-schema verdicts, and explicit fusion weights with
  // deterministic tie-breaking.
  redundancyRerankThreshold: 0.85,
  redundancyCosineThreshold: 0.9,
  verdictConfidenceThreshold: 0.75,
  fusionWeights: { deterministic: 0.5, calibrated: 0.5 },
  fusionAcceptThreshold: 0.6,
  // Never expire, whatever the score: identity-grade content.
  neverExpireKinds: ['fact', 'decision'],
  kindFactors: {
    fact: 1.0,
    decision: 0.9,
    preference: 0.7,
    instruction: 0.7,
    convention: 0.6,
    constraint: 0.6,
    goal: 0.5,
    hypothesis: 0.4,
    episode: 0.3,
  },
} as const;
export type PruningPolicy = typeof pruningPolicy;

export const retentionStatusOutputSchema = z.object({
  managed: z.literal(true),
  profile: z.literal(balancedRetentionPolicy.profile),
  policy: z.object({
    closedEventDays: z.number().int().positive(),
    pendingCandidateDays: z.number().int().positive(),
    rejectedCandidateDays: z.number().int().positive(),
    supersededRevisionDays: z.number().int().positive(),
    retractedMemoryDays: z.number().int().positive(),
    processedOutboxEventDays: z.number().int().positive(),
    terminalJobDays: z.number().int().positive(),
    expiredIdempotencyKeyDays: z.number().int().positive(),
  }),
  lastRunAt: z.string().datetime({ offset: true }).optional(),
});
export type RetentionStatusOutput = z.infer<typeof retentionStatusOutputSchema>;

export const retentionRunOutputSchema = z.object({
  profile: z.literal(balancedRetentionPolicy.profile),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }),
  cutoffs: z.object({
    closedEvents: z.string().datetime({ offset: true }),
    pendingCandidates: z.string().datetime({ offset: true }),
    rejectedCandidates: z.string().datetime({ offset: true }),
    supersededRevisions: z.string().datetime({ offset: true }),
    retractedMemories: z.string().datetime({ offset: true }),
    terminalJobs: z.string().datetime({ offset: true }),
    expiredIdempotencyKeys: z.string().datetime({ offset: true }),
  }),
  deleted: z.object({
    closedSessionEvents: z.number().int().nonnegative(),
    pendingCandidates: z.number().int().nonnegative(),
    rejectedCandidates: z.number().int().nonnegative(),
    supersededRevisions: z.number().int().nonnegative(),
    retractedMemories: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    // The outbox is a derived projection feed, so pruning it does not change the
    // corpus and must not count towards the corpus revision bump.
    processedOutboxEvents: z.number().int().nonnegative(),
    // Terminal jobs and expired idempotency keys are operational bookkeeping,
    // not corpus content: pruning them must not bump the corpus revision.
    terminalJobs: z.number().int().nonnegative(),
    expiredIdempotencyKeys: z.number().int().nonnegative(),
  }),
  // Deterministic pruning rides the same run on the same schedule. Its counts
  // live beside deleted rather than inside it, because expiring a memory is a
  // lifecycle change and pruning an edge removes a relation: neither is the
  // age-based row deletion above.
  pruning: z.object({
    batchId: z.string().min(1),
    proposalsWritten: z.number().int().nonnegative(),
    memoriesExpired: z.number().int().nonnegative(),
    arcsPruned: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative(),
  }),
});
export type RetentionRunOutput = z.infer<typeof retentionRunOutputSchema>;

export const sessionConsolidationOutputSchema = z.object({
  sessionId: z.string().min(1),
  sourceEventCount: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  conflictCount: z.number().int().nonnegative(),
  acceptedMemories: z.literal(0),
});
export type SessionConsolidationOutput = z.infer<typeof sessionConsolidationOutputSchema>;

export const extractionProviderNameSchema = z.enum([
  'local',
  'openrouter',
  'openrouter-local-fallback',
]);
export type ExtractionProviderName = z.infer<typeof extractionProviderNameSchema>;

/**
 * Capabilities that only the worker process can know: it owns the extraction
 * provider, the Neo4j projection and the retention timer. The API and the MCP
 * server report these only when the worker has published a fresh heartbeat.
 */
export const workerRuntimeCapabilitiesSchema = z.object({
  neo4jConfigured: z.boolean(),
  openRouterConfigured: z.boolean(),
  extractionProvider: extractionProviderNameSchema,
  retentionScheduled: z.boolean(),
});
export type WorkerRuntimeCapabilities = z.infer<typeof workerRuntimeCapabilitiesSchema>;

/**
 * A capability the responding process could not observe, and why. A null
 * capability value always has a matching entry here: null means "unknown",
 * never "absent".
 */
export const capabilityGapSchema = z.object({
  field: z.string().min(1),
  reason: z.string().min(1),
});
export type CapabilityGap = z.infer<typeof capabilityGapSchema>;

export const adminCapabilitiesOutputSchema = z.object({
  reportedAt: z.string(),
  /**
   * Which process answered. Capabilities are scoped to the process that can
   * attest to them, so `redis: true` from the API and `redis: false` from MCP
   * are both correct: the API owns a cache and MCP does not. Read this field
   * before drawing a conclusion about the deployment.
   */
  reporter: z.string().min(1),
  workerObservedAt: z.string().nullable(),
  extraction: z.object({
    localExtractor: z.boolean().nullable(),
    openRouterConfigured: z.boolean().nullable(),
    extractionProvider: extractionProviderNameSchema.nullable(),
  }),
  projections: z.object({
    redis: z.boolean(),
    neo4j: z.boolean().nullable(),
    semanticSearch: z.boolean(),
  }),
  operations: z.object({
    backupVerified: z.boolean().nullable(),
    retentionManaged: z.boolean().nullable(),
    exportAvailable: z.boolean(),
  }),
  gaps: z.array(capabilityGapSchema),
});
export type AdminCapabilitiesOutput = z.infer<typeof adminCapabilitiesOutputSchema>;

const candidateBucketSchema = z.enum(['0', '1-5', '6-20', '21-100', '101-1000', '1000+']);
const resultBucketSchema = z.enum(['0', '1-5', '6-20', '21+']);
const scoreBandSchema = z.enum(['0', '0-0.2', '0.2-0.5', '0.5-1', '1']);

/**
 * Aggregate retrieval behaviour. Deliberately shaped so no field can carry a
 * query, a memory id or corpus content: everything is a count or a score band.
 */
export const retrievalTelemetryOutputSchema = z.object({
  reporter: z.string().min(1),
  searches: z.number().int().nonnegative(),
  contextResolutions: z.number().int().nonnegative(),
  cacheHits: z.number().int().nonnegative(),
  cacheMisses: z.number().int().nonnegative(),
  semanticUnavailable: z.number().int().nonnegative(),
  paths: z.object({
    lexicalOnly: z.number().int().nonnegative(),
    semanticOnly: z.number().int().nonnegative(),
    hybrid: z.number().int().nonnegative(),
    empty: z.number().int().nonnegative(),
  }),
  candidates: z.record(candidateBucketSchema, z.number().int().nonnegative()),
  results: z.record(resultBucketSchema, z.number().int().nonnegative()),
  topScoreBands: z.record(scoreBandSchema, z.number().int().nonnegative()),
  note: z.string().min(1),
});
export type RetrievalTelemetry = z.infer<typeof retrievalTelemetryOutputSchema>;

export const embeddingProfileCountSchema = z.object({
  profile: z.string().min(1),
  count: z.number().int().nonnegative(),
});
export type EmbeddingProfileCount = z.infer<typeof embeddingProfileCountSchema>;

/**
 * Compares what the corpus needs indexed against what the semantic index holds
 * for the active profile. Exists because a corpus restore does not rebuild
 * embeddings, and that used to degrade search silently to lexical-only.
 */
export const embeddingIndexHealthOutputSchema = z.object({
  available: z.boolean(),
  profile: z.string().nullable(),
  dimensions: z.number().int().positive().nullable(),
  memoryCount: z.number().int().nonnegative(),
  indexedForActiveProfile: z.number().int().nonnegative(),
  missingCount: z.number().int().nonnegative(),
  otherProfiles: z.array(embeddingProfileCountSchema),
  needsReindex: z.boolean(),
});
export type EmbeddingIndexHealthOutput = z.infer<typeof embeddingIndexHealthOutputSchema>;

export const embeddingReindexOutputSchema = z.object({
  scanned: z.number().int().nonnegative(),
  indexed: z.number().int().nonnegative(),
});
export type EmbeddingReindexOutput = z.infer<typeof embeddingReindexOutputSchema>;

export const clientTokenNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9._-]*$/u, 'client_token_name_must_be_lowercase_slug');

export const issuedClientTokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  role: z.literal('owner'),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type IssuedClientToken = z.infer<typeof issuedClientTokenSchema>;

export const issueClientTokenInputSchema = z.object({ name: clientTokenNameSchema });
export type IssueClientTokenInput = z.infer<typeof issueClientTokenInputSchema>;

export const issuedClientTokenOutputSchema = issuedClientTokenSchema.extend({
  token: z.string(),
});
export type IssuedClientTokenOutput = z.infer<typeof issuedClientTokenOutputSchema>;

export const clientTokenListOutputSchema = z.object({ tokens: z.array(issuedClientTokenSchema) });
export type ClientTokenListOutput = z.infer<typeof clientTokenListOutputSchema>;

export * from './openrouter.js';
export * from './feedback.js';
