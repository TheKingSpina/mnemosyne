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
