import {
  balancedRetentionPolicy,
  corpusExportSchema,
  contextInputSchema,
  correctMemoryInputSchema,
  listAdminMemoriesInputSchema,
  listPendingProposalsInputSchema,
  openSessionInputSchema,
  proposeMemoryInputSchema,
  recordEventsInputSchema,
  reviewProposalInputSchema,
  searchMemoriesInputSchema,
  listAdminJobsInputSchema,
  listAdminSessionsInputSchema,
  memoryFeedbackSchema,
  memoryRevisionSchema,
  type ContextInput,
  type ContextOutput,
  type AdminMemoriesOutput,
  type AdminOverviewOutput,
  type AdminCapabilitiesOutput,
  type CorpusExport,
  type CorpusRestoreResult,
  type ConflictListOutput,
  type CorrectMemoryInput,
  type CorrectMemoryOutput,
  type ListAdminMemoriesInput,
  type ListAdminJobsInput,
  type ListAdminSessionsInput,
  type ListPendingProposalsInput,
  type MemoryPatch,
  type MemoryRevision,
  type MemoryView,
  type MemoryAdminView,
  type AdminJobsOutput,
  type AdminSessionDetailOutput,
  type AdminSessionsOutput,
  type OpenSessionInput,
  type OpenSessionOutput,
  type PendingProposalsOutput,
  type PrepareForgetOutput,
  type ProposalResult,
  type ProposeMemoryInput,
  type RecordEventsInput,
  type RecordEventsOutput,
  type ReviewProposalInput,
  type ReviewProposalOutput,
  type RetentionRunOutput,
  type RetentionStatusOutput,
  type ListMemoryFeedbackOutput,
  type MemoryFeedbackInput,
  type MemoryFeedbackOutput,
  type SessionConsolidationOutput,
  type Scope,
  type SearchMemoriesInput,
} from '@mnemosyne/contracts';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { areDirectlyContradictory } from './conflict-detector.js';
import { containsSecret, decideProposal } from './policy.js';
import { estimateMemoryTokens } from './token-estimator.js';
import {
  analyzeQuery,
  buildLexicalCorpusStats,
  combineSearchScores,
  lexicalRelevance,
  minimumSearchScore,
  minimumSemanticScore,
  type QueryAnalysis,
} from './retrieval-ranking.js';
import type { EmbeddingProvider, SemanticSearchIndex } from './semantic-search.js';
import { corpusCacheKeyPrefix, type CorpusCache } from './corpus-cache.js';
import type {
  ConflictRecord,
  CorpusRevision,
  JobRecord,
  MemoryRecord,
  MemoryRepository,
  MemoryService,
  MemoryWithCurrent,
  ProposalContext,
  SessionRecord,
} from './types.js';

export interface CoreMemoryServiceOptions {
  forgetSecret: string;
  now?: () => Date;
  embeddingProvider?: EmbeddingProvider;
  semanticSearchIndex?: SemanticSearchIndex;
  corpusCache?: CorpusCache;
  corpusCacheTtlSeconds?: number;
  neo4jConfigured?: boolean;
}

export class CoreMemoryService implements MemoryService {
  private readonly now: () => Date;

  constructor(
    private readonly repository: MemoryRepository,
    private readonly options: CoreMemoryServiceOptions,
  ) {
    if (options.forgetSecret.length < 32) {
      throw new Error('forget_secret_too_short');
    }
    this.now = options.now ?? (() => new Date());
  }

  async getAdminCapabilities(): Promise<AdminCapabilitiesOutput> {
    return {
      extraction: {
        localExtractor: true,
        openRouterConfigured: false,
      },
      projections: {
        redis: this.options.corpusCache !== undefined,
        neo4j: false,
        semanticSearch:
          this.options.embeddingProvider !== undefined &&
          this.options.semanticSearchIndex !== undefined,
      },
      operations: {
        backupVerified: false,
        retentionManaged: true,
        exportAvailable: true,
      },
    };
  }

  async listCorpusExport(): Promise<CorpusExport> {
    const revision = await this.repository.getCorpusRevision();
    const sessions = await this.repository.listSessions();
    const events = await this.repository.listAllEvents();
    const memories = await this.repository.listMemoryViews();
    const revisions = await this.repository.listAllMemoryRevisions();
    const forgetLedger = await this.repository.listForgetLedger();
    return corpusExportSchema.parse({
      schemaVersion: 1,
      exportedAt: this.now().toISOString(),
      corpusRevision: `${revision.epoch}:${revision.revision}`,
      sessions,
      events,
      memories,
      revisions,
      conflicts: await this.repository.listAllConflicts(),
      jobs: await this.repository.listAllJobs(),
      jobAttempts: await this.repository.listAllJobAttempts(),
      forgetLedger,
    });
  }

