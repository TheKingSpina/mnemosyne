import {
  contextInputSchema,
  correctMemoryInputSchema,
  listPendingProposalsInputSchema,
  openSessionInputSchema,
  proposeMemoryInputSchema,
  recordEventsInputSchema,
  reviewProposalInputSchema,
  searchMemoriesInputSchema,
  type ContextInput,
  type ContextOutput,
  type CorrectMemoryInput,
  type CorrectMemoryOutput,
  type ListPendingProposalsInput,
  type MemoryPatch,
  type MemoryRevision,
  type MemoryView,
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
  type Scope,
  type SearchMemoriesInput,
} from '@mnemosyne/contracts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { containsSecret, decideProposal } from './policy.js';
import { estimateMemoryTokens } from './token-estimator.js';
import type {
  CorpusRevision,
  JobRecord,
  MemoryRecord,
  MemoryRepository,
  MemoryService,
  ProposalContext,
  SessionRecord,
} from './types.js';

export interface CoreMemoryServiceOptions {
  forgetSecret: string;
  now?: () => Date;
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
    const record = await this.repository.createMemory(validated);
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
    const memories = await this.repository.listCurrentMemories();
    const terms = validated.query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    return memories
      .filter((memory) => scopes.some((scope) => this.matchesScope(memory.scope, scope)))
      .filter((memory) => !validated.scope || this.matchesScope(memory.scope, validated.scope))
      .filter((memory) => terms.some((term) => memory.content.toLocaleLowerCase().includes(term)))
      .slice(validated.offset, validated.offset + validated.limit);
  }

  async resolveContext(input: ContextInput): Promise<ContextOutput> {
    const validated = contextInputSchema.parse(input);
    const session = await this.repository.findSession(validated.sessionId);
    if (!session || session.status !== 'open') throw new Error('session_not_open');
    const scopes = await this.listScopesForSession(validated.sessionId);
    const memories = await this.repository.listCurrentMemories();
    const queryTerms = validated.query.toLocaleLowerCase().split(/\s+/u).filter(Boolean);
    const candidates = memories
      .filter((memory) => scopes.some((scope) => this.matchesScope(memory.scope, scope)))
      .map((memory) => ({ memory, score: this.lexicalScore(memory, queryTerms) }))
      .filter(({ score }) => score > 0)
      .sort(
        (left, right) =>
          right.score - left.score || left.memory.memoryId.localeCompare(right.memory.memoryId),
      );
    const selected: MemoryRevision[] = [];
    let usedTokens = 0;
    for (const { memory } of candidates) {
      const tokens = estimateMemoryTokens(memory);
      if (usedTokens + tokens <= validated.budgetTokens) {
        selected.push(memory);
        usedTokens += tokens;
      }
    }
    const revision = await this.repository.getCorpusRevision();
    return {
      context: selected,
      conflicts: [],
      requiredContextComplete: true,
      tokensEstimated: usedTokens,
      budgetTokens: validated.budgetTokens,
      excludedResults: Math.max(0, candidates.length - selected.length),
      serviceStatus: 'available',
      corpusRevision: `${revision.epoch}:${revision.revision}`,
      degradations: [],
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
    await this.repository.createRevision({
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
    return { memory: await this.view(validated.memoryId) };
  }

  async correctMemory(input: CorrectMemoryInput): Promise<CorrectMemoryOutput> {
    const validated = correctMemoryInputSchema.parse(input);
    const result = await this.repository.getMemory(validated.memoryId);
    if (!result) throw new Error('memory_not_found');
    if (result.record.lifecycle !== 'accepted') throw new Error('memory_not_active');
    this.assertNotSecret(validated.content, validated.sensitivity ?? result.current.sensitivity);
    await this.repository.createRevision(validated);
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
    await this.repository.removeMemory(memoryId);
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

  private assertNotSecret(content: string, sensitivity: string): void {
    if (sensitivity === 'secret' || containsSecret(content)) {
      throw new Error('sensitive_content');
    }
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

  private signForgetPayload(payload: string): string {
    return createHmac('sha256', this.options.forgetSecret).update(payload).digest('base64url');
  }
}
