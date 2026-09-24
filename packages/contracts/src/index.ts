import { z } from 'zod';

export const scopeTypeSchema = z.enum(['session', 'project', 'area', 'global']);
export type ScopeType = z.infer<typeof scopeTypeSchema>;

export const scopeSchema = z.object({
  type: scopeTypeSchema,
  id: z.string().min(1),
});
export type Scope = z.infer<typeof scopeSchema>;

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

export const listPendingProposalsInputSchema = z.object({
  sessionId: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).default(0),
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
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
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
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
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
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
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
  epistemicBasis: epistemicBasisSchema,
  assessment: assessmentSchema.default('uncontested'),
  confidence: z.number().min(0).max(1).nullable().default(null),
  sensitivity: sensitivitySchema.default('normal'),
  activation: activationSchema.default('on_demand'),
  sourceEventIds: z.array(z.string().min(1)).default([]),
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
export type SearchMemoriesInput = z.infer<typeof searchMemoriesInputSchema>;

export const contextInputSchema = z.object({
  sessionId: z.string().min(1),
  query: z.string().min(1).max(2_000),
  budgetTokens: z.number().int().min(100).max(100_000).default(1_200),
});
export type ContextInput = z.infer<typeof contextInputSchema>;

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
  events: z.array(eventViewSchema),
  memories: z.array(
    z.object({
      record: z.object({
        id: z.string().min(1),
        currentVersion: z.number().int().positive(),
        lifecycle: memoryLifecycleSchema,
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
} as const;

export const retentionStatusOutputSchema = z.object({
  managed: z.literal(true),
  profile: z.literal(balancedRetentionPolicy.profile),
  policy: z.object({
    closedEventDays: z.number().int().positive(),
    pendingCandidateDays: z.number().int().positive(),
    rejectedCandidateDays: z.number().int().positive(),
    supersededRevisionDays: z.number().int().positive(),
    retractedMemoryDays: z.number().int().positive(),
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
  }),
  deleted: z.object({
    closedSessionEvents: z.number().int().nonnegative(),
    pendingCandidates: z.number().int().nonnegative(),
    rejectedCandidates: z.number().int().nonnegative(),
    supersededRevisions: z.number().int().nonnegative(),
    retractedMemories: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
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

export const adminCapabilitiesOutputSchema = z.object({
  extraction: z.object({
    localExtractor: z.boolean(),
    openRouterConfigured: z.boolean(),
  }),
  projections: z.object({
    redis: z.literal(false),
    neo4j: z.literal(false),
    semanticSearch: z.boolean(),
  }),
  operations: z.object({
    backupVerified: z.literal(false),
    retentionManaged: z.literal(true),
    exportAvailable: z.literal(true),
  }),
});
export type AdminCapabilitiesOutput = z.infer<typeof adminCapabilitiesOutputSchema>;

export * from './openrouter.js';