  async restoreCorpus(input: CorpusExport): Promise<CorpusRestoreResult> {
    const validated = corpusExportSchema.parse(input);
    this.validateRestoreExport(validated);
    const [sessions, events, memories, revisions, conflicts, jobs, jobAttempts, existingLedger] =
      await Promise.all([
        this.repository.listSessions(),
        this.repository.listAllEvents(),
        this.repository.listMemoryViews(),
        this.repository.listAllMemoryRevisions(),
        this.repository.listAllConflicts(),
        this.repository.listAllJobs(),
        this.repository.listAllJobAttempts(),
        this.repository.listForgetLedger(),
      ]);
    if (
      sessions.length > 0 ||
      events.length > 0 ||
      memories.length > 0 ||
      revisions.length > 0 ||
      conflicts.length > 0 ||
      jobs.length > 0 ||
      jobAttempts.length > 0
    ) {
      throw new Error('restore_requires_empty_corpus');
    }
    const forgetLedger = new Map(
      existingLedger.map((entry) => [entry.memoryId, entry.forgottenAt]),
    );
    for (const entry of validated.forgetLedger) {
      if (!forgetLedger.has(entry.memoryId)) forgetLedger.set(entry.memoryId, entry.forgottenAt);
    }
    const counts = await this.repository.restoreCorpus({
      sourceCorpusRevision: validated.corpusRevision,
      sessions: validated.sessions,
      events: validated.events,
      memories: validated.memories,
      revisions: validated.revisions,
      conflicts: validated.conflicts,
      jobs: validated.jobs,
      jobAttempts: validated.jobAttempts,
      forgetLedger: [...forgetLedger].map(([memoryId, forgottenAt]) => ({ memoryId, forgottenAt })),
    });
    try {
      await this.options.corpusCache?.clear();
    } catch {
      // The cache is derived; the rotated corpus epoch makes residual entries unusable.
    }
    return {
      sourceCorpusRevision: validated.corpusRevision,
      corpusRevision: await this.getCorpusRevision(),
      ...counts,
    };
  }

  async submitFeedback(input: MemoryFeedbackInput): Promise<MemoryFeedbackOutput> {
    const validated = memoryFeedbackSchema.parse(input);
    const memory = await this.repository.getMemory(validated.memoryId);
    if (!memory) throw new Error('memory_not_found');
    const session = await this.repository.findSession(validated.sessionId);
    if (!session) throw new Error('session_not_found');
    return this.repository.createFeedback({
      ...validated,
      id: `feedback_${randomUUID()}`,
      createdAt: this.now().toISOString(),
    });
  }

  async listFeedback(memoryId: string): Promise<ListMemoryFeedbackOutput> {
    return { items: await this.repository.listFeedback(memoryId) };
  }

  async openSession(input: OpenSessionInput): Promise<OpenSessionOutput> {
    const validated = openSessionInputSchema.parse(input);
    const session = await this.repository.createSession({
      ...validated,
      areaIds: validated.areaIds ?? [],
    });
    return this.revisionMetadata(
      await this.repository.getCorpusRevision(),
      session.id,
      session.projectId,
      session.areaIds,
    );
  }

  async recordEvents(input: RecordEventsInput): Promise<RecordEventsOutput> {
    const validated = recordEventsInputSchema.parse(input);
    const result = await this.repository.appendEvents(validated);
    if (result.accepted.length === 0) {
      return {
        acceptedEventIds: [],
        duplicateEventIds: result.duplicates.map((event) => event.id),
        jobIds: [],
      };
    }
    const job = await this.repository.createJob({
      operation: 'memory_extraction',
      status: 'queued',
      sessionId: validated.sessionId,
    });
    return {
      acceptedEventIds: result.accepted.map((event) => event.id),
      duplicateEventIds: result.duplicates.map((event) => event.id),
      jobIds: [job.id],
    };
  }

  async proposeMemory(
    input: ProposeMemoryInput,
    context: ProposalContext = { actor: 'harness', explicitDirective: false },
  ): Promise<ProposalResult> {
    if (context.actor === 'harness' && context.explicitDirective) {
      throw new Error('harness_cannot_issue_owner_directive');
    }
    const validated = proposeMemoryInputSchema.parse(input);
    const session = await this.repository.findSession(validated.sessionId);
    if (!session || session.status !== 'open') throw new Error('session_not_open');
    if (!this.belongsToSession(validated.scope, session)) throw new Error('scope_not_available');
    const decision = decideProposal(validated, context.actor, context.explicitDirective);
    if (decision.status === 'rejected') return decision;
    const duplicate = (await this.repository.listMemoryViews()).find(
      (memory) =>
        (memory.record.lifecycle === 'accepted' ||
          memory.record.lifecycle === 'pending_approval') &&
        this.matchesScope(memory.current.scope, validated.scope) &&
        this.normalizedContent(memory.current.content) ===
          this.normalizedContent(validated.content),
    );
    if (duplicate) {
      const newSourceEventIds = validated.sourceEventIds.filter(
        (eventId) => !duplicate.current.sourceEventIds.includes(eventId),
      );
      if (newSourceEventIds.length === 0) {
        return {
          status: 'merged',
          memoryId: duplicate.record.id,
          proposalId: duplicate.record.id,
          reason: 'duplicate',
        };
      }
      await this.repository.mergeMemorySources(
        duplicate.record.id,
        duplicate.record.currentVersion,
        newSourceEventIds,
      );
      return {
        status: 'merged',
        memoryId: duplicate.record.id,
        proposalId: duplicate.record.id,
        reason: 'duplicate',
      };
    }
    const contradiction = (await this.repository.listMemoryViews()).find(
      (memory) =>
        memory.record.lifecycle === 'accepted' &&
        areDirectlyContradictory(memory.current, validated),
    );
    if (contradiction) {
      const record = await this.repository.createMemory(validated);
      await this.indexMemory(record.id, record.currentVersion, validated.content);
      await this.repository.updateMemoryLifecycle(record.id, 'pending_approval');
      const conflict = await this.repository.createConflict([contradiction.record.id, record.id]);
      return {
        status: 'pending_approval',
        memoryId: record.id,
        proposalId: record.id,
        conflictId: conflict.id,
        reason: 'direct_contradiction',
      };
    }
    const record = await this.repository.createMemory(validated);
    await this.indexMemory(record.id, record.currentVersion, validated.content);
    await this.repository.updateMemoryLifecycle(
      record.id,
      decision.status === 'accepted' ? 'accepted' : 'pending_approval',
    );
    return { ...decision, memoryId: record.id, proposalId: record.id };
  }

  async searchMemories(input: SearchMemoriesInput): Promise<MemoryRevision[]> {
    const validated = searchMemoriesInputSchema.parse(input);
    const session = await this.repository.findSession(validated.sessionId);
    if (!session) throw new Error('session_not_found');
    const scopes = await this.listScopesForSession(validated.sessionId);
    const analysis = analyzeQuery(validated.query);
    const revision = await this.repository.getCorpusRevision();
    const cacheKey = this.corpusCacheKey('search', {
      sessionId: validated.sessionId,
      query: validated.query,
      scope: validated.scope,
      offset: validated.offset,
      limit: validated.limit,
    });
    const cached = await this.cachedCorpusResult(cacheKey, revision);
    if (cached) {
      const revalidated = await this.revalidateCachedMemories(cached);
      if (revalidated) return revalidated;
    }
    if (analysis.terms.length === 0) {
      await this.cacheCorpusResult(cacheKey, [], revision);
      return [];
    }
    const ranked = await this.rankedCandidates({
      query: validated.query,
      analysis,
      scopes,
      limit: Math.max(validated.limit, validated.offset + validated.limit),
      scopeFilter: validated.scope,
    });
    const result = ranked
      .slice(validated.offset, validated.offset + validated.limit)
      .map((candidate) => candidate.memory);
    await this.cacheCorpusResult(cacheKey, result, revision);
    return result;
  }

  async resolveContext(input: ContextInput): Promise<ContextOutput> {
    const validated = contextInputSchema.parse(input);
    const session = await this.repository.findSession(validated.sessionId);
    if (!session || session.status !== 'open') throw new Error('session_not_open');
    const scopes = await this.listScopesForSession(validated.sessionId);
    const analysis = analyzeQuery(validated.query);
    const ranked =
      analysis.terms.length === 0
        ? []
        : await this.rankedCandidates({ query: validated.query, analysis, scopes, limit: 50 });
    const relevantCandidates = ranked.filter((candidate) => candidate.score >= minimumSearchScore);
    const selected: MemoryRevision[] = [];
    let usedTokens = 0;
    for (const { memory } of relevantCandidates) {
      const tokens = estimateMemoryTokens(memory);
      if (usedTokens + tokens <= validated.budgetTokens) {
        selected.push(memory);
        usedTokens += tokens;
      }
    }
    const revision = await this.repository.getCorpusRevision();
    const conflicts = await this.repository.listAllConflicts();
    const relevantMemoryIds = new Set(relevantCandidates.map(({ memory }) => memory.memoryId));
    const semanticAvailable =
      this.options.embeddingProvider !== undefined &&
      this.options.semanticSearchIndex !== undefined;
    return {
      context: selected,
      conflicts: conflicts
        .filter(
          (conflict) =>
            conflict.status === 'open' &&
            conflict.memoryIds.some((memoryId) => relevantMemoryIds.has(memoryId)),
        )
        .map((conflict) => ({
          id: conflict.id,
          type: conflict.type,
          memoryIds: conflict.memoryIds,
        })),
      requiredContextComplete: true,
      tokensEstimated: usedTokens,
      budgetTokens: validated.budgetTokens,
      excludedResults: Math.max(0, relevantCandidates.length - selected.length),
      serviceStatus: semanticAvailable ? 'available' : 'degraded',
      corpusRevision: `${revision.epoch}:${revision.revision}`,
      degradations: semanticAvailable
        ? []
        : [
            {
              component: 'embedding',
              missingCapability: 'semantic_search',
              impact: 'lexical_retrieval',
            },
          ],
    };
  }

  async closeSession(sessionId: string): Promise<{ jobId: string }> {
    await this.repository.closeSession(sessionId);
    const job = await this.repository.createJob({
      operation: 'session_consolidation',
      status: 'queued',
      sessionId,
    });
    return { jobId: job.id };
  }

  async getMemory(id: string): Promise<MemoryRevision | null> {
    const result = await this.repository.getMemory(id);
    if (!result || result.record.lifecycle !== 'accepted') return null;
    return result.current;
  }

  async reviewProposal(input: ReviewProposalInput): Promise<ReviewProposalOutput> {
    const validated = reviewProposalInputSchema.parse(input);
    const result = await this.repository.getMemory(validated.memoryId);
    if (!result) throw new Error('memory_not_found');
    if (result.record.lifecycle !== 'pending_approval') throw new Error('proposal_not_pending');
    if (result.record.currentVersion !== validated.expectedVersion) {
      throw new Error('memory_version_conflict');
    }
    if (validated.decision === 'reject') {
      await this.repository.updateMemoryLifecycle(validated.memoryId, 'rejected');
      return { memory: await this.view(validated.memoryId) };
    }
    const patch: MemoryPatch = {
      content: validated.finalContent ?? result.current.content,
      kind: validated.finalKind ?? result.current.kind,
      scope: validated.finalScope ?? result.current.scope,
      epistemicBasis: validated.finalEpistemicBasis ?? result.current.epistemicBasis,
      assessment: validated.finalAssessment ?? result.current.assessment,
      confidence:
        validated.finalConfidence === undefined
          ? result.current.confidence
          : validated.finalConfidence,
      sensitivity: validated.finalSensitivity ?? result.current.sensitivity,
      activation: validated.finalActivation ?? result.current.activation,
    };
    this.assertNotSecret(
      patch.content ?? result.current.content,
      patch.sensitivity ?? result.current.sensitivity,
    );
    const record = await this.repository.createRevision({
      memoryId: validated.memoryId,
      expectedVersion: validated.expectedVersion,
      content: patch.content ?? result.current.content,
      kind: patch.kind,
      scope: patch.scope,
      epistemicBasis: patch.epistemicBasis,
      assessment: patch.assessment,
      confidence: patch.confidence,
      sensitivity: patch.sensitivity,
      activation: patch.activation,
    });
    await this.indexMemory(
      record.id,
      record.currentVersion,
      patch.content ?? result.current.content,
    );
    return { memory: await this.view(validated.memoryId) };
  }

  async correctMemory(input: CorrectMemoryInput): Promise<CorrectMemoryOutput> {
    const validated = correctMemoryInputSchema.parse(input);
    const result = await this.repository.getMemory(validated.memoryId);
    if (!result) throw new Error('memory_not_found');
    if (result.record.lifecycle !== 'accepted') throw new Error('memory_not_active');
    this.assertNotSecret(validated.content, validated.sensitivity ?? result.current.sensitivity);
    const record = await this.repository.createRevision(validated);
    await this.indexMemory(record.id, record.currentVersion, validated.content);
    return { memory: await this.view(validated.memoryId) };
  }

  async retractMemory(memoryId: string, reason: string): Promise<MemoryView> {
    if (reason.trim().length === 0) throw new Error('invalid_reason');
    const result = await this.repository.getMemory(memoryId);
    if (!result) throw new Error('memory_not_found');
    if (result.record.lifecycle !== 'accepted') throw new Error('memory_not_active');
    await this.repository.updateMemoryLifecycle(memoryId, 'retracted');
    return this.view(memoryId);
  }

  async prepareForget(memoryId: string): Promise<PrepareForgetOutput> {
    const result = await this.repository.getMemory(memoryId);
    if (!result) throw new Error('memory_not_found');
    const expiresAt = new Date(this.now().getTime() + 5 * 60 * 1_000);
    const payload = Buffer.from(
      JSON.stringify({ memoryId, expiresAt: Math.floor(expiresAt.getTime() / 1_000) }),
    ).toString('base64url');
    const signature = this.signForgetPayload(payload);
    return {
      memoryId,
      confirmationToken: `${payload}.${signature}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async forgetMemory(memoryId: string, confirmationToken: string): Promise<void> {
    const [payload, signature] = confirmationToken.split('.');
    if (!payload || !signature) throw new Error('invalid_confirmation_token');
    const suppliedHash = Buffer.from(this.signForgetPayload(payload), 'base64url');
    const expectedHash = Buffer.from(signature, 'base64url');
    if (
      suppliedHash.length !== expectedHash.length ||
      !timingSafeEqual(suppliedHash, expectedHash)
    ) {
      throw new Error('invalid_confirmation_token');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as unknown;
    } catch {
      throw new Error('invalid_confirmation_token');
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('memoryId' in parsed) ||
      !('expiresAt' in parsed) ||
      parsed.memoryId !== memoryId ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.expiresAt <= Math.floor(this.now().getTime() / 1_000)
    ) {
      throw new Error('invalid_confirmation_token');
    }
    await this.options.semanticSearchIndex?.remove(memoryId);
    await this.repository.removeMemory(memoryId);
    try {
      await this.options.corpusCache?.clear();
    } catch {
      // The cache is derived; retention of the authoritative tombstone must not depend on Redis.
    }
  }

  async getJob(id: string): Promise<JobRecord | null> {
    return this.repository.getJob(id);
  }

  async listPendingProposals(input: ListPendingProposalsInput): Promise<PendingProposalsOutput> {
    const validated = listPendingProposalsInputSchema.parse(input);
    const session = await this.repository.findSession(validated.sessionId);
    if (!session) throw new Error('session_not_found');
    const records = await this.repository.listPendingMemories();
    const visible = await Promise.all(
      records.map(async (record) => {
        const memory = await this.repository.getMemory(record.id);
        if (!memory) return null;
        return this.viewFromRepository(memory.record, memory.current);
      }),
    );
    const items = visible
      .filter((memory): memory is MemoryView => memory !== null)
      .filter((memory) => this.belongsToSession(memory.scope, session));
    return {
      items: items.slice(validated.offset, validated.offset + validated.limit),
      limit: validated.limit,
      offset: validated.offset,
    };
  }

  async listAdminMemories(input: ListAdminMemoriesInput): Promise<AdminMemoriesOutput> {
    const validated = listAdminMemoriesInputSchema.parse(input);
    const memories = (await this.repository.listMemoryViews()).map((memory) =>
      this.viewFromRepository(memory.record, memory.current),
    );
    const query = validated.q.toLocaleLowerCase();
    const filtered = memories
      .filter((memory) => !validated.lifecycle || memory.lifecycle === validated.lifecycle)
      .filter((memory) => !validated.kind || memory.kind === validated.kind)
      .filter((memory) => !validated.scopeType || memory.scope.type === validated.scopeType)
      .filter((memory) => !validated.scopeId || memory.scope.id === validated.scopeId)
      .filter((memory) => query.length === 0 || memory.content.toLocaleLowerCase().includes(query));
    return {
      items: filtered.slice(validated.offset, validated.offset + validated.limit),
      total: filtered.length,
      limit: validated.limit,
      offset: validated.offset,
    };
  }

  async getMemoryAdminView(id: string): Promise<MemoryAdminView | null> {
    const memory = await this.repository.getMemory(id);
    if (!memory) return null;
    return {
      memory: this.viewFromRepository(memory.record, memory.current),
      revisions: await this.repository.listRevisions(id),
      conflicts: await this.repository.findConflicts(id),
    };
  }

  async listConflicts(): Promise<ConflictListOutput> {
    return { items: await this.repository.listAllConflicts() };
  }

  async resolveConflict(id: string): Promise<ConflictRecord> {
    return this.repository.resolveConflict(id);
  }

  async getAdminOverview(): Promise<AdminOverviewOutput> {
    const memories = (await this.repository.listMemoryViews()).map((memory) => memory.record);
    return {
      total: memories.length,
      accepted: memories.filter((memory) => memory.lifecycle === 'accepted').length,
      pendingApproval: memories.filter((memory) => memory.lifecycle === 'pending_approval').length,
      rejected: memories.filter((memory) => memory.lifecycle === 'rejected').length,
      retracted: memories.filter((memory) => memory.lifecycle === 'retracted').length,
      conflicts: (await this.repository.listAllConflicts()).length,
      corpusRevision: await this.getCorpusRevision(),
    };
  }

  async listAdminSessions(input: ListAdminSessionsInput): Promise<AdminSessionsOutput> {
    const validated = listAdminSessionsInputSchema.parse(input);
    const filtered = (await this.repository.listSessions())
      .filter((session) => !validated.projectId || session.projectId === validated.projectId)
      .filter((session) => !validated.status || session.status === validated.status);
    return {
      items: filtered
        .slice(validated.offset, validated.offset + validated.limit)
        .map((session) => this.sessionView(session)),
      total: filtered.length,
      limit: validated.limit,
      offset: validated.offset,
    };
  }

  async getAdminSessionDetail(sessionId: string): Promise<AdminSessionDetailOutput> {
    const session = await this.repository.findSession(sessionId);
    if (!session) throw new Error('session_not_found');
    return {
      session: this.sessionView(session),
      events: await this.repository.listEvents(sessionId),
      jobs: (await this.repository.listJobs(sessionId)).map((job) => this.jobView(job)),
    };
  }

  async listAdminJobs(input: ListAdminJobsInput): Promise<AdminJobsOutput> {
    const validated = listAdminJobsInputSchema.parse(input);
    const filtered = (await this.repository.listJobs()).filter(
      (job) => !validated.status || job.status === validated.status,
    );
    return {
      items: filtered
        .slice(validated.offset, validated.offset + validated.limit)
        .map((job) => this.jobView(job)),
      total: filtered.length,
      limit: validated.limit,
      offset: validated.offset,
    };
  }

  async listJobAttempts(jobId: string) {
    return this.repository.listJobAttempts(jobId);
  }

  async getRetentionStatus(): Promise<RetentionStatusOutput> {
    const state = await this.repository.getRetentionState();
    return {
      managed: true,
      profile: balancedRetentionPolicy.profile,
      policy: {
        closedEventDays: balancedRetentionPolicy.closedEventDays,
        pendingCandidateDays: balancedRetentionPolicy.pendingCandidateDays,
        rejectedCandidateDays: balancedRetentionPolicy.rejectedCandidateDays,
        supersededRevisionDays: balancedRetentionPolicy.supersededRevisionDays,
        retractedMemoryDays: balancedRetentionPolicy.retractedMemoryDays,
      },
      lastRunAt: state.lastRunAt,
    };
  }

  async runRetention(): Promise<RetentionRunOutput> {
    const startedAt = this.now();
    const days = (value: number) =>
      new Date(startedAt.getTime() - value * 24 * 60 * 60 * 1_000).toISOString();
    const cutoffs = {
      closedEvents: days(balancedRetentionPolicy.closedEventDays),
      pendingCandidates: days(balancedRetentionPolicy.pendingCandidateDays),
      rejectedCandidates: days(balancedRetentionPolicy.rejectedCandidateDays),
      supersededRevisions: days(balancedRetentionPolicy.supersededRevisionDays),
      retractedMemories: days(balancedRetentionPolicy.retractedMemoryDays),
    };
    const deleted = await this.repository.runBalancedRetention(cutoffs);
    const completedAt = this.now();
    await this.repository.recordRetentionRun(completedAt.toISOString());
    return {
      profile: balancedRetentionPolicy.profile,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      cutoffs,
      deleted,
    };
  }

  async consolidateSession(sessionId: string): Promise<SessionConsolidationOutput> {
    const session = await this.repository.findSession(sessionId);
    if (!session) throw new Error('session_not_found');
    if (session.status !== 'closed') throw new Error('session_not_closed');
    const events = await this.repository.listEvents(sessionId);
    const eventIds = new Set(events.map((event) => event.id));
    const candidates = (await this.repository.listMemoryViews()).filter(
      (memory) =>
        memory.record.lifecycle === 'pending_approval' &&
        memory.current.sourceEventIds.some((eventId) => eventIds.has(eventId)),
    );
    await this.consolidateDuplicateCandidates(candidates);
    const consolidatedCandidates = (await this.repository.listMemoryViews()).filter(
      (memory) =>
        memory.record.lifecycle === 'pending_approval' &&
        memory.current.sourceEventIds.some((eventId) => eventIds.has(eventId)),
    );
    const candidateIds = new Set(consolidatedCandidates.map((memory) => memory.record.id));
    const conflicts = (await this.repository.listAllConflicts()).filter((conflict) =>
      conflict.memoryIds.some((memoryId) => candidateIds.has(memoryId)),
    );
    return {
      sessionId,
      sourceEventCount: events.length,
      candidateCount: consolidatedCandidates.length,
      conflictCount: conflicts.length,
      acceptedMemories: 0,
    };
  }

  async listScopesForSession(sessionId: string): Promise<Scope[]> {
    const session = await this.repository.findSession(sessionId);
    if (!session) throw new Error('session_not_found');
    return [
      { type: 'session', id: session.id },
      { type: 'project', id: session.projectId },
      ...session.areaIds.map((id) => ({ type: 'area' as const, id })),
      { type: 'global', id: 'personal' },
    ];
  }

  async getCorpusRevision(): Promise<string> {
    const revision = await this.repository.getCorpusRevision();
    return `${revision.epoch}:${revision.revision}`;
  }

  private async consolidateDuplicateCandidates(candidates: MemoryWithCurrent[]): Promise<void> {
    const groups = new Map<string, MemoryWithCurrent[]>();
    for (const candidate of candidates) {
      const key = JSON.stringify([
        candidate.current.kind,
        candidate.current.scope.type,
        candidate.current.scope.id,
        this.normalizedContent(candidate.current.content),
      ]);
      const group = groups.get(key) ?? [];
      group.push(candidate);
      groups.set(key, group);
    }
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const ordered = [...group].sort((left, right) =>
        left.record.createdAt.localeCompare(right.record.createdAt),
      );
      const canonical = ordered[0];
      for (const duplicate of ordered.slice(1)) {
        const newSourceEventIds = duplicate.current.sourceEventIds.filter(
          (eventId) => !canonical.current.sourceEventIds.includes(eventId),
        );
        const consolidated = await this.repository.consolidateDuplicateCandidate({
          canonicalId: canonical.record.id,
          canonicalVersion: canonical.record.currentVersion,
          duplicateId: duplicate.record.id,
          duplicateVersion: duplicate.record.currentVersion,
          sourceEventIds: newSourceEventIds,
        });
        if (!consolidated) continue;
        const refreshed = await this.repository.getMemory(canonical.record.id);
        if (!refreshed) throw new Error('memory_not_found');
        canonical.record = refreshed.record;
        canonical.current = refreshed.current;
      }
    }
  }

  private assertNotSecret(content: string, sensitivity: string): void {
    if (sensitivity === 'secret' || containsSecret(content)) {
      throw new Error('sensitive_content');
    }
  }

  private async rankedCandidates(input: {
    query: string;
    analysis: QueryAnalysis;
    scopes: Scope[];
    limit: number;
    scopeFilter?: Scope;
  }): Promise<
    Array<{
      memory: MemoryRevision;
      lexicalScore: number;
      semanticScore: number;
      score: number;
    }>
  > {
    const candidateLimit = Math.min(1000, Math.max(200, input.limit * 20));
    const lexicalCandidates = this.repository.searchCurrentMemories
      ? await this.repository.searchCurrentMemories({
          query: input.analysis.tsQuery,
          limit: candidateLimit,
          scopes: input.scopes,
        })
      : await this.repository.listCurrentMemories();
    const eligible = lexicalCandidates
      .filter((memory) => input.scopes.some((scope) => this.matchesScope(memory.scope, scope)))
      .filter((memory) => !input.scopeFilter || this.matchesScope(memory.scope, input.scopeFilter));
    const byId = new Map(eligible.map((memory) => [memory.memoryId, memory]));
    const semanticHits = await this.semanticHits(input.query, candidateLimit);
    const semanticById = new Map(semanticHits.map((hit) => [hit.memoryId, hit.score]));
    const missingIds = semanticHits
      .filter((hit) => hit.score >= minimumSemanticScore)
      .map((hit) => hit.memoryId)
      .filter((memoryId) => !byId.has(memoryId));
    if (missingIds.length > 0) {
      const semanticMemories = this.repository.getCurrentMemoriesByIds
        ? await this.repository.getCurrentMemoriesByIds(missingIds)
        : [];
      for (const memory of semanticMemories) {
        if (
          input.scopes.some((scope) => this.matchesScope(memory.scope, scope)) &&
          (!input.scopeFilter || this.matchesScope(memory.scope, input.scopeFilter))
        ) {
          byId.set(memory.memoryId, memory);
        }
      }
    }
    const lexicalStats = buildLexicalCorpusStats(
      input.analysis,
      [...byId.values()].map((memory) => ({ content: memory.content })),
    );
    return [...byId.values()]
      .map((memory) => {
        const lexicalScore = lexicalRelevance(input.analysis, memory.content, lexicalStats);
        const semanticScore = semanticById.get(memory.memoryId) ?? 0;
        return {
          memory,
          lexicalScore,
          semanticScore,
          score: combineSearchScores(lexicalScore, semanticScore),
        };
      })
      .filter((candidate) => candidate.score >= minimumSearchScore)
      .sort(
        (left, right) =>
          right.score - left.score || left.memory.memoryId.localeCompare(right.memory.memoryId),
      );
  }

  private async revalidateCachedMemories(
    cached: MemoryRevision[],
  ): Promise<MemoryRevision[] | null> {
    const current = await Promise.all(
      cached.map((memory) => this.repository.getMemory(memory.memoryId)),
    );
    const revisions: MemoryRevision[] = [];
    for (const value of current) {
      if (!value || value.record.lifecycle !== 'accepted') return null;
      revisions.push(value.current);
    }
    return revisions;
  }

  private async indexMemory(memoryId: string, revision: number, content: string): Promise<void> {
    const provider = this.options.embeddingProvider;
    const index = this.options.semanticSearchIndex;
    if (!provider || !index) return;
    if (provider.profile !== index.profile || provider.dimensions !== index.dimensions) {
      throw new Error('semantic_search_profile_mismatch');
    }
    await index.upsert({ memoryId, revision, embedding: await provider.embed(content) });
  }

  private async semanticHits(query: string, limit: number) {
    const provider = this.options.embeddingProvider;
    const index = this.options.semanticSearchIndex;
    if (!provider || !index || limit < 1) return [];
    try {
      const hits = await index.search({ embedding: await provider.embed(query), limit });
      return hits.filter((hit) => hit.score > 0.05);
    } catch (error) {
      if (process.env.NODE_ENV !== 'test') {
        const code = error instanceof Error ? error.message : 'unknown_error';
        console.debug(`semantic_search_unavailable:${code.replace(/[^A-Za-z0-9_.:-]/gu, '_')}`);
      }
      return [];
    }
  }

  private corpusCacheKey(kind: string, value: unknown): string {
    const digest = createHash('sha256').update(this.stableCacheValue(value)).digest('base64url');
    return `${corpusCacheKeyPrefix}${kind}:${digest}`;
  }

  private async cachedCorpusResult(
    key: string,
    revision: CorpusRevision,
  ): Promise<MemoryRevision[] | null> {
    const cache = this.options.corpusCache;
    if (!cache) return null;
    try {
      const value = await cache.get(key);
      if (value === null) return null;
      const parsed = JSON.parse(value) as { revision?: unknown; result?: unknown };
      if (parsed.revision !== `${revision.epoch}:${revision.revision}`) return null;
      const result = memoryRevisionSchema.array().safeParse(parsed.result);
      return result.success ? result.data : null;
    } catch {
      return null;
    }
  }

  private async cacheCorpusResult(
    key: string,
    result: unknown,
    revision: CorpusRevision,
  ): Promise<void> {
    const cache = this.options.corpusCache;
    if (!cache) return;
    try {
      await cache.set(
        key,
        JSON.stringify({ revision: `${revision.epoch}:${revision.revision}`, result }),
        this.options.corpusCacheTtlSeconds ?? 300,
      );
    } catch {
      return;
    }
  }

  private stableCacheValue(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value))
      return `[${value.map((item) => this.stableCacheValue(item)).join(',')}]`;
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${this.stableCacheValue(record[key])}`)
      .join(',')}}`;
  }

  private validateRestoreExport(value: CorpusExport): void {
    const sessionIds = new Set<string>();
    for (const session of value.sessions) {
      if (sessionIds.has(session.id)) throw new Error('restore_invalid_export');
      sessionIds.add(session.id);
    }

    const eventKeys = new Set<string>();
    for (const event of value.events) {
      const key = `${event.sessionId}:${event.id}`;
      if (!sessionIds.has(event.sessionId) || eventKeys.has(key)) {
        throw new Error('restore_invalid_export');
      }
      eventKeys.add(key);
    }

    const memoryIds = new Set<string>();
    for (const memory of value.memories) {
      if (memoryIds.has(memory.record.id)) throw new Error('restore_invalid_export');
      memoryIds.add(memory.record.id);
    }
    const revisionKeys = new Set<string>();
    for (const item of value.revisions) {
      const key = `${item.memoryId}:${item.revision.version}`;
      if (
        !memoryIds.has(item.memoryId) ||
        item.revision.memoryId !== item.memoryId ||
        revisionKeys.has(key)
      ) {
        throw new Error('restore_invalid_export');
      }
      revisionKeys.add(key);
    }
    for (const memory of value.memories) {
      if (
        memory.current.memoryId !== memory.record.id ||
        memory.current.version !== memory.record.currentVersion ||
        !revisionKeys.has(`${memory.record.id}:${memory.record.currentVersion}`)
      ) {
        throw new Error('restore_invalid_export');
      }
    }

    const jobIds = new Set<string>();
    for (const job of value.jobs) {
      if (jobIds.has(job.id) || !sessionIds.has(job.sessionId)) {
        throw new Error('restore_invalid_export');
      }
      jobIds.add(job.id);
    }
    const attemptIds = new Set<string>();
    for (const attempt of value.jobAttempts) {
      if (attemptIds.has(attempt.id) || !jobIds.has(attempt.jobId)) {
        throw new Error('restore_invalid_export');
      }
      attemptIds.add(attempt.id);
    }
    const conflictIds = new Set<string>();
    for (const conflict of value.conflicts) {
      if (
        conflictIds.has(conflict.id) ||
        conflict.memoryIds.some((memoryId) => !memoryIds.has(memoryId))
      ) {
        throw new Error('restore_invalid_export');
      }
      conflictIds.add(conflict.id);
    }
    const ledgerIds = new Set<string>();
    for (const entry of value.forgetLedger) {
      if (ledgerIds.has(entry.memoryId)) throw new Error('restore_invalid_export');
      ledgerIds.add(entry.memoryId);
    }
  }

  private sessionView(session: SessionRecord) {
    return {
      id: session.id,
      projectId: session.projectId,
      areaIds: session.areaIds,
      taskTitle: session.taskTitle,
      sequence: session.sequence,
      status: session.status,
      createdAt: session.createdAt,
      closedAt: session.closedAt,
    };
  }

  private jobView(job: JobRecord) {
    return {
      id: job.id,
      operation: job.operation,
      status: job.status,
      sessionId: job.sessionId,
      availableAt: job.availableAt,
      leaseOwner: job.leaseOwner,
      leaseExpiresAt: job.leaseExpiresAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private async view(memoryId: string): Promise<MemoryView> {
    const result = await this.repository.getMemory(memoryId);
    if (!result) throw new Error('memory_not_found');
    return this.viewFromRepository(result.record, result.current);
  }

  private viewFromRepository(record: MemoryRecord, revision: MemoryRevision): MemoryView {
    return {
      ...revision,
      lifecycle: record.lifecycle,
      currentVersion: record.currentVersion,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }

  private belongsToSession(scope: Scope, session: SessionRecord): boolean {
    return (
      this.matchesScope(scope, { type: 'session', id: session.id }) ||
      this.matchesScope(scope, { type: 'project', id: session.projectId }) ||
      (scope.type === 'area' && session.areaIds.includes(scope.id)) ||
      this.matchesScope(scope, { type: 'global', id: 'personal' })
    );
  }

  private revisionMetadata(
    revision: CorpusRevision,
    sessionId: string,
    projectId: string,
    areaIds: string[],
  ): OpenSessionOutput {
    return {
      sessionId,
      projectId,
      areaIds,
      corpusRevision: `${revision.epoch}:${revision.revision}`,
    };
  }

  private matchesScope(left: Scope, right: Scope): boolean {
    return left.type === right.type && left.id === right.id;
  }

  private lexicalScore(memory: MemoryRevision, terms: string[]): number {
    const content = memory.content.toLocaleLowerCase();
    return terms.reduce((score, term) => score + (content.includes(term) ? 1 : 0), 0);
  }

  private normalizedContent(content: string): string {
    return content.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
  }

  private signForgetPayload(payload: string): string {
    return createHmac('sha256', this.options.forgetSecret).update(payload).digest('base64url');
  }
}
