import { describe, expect, it } from 'vitest';
import {
  CoreMemoryService,
  DeterministicEmbeddingProvider,
  InMemoryRepository,
  InMemoryCorpusCache,
  InMemorySemanticSearchIndex,
} from './index.js';

const projectScope = { type: 'project' as const, id: 'memory-service' };
const personalScope = { type: 'project' as const, id: 'personal' };

function createService() {
  return new CoreMemoryService(new InMemoryRepository(), {
    forgetSecret: 'a-secure-test-secret-that-is-long-enough',
  });
}

function createSearchService() {
  const provider = new DeterministicEmbeddingProvider(32);
  const semanticSearchIndex = new InMemorySemanticSearchIndex({
    profile: provider.profile,
    dimensions: provider.dimensions,
  });
  return {
    service: new CoreMemoryService(new InMemoryRepository(), {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
      embeddingProvider: provider,
      semanticSearchIndex,
    }),
  };
}

async function proposeAccepted(
  service: CoreMemoryService,
  sessionId: string,
  content: string,
): Promise<string> {
  const result = await service.proposeMemory(
    {
      sessionId,
      content,
      kind: 'fact',
      scope: projectScope,
      epistemicBasis: 'verified',
      assessment: 'uncontested',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: [],
    },
    { actor: 'owner', explicitDirective: true },
  );
  if (result.status !== 'accepted' || !result.memoryId) throw new Error('fixture_not_accepted');
  return result.memoryId;
}

describe('CoreMemoryService', () => {
  it('stores an explicit project memory and returns it in a later session', async () => {
    const service = createService();
    const firstSession = await service.openSession({ projectId: 'memory-service' });
    const proposed = await service.proposeMemory(
      {
        sessionId: firstSession.sessionId,
        content: 'Il progetto usa pnpm',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'observed',
        assessment: 'uncontested',
        confidence: 0.98,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );

    expect(proposed.status).toBe('accepted');
    expect(proposed.memoryId).toBeDefined();

    const secondSession = await service.openSession({ projectId: 'memory-service' });
    const context = await service.resolveContext({
      sessionId: secondSession.sessionId,
      query: 'Quale package manager usa il progetto?',
      budgetTokens: 1_200,
    });

    expect(context.context.map((memory) => memory.content)).toContain('Il progetto usa pnpm');
    expect(context.context[0]?.version).toBe(1);
  });

  it('ranks specific matches first and returns no results without a match', async () => {
    const { service } = createSearchService();
    const session = await service.openSession({ projectId: 'memory-service' });
    await proposeAccepted(service, session.sessionId, 'Il database del gateway API usa PostgreSQL');
    await proposeAccepted(
      service,
      session.sessionId,
      'Il gateway API usa una cache Redis per le risposte',
    );
    await proposeAccepted(service, session.sessionId, 'Il worker usa una coda PostgreSQL');

    const ranked = await service.searchMemories({
      sessionId: session.sessionId,
      query: 'cache Redis',
      limit: 3,
      offset: 0,
    });
    expect(ranked[0]?.content).toBe('Il gateway API usa una cache Redis per le risposte');
    expect(ranked.some((memory) => memory.content.includes('coda PostgreSQL'))).toBe(false);

    const noMatch = await service.searchMemories({
      sessionId: session.sessionId,
      query: 'zzzqqqxyz',
      limit: 10,
      offset: 0,
    });
    expect(noMatch).toEqual([]);
  });
  it('does not expose a pending personal preference until review', async () => {
    const service = createService();
    const session = await service.openSession({ projectId: 'memory-service' });
    const proposed = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Preferisco risposte concise',
        kind: 'preference',
        scope: personalScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'private',
        activation: 'always',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: false },
    );

    expect(proposed.status).toBe('pending_approval');
    const context = await service.resolveContext({
      sessionId: session.sessionId,
      query: 'Preferisco risposte',
      budgetTokens: 1_200,
    });
    expect(context.context).toEqual([]);

    const reviewed = await service.reviewProposal({
      memoryId: proposed.memoryId!,
      expectedVersion: 1,
      decision: 'accept',
    });
    expect(reviewed.memory.lifecycle).toBe('accepted');

    const afterReview = await service.resolveContext({
      sessionId: session.sessionId,
      query: 'Preferisco risposte',
      budgetTokens: 1_200,
    });
    expect(afterReview.context.map((memory) => memory.content)).toContain(
      'Preferisco risposte concise',
    );
  });

  it('treats duplicate events as idempotent and does not create a second job', async () => {
    const service = createService();
    const session = await service.openSession({ projectId: 'memory-service' });
    const input = {
      sessionId: session.sessionId,
      events: [
        {
          eventId: 'evt_1',
          type: 'message' as const,
          role: 'user' as const,
          content: 'Ricorda che questo progetto usa pnpm',
          occurredAt: '2026-01-20T10:00:00Z',
          explicitMemoryRequest: true,
        },
      ],
    };

    const first = await service.recordEvents(input);
    const second = await service.recordEvents(input);

    expect(first.acceptedEventIds).toEqual(['evt_1']);
    expect(first.jobIds).toHaveLength(1);
    expect(second.acceptedEventIds).toEqual([]);
    expect(second.duplicateEventIds).toEqual(['evt_1']);
    expect(second.jobIds).toEqual([]);
  });

  it('versions a correction and removes the memory from context after forget', async () => {
    const service = createService();
    const session = await service.openSession({ projectId: 'memory-service' });
    const proposed = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa npm',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    const memoryId = proposed.memoryId!;

    const corrected = await service.correctMemory({
      memoryId,
      expectedVersion: 1,
      content: 'Il progetto usa pnpm',
    });
    expect(corrected.memory.version).toBe(2);
    expect(corrected.memory.content).toBe('Il progetto usa pnpm');

    const prepared = await service.prepareForget(memoryId);
    await service.forgetMemory(memoryId, prepared.confirmationToken);

    const context = await service.resolveContext({
      sessionId: session.sessionId,
      query: 'package manager',
      budgetTokens: 1_200,
    });
    expect(context.context).toEqual([]);
    expect(await service.getMemory(memoryId)).toBeNull();
  });

  it('rejects secret-like content', async () => {
    const service = createService();
    const session = await service.openSession({ projectId: 'memory-service' });
    const result = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'api_key=sk-12345678901234567890',
        kind: 'fact',
        scope: projectScope,
        epistemicBasis: 'observed',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );

    expect(result).toEqual({ status: 'rejected', reason: 'sensitive_content' });
  });

  it('does not let a harness mark an inference as an owner directive', async () => {
    const service = createService();
    const session = await service.openSession({ projectId: 'memory-service' });
    const result = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa Bun',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'inferred',
        assessment: 'uncontested',
        confidence: 0.7,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'harness', explicitDirective: false },
    );

    expect(result.status).toBe('pending_approval');
  });

  it('does not promote a project assertion without an explicit owner directive', async () => {
    const service = createService();
    const session = await service.openSession({ projectId: 'memory-service' });
    const result = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa Deno',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'observed',
        assessment: 'uncontested',
        confidence: 0.9,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: false },
    );

    expect(result.status).toBe('pending_approval');
  });

  it('merges an equivalent proposal into the existing memory and preserves sources', async () => {
    const service = createService();
    const session = await service.openSession({ projectId: 'memory-service' });
    const first = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa pnpm',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'observed',
        assessment: 'uncontested',
        confidence: 0.9,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: ['event-1'],
      },
      { actor: 'owner', explicitDirective: true },
    );

    const duplicate = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: '  il   progetto usa PNPM  ',
        kind: 'fact',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: ['event-2', 'event-1'],
      },
      { actor: 'owner', explicitDirective: false },
    );
    const merged = await service.getMemoryAdminView(first.memoryId!);

    expect(duplicate).toMatchObject({
      status: 'merged',
      memoryId: first.memoryId,
      proposalId: first.memoryId,
      reason: 'duplicate',
    });
    expect(merged?.memory.currentVersion).toBe(2);
    expect(merged?.revisions[0]?.sourceEventIds).toEqual(['event-1', 'event-2']);
  });

  it('does not create a new revision when duplicate sources are already known', async () => {
    const service = createService();
    const session = await service.openSession({ projectId: 'memory-service' });
    const first = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa pnpm',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'observed',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: ['event-1'],
      },
      { actor: 'owner', explicitDirective: true },
    );

    const duplicate = await service.proposeMemory({
      sessionId: session.sessionId,
      content: 'Il progetto usa pnpm',
      kind: 'convention',
      scope: projectScope,
      epistemicBasis: 'user_asserted',
      assessment: 'uncontested',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: ['event-1'],
    });
    const merged = await service.getMemoryAdminView(first.memoryId!);

    expect(duplicate.status).toBe('merged');
    expect(merged?.memory.currentVersion).toBe(1);
  });

  it('records a contradiction and keeps the new candidate pending', async () => {
    const service = createService();
    const session = await service.openSession({ projectId: 'memory-service' });
    const accepted = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa pnpm',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: ['event-1'],
      },
      { actor: 'owner', explicitDirective: true },
    );

    const contradiction = await service.proposeMemory({
      sessionId: session.sessionId,
      content: 'Il progetto non usa pnpm',
      kind: 'convention',
      scope: projectScope,
      epistemicBasis: 'user_asserted',
      assessment: 'disputed',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: ['event-2'],
    });
    const conflicts = await service.listConflicts();
    const pending = await service.getMemoryAdminView(contradiction.memoryId!);

    expect(contradiction).toMatchObject({
      status: 'pending_approval',
      reason: 'direct_contradiction',
    });
    expect(typeof contradiction.conflictId).toBe('string');
    expect(conflicts.items[0]?.memoryIds).toEqual([accepted.memoryId, contradiction.memoryId]);
    expect(pending?.memory.lifecycle).toBe('pending_approval');
  });

  it('removes conflicts when a memory is forgotten and keeps the export restorable', async () => {
    const service = createService();
    const session = await service.openSession({ projectId: 'memory-service' });
    const accepted = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa pnpm',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    const contradiction = await service.proposeMemory({
      sessionId: session.sessionId,
      content: 'Il progetto non usa pnpm',
      kind: 'convention',
      scope: projectScope,
      epistemicBasis: 'user_asserted',
      assessment: 'disputed',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: [],
    });
    const prepared = await service.prepareForget(contradiction.memoryId!);
    await service.forgetMemory(contradiction.memoryId!, prepared.confirmationToken);

    const exportValue = await service.listCorpusExport();
    const target = createService();
    const restored = await target.restoreCorpus(exportValue);

    expect((await service.listConflicts()).items).toEqual([]);
    expect(exportValue.conflicts).toEqual([]);
    expect(restored.restored.conflicts).toBe(0);
    expect(await target.getMemory(accepted.memoryId!)).not.toBeNull();
  });

  it('keeps a multi-memory conflict when one remaining member is forgotten', async () => {
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
    });
    const session = await service.openSession({ projectId: 'memory-service' });
    const memories: string[] = [];
    for (const content of ['Memoria A', 'Memoria B', 'Memoria C']) {
      const result = await service.proposeMemory(
        {
          sessionId: session.sessionId,
          content,
          kind: 'fact',
          scope: projectScope,
          epistemicBasis: 'user_asserted',
          assessment: 'uncontested',
          confidence: 1,
          sensitivity: 'normal',
          activation: 'on_demand',
          sourceEventIds: [],
        },
        { actor: 'owner', explicitDirective: true },
      );
      memories.push(result.memoryId!);
    }
    await repository.createConflict(memories);
    const prepared = await service.prepareForget(memories[0]);
    await service.forgetMemory(memories[0], prepared.confirmationToken);

    const remaining = await service.listConflicts();
    expect(remaining.items[0]?.memoryIds).toEqual([memories[1], memories[2]]);
  });

  it('includes a relevant open conflict in resolved context metadata', async () => {
    const service = createService();
    const session = await service.openSession({ projectId: 'memory-service' });
    await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa pnpm',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: ['event-1'],
      },
      { actor: 'owner', explicitDirective: true },
    );
    const contradiction = await service.proposeMemory({
      sessionId: session.sessionId,
      content: 'Il progetto non usa pnpm',
      kind: 'convention',
      scope: projectScope,
      epistemicBasis: 'user_asserted',
      assessment: 'disputed',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: ['event-2'],
    });

    const context = await service.resolveContext({
      sessionId: session.sessionId,
      query: 'pnpm',
      budgetTokens: 1_200,
    });

    expect(context.conflicts).toHaveLength(1);
    expect(context.conflicts[0]?.id).toBe(contradiction.conflictId);
    expect(context.conflicts[0]?.type).toBe('direct_contradiction');
    expect(context.conflicts[0]?.memoryIds).toContain(contradiction.memoryId);
  });

  it('includes memory conflicts in the owner memory detail', async () => {
    const service = createService();
    const session = await service.openSession({ projectId: 'memory-service' });
    const accepted = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa pnpm',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    const contradiction = await service.proposeMemory({
      sessionId: session.sessionId,
      content: 'Il progetto non usa pnpm',
      kind: 'convention',
      scope: projectScope,
      epistemicBasis: 'user_asserted',
      assessment: 'disputed',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: [],
    });

    const acceptedDetail = await service.getMemoryAdminView(accepted.memoryId!);
    const pendingDetail = await service.getMemoryAdminView(contradiction.memoryId!);

    expect(acceptedDetail?.conflicts[0]?.id).toBe(contradiction.conflictId);
    expect(acceptedDetail?.conflicts[0]?.type).toBe('direct_contradiction');
    expect(pendingDetail?.conflicts[0]?.memoryIds).toContain(accepted.memoryId);
  });

  it('rejects an owner directive context supplied by a harness', async () => {
    const service = createService();
    const session = await service.openSession({ projectId: 'memory-service' });

    await expect(
      service.proposeMemory(
        {
          sessionId: session.sessionId,
          content: 'Il progetto usa pnpm',
          kind: 'convention',
          scope: projectScope,
          epistemicBasis: 'observed',
          assessment: 'uncontested',
          confidence: 1,
          sensitivity: 'normal',
          activation: 'on_demand',
          sourceEventIds: [],
        },
        { actor: 'harness', explicitDirective: true },
      ),
    ).rejects.toThrow('harness_cannot_issue_owner_directive');
  });

  it('lists administrative sessions, events, and jobs with stable views', async () => {
    const service = createService();
    const session = await service.openSession({ projectId: 'memory-service' });
    const events = await service.recordEvents({
      sessionId: session.sessionId,
      events: [
        {
          eventId: 'evt_admin_1',
          type: 'message',
          role: 'user',
          content: 'Messaggio sintetico',
          occurredAt: '2026-01-20T10:00:00Z',
          explicitMemoryRequest: true,
        },
      ],
    });

    const sessions = await service.listAdminSessions({
      projectId: 'memory-service',
      limit: 20,
      offset: 0,
    });
    const detail = await service.getAdminSessionDetail(session.sessionId);
    const jobs = await service.listAdminJobs({ status: 'queued', limit: 20, offset: 0 });

    expect(sessions).toMatchObject({ total: 1, items: [{ id: session.sessionId }] });
    expect(detail.events[0]?.id).toBe('evt_admin_1');
    expect(detail.jobs[0]?.id).toBe(events.jobIds[0]);
    expect(jobs.total).toBe(1);
  });

  it('exports canonical corpus data and the forget ledger', async () => {
    const service = createService();
    const session = await service.openSession({ projectId: 'memory-service' });
    await service.recordEvents({
      sessionId: session.sessionId,
      events: [
        {
          eventId: 'evt_export',
          type: 'message',
          role: 'user',
          content: 'Ricorda che il progetto usa pnpm',
          occurredAt: '2026-01-20T10:00:00Z',
          explicitMemoryRequest: true,
        },
      ],
    });
    const proposed = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa npm',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: ['evt_export'],
      },
      { actor: 'owner', explicitDirective: true },
    );
    const prepared = await service.prepareForget(proposed.memoryId!);
    await service.forgetMemory(proposed.memoryId!, prepared.confirmationToken);

    const exportValue = await service.listCorpusExport();

    expect(exportValue).toMatchObject({
      schemaVersion: 1,
      sessions: [{ id: session.sessionId }],
      events: [{ id: 'evt_export' }],
      memories: [],
      revisions: [],
      jobs: [{ operation: 'memory_extraction', status: 'queued' }],
      jobAttempts: [],
      forgetLedger: [{ memoryId: proposed.memoryId }],
    });
  });

  it('runs the balanced retention policy with deterministic cutoffs', async () => {
    let now = new Date('2026-09-01T12:00:00.000Z');
    const repository = new InMemoryRepository(() => now);
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
      now: () => now,
    });
    const session = await service.openSession({ projectId: 'memory-service' });
    await service.recordEvents({
      sessionId: session.sessionId,
      events: [
        {
          eventId: 'evt_retention',
          type: 'message',
          role: 'user',
          content: 'Messaggio sintetico da conservare',
          occurredAt: now.toISOString(),
          explicitMemoryRequest: false,
        },
      ],
    });
    await service.closeSession(session.sessionId);
    now = new Date('2026-09-24T12:00:00.000Z');
    const statusBefore = await service.getRetentionStatus();
    const result = await service.runRetention();
    const statusAfter = await service.getRetentionStatus();

    expect(statusBefore.lastRunAt).toBeUndefined();
    expect(result.profile).toBe('balanced');
    expect(result.cutoffs.closedEvents).toBe('2026-08-25T12:00:00.000Z');
    expect(result.deleted.closedSessionEvents).toBe(0);
    expect(statusAfter.lastRunAt).toBe(now.toISOString());
    expect((await repository.listAllEvents()).map((event) => event.id)).toEqual(['evt_retention']);
    expect((await repository.listAllJobs()).length).toBe(2);
  });

  it('removes expired candidates and retracted memories while retaining the forget ledger', async () => {
    let now = new Date('2026-01-20T12:00:00.000Z');
    const repository = new InMemoryRepository(() => now);
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
      now: () => now,
    });
    const session = await service.openSession({ projectId: 'memory-service' });
    await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Preferisco risposte concise',
        kind: 'preference',
        scope: personalScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'private',
        activation: 'always',
        sourceEventIds: [],
      },
      { actor: 'harness', explicitDirective: false },
    );
    const retracted = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa pnpm',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    await service.retractMemory(retracted.memoryId!, 'test sintetico');
    const forgotten = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Memoria dimenticata sintetica',
        kind: 'fact',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    const prepared = await service.prepareForget(forgotten.memoryId!);
    await service.forgetMemory(forgotten.memoryId!, prepared.confirmationToken);
    now = new Date('2026-09-24T12:00:00.000Z');
    const result = await service.runRetention();
    const memories = await service.listAdminMemories({
      q: '',
      limit: 100,
      offset: 0,
    });
    const status = await service.getRetentionStatus();

    expect(result.deleted.pendingCandidates).toBe(1);
    expect(result.deleted.retractedMemories).toBe(1);
    expect(memories.items).toEqual([]);
    expect(status.lastRunAt).toBe(now.toISOString());
    expect((await repository.listForgetLedger()).map((entry) => entry.memoryId)).toEqual([
      forgotten.memoryId,
    ]);
  });

  it('deletes only superseded revisions older than the retention cutoff', async () => {
    let now = new Date('2026-01-01T12:00:00.000Z');
    const repository = new InMemoryRepository(() => now);
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
      now: () => now,
    });
    const session = await service.openSession({ projectId: 'memory-service' });
    const proposed = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa npm',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    await service.correctMemory({
      memoryId: proposed.memoryId!,
      expectedVersion: 1,
      content: 'Il progetto usa pnpm',
    });
    now = new Date('2026-03-01T12:00:00.000Z');
    await service.correctMemory({
      memoryId: proposed.memoryId!,
      expectedVersion: 2,
      content: 'Il progetto usa npm workspaces',
    });
    now = new Date('2026-12-01T12:00:00.000Z');

    const result = await service.runRetention();
    const detail = await service.getMemoryAdminView(proposed.memoryId!);
    const exported = await service.listCorpusExport();

    expect(result.deleted.supersededRevisions).toBe(2);
    expect(detail?.memory).toMatchObject({
      currentVersion: 3,
      content: 'Il progetto usa npm workspaces',
    });
    expect(detail?.revisions.map((revision) => revision.version)).toEqual([3]);
    expect(exported.revisions.map((item) => item.revision.version)).toEqual([3]);
  });

  it('preserves a recent superseded revision and the current revision', async () => {
    let now = new Date('2026-11-01T12:00:00.000Z');
    const repository = new InMemoryRepository(() => now);
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
      now: () => now,
    });
    const session = await service.openSession({ projectId: 'memory-service' });
    const proposed = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa npm',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    now = new Date('2026-12-01T12:00:00.000Z');
    await service.correctMemory({
      memoryId: proposed.memoryId!,
      expectedVersion: 1,
      content: 'Il progetto usa pnpm',
    });

    const result = await service.runRetention();
    const detail = await service.getMemoryAdminView(proposed.memoryId!);

    expect(result.deleted.supersededRevisions).toBe(0);
    expect(detail?.revisions.map((revision) => revision.version)).toEqual([2, 1]);
  });

  it('restores a canonical export while protecting forgotten memories', async () => {
    const sourceRepository = new InMemoryRepository();
    const sourceService = new CoreMemoryService(sourceRepository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
    });
    const session = await sourceService.openSession({ projectId: 'memory-service' });
    const forgotten = await sourceService.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Memoria dimenticata da non reimportare',
        kind: 'fact',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    const retained = await sourceService.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Memoria da ripristinare',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    const prepared = await sourceService.prepareForget(forgotten.memoryId!);
    await sourceService.forgetMemory(forgotten.memoryId!, prepared.confirmationToken);
    const exportValue = await sourceService.listCorpusExport();
    const protectedExport = {
      ...exportValue,
      memories: [
        ...exportValue.memories,
        {
          record: {
            id: forgotten.memoryId!,
            projectId: 'memory-service',
            currentVersion: 1,
            lifecycle: 'accepted' as const,
            privacy: null,
            createdAt: '2026-01-20T10:00:00.000Z',
            updatedAt: '2026-01-20T10:00:00.000Z',
          },
          current: {
            memoryId: forgotten.memoryId!,
            version: 1,
            content: 'Memoria dimenticata da non reimportare',
            kind: 'fact' as const,
            scope: projectScope,
            epistemicBasis: 'user_asserted' as const,
            assessment: 'uncontested' as const,
            confidence: 1,
            sensitivity: 'normal' as const,
            activation: 'on_demand' as const,
            sourceEventIds: [],
          },
        },
      ],
      revisions: [
        ...exportValue.revisions,
        {
          memoryId: forgotten.memoryId!,
          revision: {
            memoryId: forgotten.memoryId!,
            version: 1,
            content: 'Memoria dimenticata da non reimportare',
            kind: 'fact' as const,
            scope: projectScope,
            epistemicBasis: 'user_asserted' as const,
            assessment: 'uncontested' as const,
            confidence: 1,
            sensitivity: 'normal' as const,
            activation: 'on_demand' as const,
            sourceEventIds: [],
          },
        },
      ],
    };
    const targetService = new CoreMemoryService(new InMemoryRepository(), {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
    });

    const beforeRestore = await targetService.getCorpusRevision();
    const result = await targetService.restoreCorpus(protectedExport);
    const afterRestore = await targetService.getCorpusRevision();
    const restored = await targetService.listAdminMemories({ q: '', limit: 100, offset: 0 });

    expect(result.skipped).toEqual({
      forgottenMemories: 1,
      forgottenRevisions: 1,
      forgottenConflicts: 0,
    });
    expect(restored.items.map((memory) => memory.content)).toEqual(['Memoria da ripristinare']);
    expect((await targetService.getMemory(retained.memoryId!))?.content).toBe(
      'Memoria da ripristinare',
    );
    expect(afterRestore).not.toBe(beforeRestore);
    expect(afterRestore.endsWith(':1')).toBe(true);
  });

  it('consolidates duplicate pending candidates without accepting them', async () => {
    let now = new Date('2026-01-20T10:00:00.000Z');
    const repository = new InMemoryRepository(() => now);
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
      now: () => now,
    });
    const session = await service.openSession({ projectId: 'memory-service' });
    await service.recordEvents({
      sessionId: session.sessionId,
      events: [
        {
          eventId: 'consolidation-event-1',
          type: 'message',
          role: 'user',
          content: 'Ricorda che il progetto usa pnpm',
          occurredAt: '2026-01-20T10:00:00.000Z',
          explicitMemoryRequest: true,
        },
        {
          eventId: 'consolidation-event-2',
          type: 'message',
          role: 'user',
          content: 'Ricorda che il progetto usa pnpm',
          occurredAt: '2026-01-20T10:01:00.000Z',
          explicitMemoryRequest: true,
        },
      ],
    });
    const first = await repository.createMemory({
      projectId: 'memory-service',
      sessionId: session.sessionId,
      content: 'Il progetto usa pnpm',
      kind: 'convention',
      scope: projectScope,
      epistemicBasis: 'user_asserted',
      assessment: 'uncontested',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: ['consolidation-event-1'],
    });
    const duplicate = await repository.createMemory({
      projectId: 'memory-service',
      sessionId: session.sessionId,
      content: 'il progetto usa PNPM',
      kind: 'convention',
      scope: projectScope,
      epistemicBasis: 'user_asserted',
      assessment: 'uncontested',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: ['consolidation-event-2'],
    });
    await service.closeSession(session.sessionId);
    now = new Date('2026-01-20T10:02:00.000Z');

    const result = await service.consolidateSession(session.sessionId);
    const canonical = await service.getMemoryAdminView(first.id);
    const rejected = await service.getMemoryAdminView(duplicate.id);

    expect(result).toMatchObject({ candidateCount: 1, conflictCount: 0, acceptedMemories: 0 });
    expect(canonical?.memory.currentVersion).toBe(2);
    expect(canonical?.revisions[0]?.sourceEventIds).toEqual([
      'consolidation-event-1',
      'consolidation-event-2',
    ]);
    expect(rejected?.memory.lifecycle).toBe('rejected');
  });

  it('does not reject a candidate accepted during consolidation', async () => {
    const repository = new InMemoryRepository();
    const canonical = await repository.createMemory({
      projectId: 'memory-service',
      sessionId: 'synthetic-session',
      content: 'Il progetto usa pnpm',
      kind: 'convention',
      scope: projectScope,
      epistemicBasis: 'user_asserted',
      assessment: 'uncontested',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: ['canonical-event'],
    });
    const duplicate = await repository.createMemory({
      projectId: 'memory-service',
      sessionId: 'synthetic-session',
      content: 'il progetto usa PNPM',
      kind: 'convention',
      scope: projectScope,
      epistemicBasis: 'user_asserted',
      assessment: 'uncontested',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: ['duplicate-event'],
    });
    await repository.updateMemoryLifecycle(duplicate.id, 'accepted');

    const consolidated = await repository.consolidateDuplicateCandidate({
      canonicalId: canonical.id,
      canonicalVersion: 1,
      duplicateId: duplicate.id,
      duplicateVersion: 1,
      sourceEventIds: ['duplicate-event'],
    });

    expect(consolidated).toBe(false);
    expect((await repository.getMemory(duplicate.id))?.record.lifecycle).toBe('accepted');
    expect((await repository.getMemory(canonical.id))?.record.currentVersion).toBe(1);
  });

  it('uses the semantic index when available and removes forgotten entries', async () => {
    const provider = new DeterministicEmbeddingProvider(32);
    const index = new InMemorySemanticSearchIndex({ dimensions: 32 });
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
      embeddingProvider: provider,
      semanticSearchIndex: index,
    });
    const session = await service.openSession({ projectId: 'memory-service' });
    const proposed = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa pnpm per i test sintetici',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );

    const found = await service.searchMemories({
      sessionId: session.sessionId,
      query: 'pnpm sintetici',
      limit: 5,
      offset: 0,
    });
    const prepared = await service.prepareForget(proposed.memoryId!);
    await service.forgetMemory(proposed.memoryId!, prepared.confirmationToken);
    const afterForget = await index.search({
      embedding: await provider.embed(found[0]?.content ?? ''),
      limit: 5,
    });

    expect(found[0]?.content).toBe('Il progetto usa pnpm per i test sintetici');
    expect(afterForget).toEqual([]);
  });

  it('falls back to lexical retrieval when the semantic index is unavailable', async () => {
    const provider = new DeterministicEmbeddingProvider(32);
    const repository = new InMemoryRepository();
    const unavailableIndex = {
      profile: provider.profile,
      dimensions: provider.dimensions,
      upsert: async () => undefined,
      remove: async () => undefined,
      search: async () => {
        throw new Error('semantic_index_unavailable');
      },
      countByProfile: async () => {
        throw new Error('semantic_index_unavailable');
      },
    };
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
      embeddingProvider: provider,
      semanticSearchIndex: unavailableIndex,
    });
    const session = await service.openSession({ projectId: 'memory-service' });
    await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa pnpm per i test sintetici',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );

    const found = await service.searchMemories({
      sessionId: session.sessionId,
      query: 'pnpm',
      limit: 5,
      offset: 0,
    });

    expect(found[0]?.content).toBe('Il progetto usa pnpm per i test sintetici');
  });

  it('uses the derived cache only when the corpus revision still matches', async () => {
    const repository = new InMemoryRepository();
    const cache = new InMemoryCorpusCache();
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
      corpusCache: cache,
    });
    const session = await service.openSession({ projectId: 'memory-service' });
    await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Memoria cacheata sintetica',
        kind: 'fact',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    const first = await service.searchMemories({
      sessionId: session.sessionId,
      query: 'cacheata',
      limit: 5,
      offset: 0,
    });
    await service.openSession({ projectId: 'memory-service' });
    const second = await service.searchMemories({
      sessionId: session.sessionId,
      query: 'cacheata',
      limit: 5,
      offset: 0,
    });

    expect(first[0]?.content).toBe('Memoria cacheata sintetica');
    expect(second[0]?.content).toBe('Memoria cacheata sintetica');
  });

  it('clears the derived corpus cache after a confirmed forget', async () => {
    const repository = new InMemoryRepository();
    let clearCalls = 0;
    const cache = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
      clear: async () => {
        clearCalls += 1;
      },
    };
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
      corpusCache: cache,
    });
    const session = await service.openSession({ projectId: 'memory-service' });
    const proposed = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Memoria da dimenticare',
        kind: 'fact',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    const prepared = await service.prepareForget(proposed.memoryId!);

    await service.forgetMemory(proposed.memoryId!, prepared.confirmationToken);

    expect(clearCalls).toBe(1);
  });

  it('records non-destructive feedback without changing memory lifecycle', async () => {
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
      now: () => new Date('2026-09-24T12:00:00.000Z'),
    });
    const session = await service.openSession({ projectId: 'memory-service' });
    const proposed = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Memoria con feedback sintetico',
        kind: 'fact',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    const feedback = await service.submitFeedback({
      memoryId: proposed.memoryId!,
      sessionId: session.sessionId,
      kind: 'useful',
      observedAt: '2026-09-24T12:00:00.000Z',
    });
    const current = await service.getMemoryAdminView(proposed.memoryId!);
    const listed = await service.listFeedback(proposed.memoryId!);

    expect(feedback).toMatchObject({ memoryId: proposed.memoryId, kind: 'useful' });
    expect(current?.memory.lifecycle).toBe('accepted');
    expect(listed.items).toEqual([feedback]);
  });

  it('does not claim the same outbox event before its lease expires', async () => {
    let now = new Date('2026-01-20T10:00:00.000Z');
    const repository = new InMemoryRepository(() => now);
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
      now: () => now,
    });
    const session = await service.openSession({ projectId: 'memory-service' });
    await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Memoria con evento derivato',
        kind: 'fact',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );

    const first = await repository.claimOutboxEvents(10, 'projection-a', 1_000);
    const second = await repository.claimOutboxEvents(10, 'projection-b', 1_000);
    now = new Date('2026-01-20T10:00:01.001Z');
    const afterExpiry = await repository.claimOutboxEvents(10, 'projection-b', 1_000);

    expect(first?.events).toHaveLength(2);
    expect(second).toBeNull();
    expect(afterExpiry?.consumerId).toBe('projection-b');
    expect(afterExpiry?.events.map((event) => event.id)).toEqual(
      first?.events.map((event) => event.id),
    );
    await expect(repository.markOutboxProcessed(first!)).rejects.toThrow('outbox_claim_lost');
    await repository.markOutboxProcessed(afterExpiry!);
    expect(await repository.claimOutboxEvents(10, 'projection-c', 1_000)).toBeNull();
  });

  it('orders memory lifecycle events before conflict projection events', async () => {
    let now = new Date('2026-01-20T10:00:00.000Z');
    const repository = new InMemoryRepository(() => now);
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
      now: () => now,
    });
    const session = await service.openSession({ projectId: 'memory-service' });
    await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'il progetto usa npm',
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    now = new Date('2026-01-20T10:01:00.000Z');
    const contradiction = await service.proposeMemory({
      sessionId: session.sessionId,
      content: 'il progetto non usa npm',
      kind: 'convention',
      scope: projectScope,
      epistemicBasis: 'user_asserted',
      assessment: 'disputed',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: [],
    });
    const claim = await repository.claimOutboxEvents(100, 'projection-test', 10_000);
    const events = claim?.events ?? [];
    const conflictIndex = events.findIndex(
      (event) => event.eventType === 'memory.conflict.created',
    );
    const memoryLifecycleIndexes = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.aggregateId === contradiction.memoryId)
      .map(({ index }) => index);

    expect(conflictIndex).toBeGreaterThanOrEqual(0);
    expect(memoryLifecycleIndexes.every((index) => index < conflictIndex)).toBe(true);
  });
});

describe('admin capabilities', () => {
  const forgetSecret = 'a-secure-test-secret-that-is-long-enough';

  function createReportingService(
    overrides: {
      now?: () => Date;
      runtimeCapabilityTtlSeconds?: number;
    } = {},
  ) {
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, {
      forgetSecret,
      now: overrides.now,
      runtimeCapabilityTtlSeconds: overrides.runtimeCapabilityTtlSeconds,
    });
    return { repository, service };
  }

  it('reports nothing it cannot observe instead of guessing', async () => {
    const { service } = createReportingService();

    const capabilities = await service.getAdminCapabilities();

    expect(capabilities.workerObservedAt).toBeNull();
    expect(capabilities.extraction.localExtractor).toBeNull();
    expect(capabilities.projections.neo4j).toBeNull();
    expect(capabilities.operations.retentionManaged).toBeNull();
    expect(capabilities.gaps.map((gap) => gap.field)).toContain('projections.neo4j');
  });

  it('reports worker-owned capabilities from a fresh heartbeat', async () => {
    const { repository, service } = createReportingService();
    const reportedAt = new Date().toISOString();
    await repository.reportRuntimeCapabilities(
      'worker',
      {
        neo4jConfigured: true,
        openRouterConfigured: false,
        extractionProvider: 'local',
        retentionScheduled: true,
      },
      reportedAt,
    );

    const capabilities = await service.getAdminCapabilities();

    expect(capabilities.workerObservedAt).toBe(reportedAt);
    expect(capabilities.extraction).toEqual({
      localExtractor: true,
      openRouterConfigured: false,
      extractionProvider: 'local',
    });
    expect(capabilities.projections.neo4j).toBe(true);
    expect(capabilities.operations.retentionManaged).toBe(true);
    expect(capabilities.gaps.map((gap) => gap.field)).not.toContain('projections.neo4j');
  });

  it('distinguishes a disabled projection from an unobserved one', async () => {
    const { repository, service } = createReportingService();
    await repository.reportRuntimeCapabilities(
      'worker',
      {
        neo4jConfigured: false,
        openRouterConfigured: false,
        extractionProvider: 'local',
        retentionScheduled: true,
      },
      new Date().toISOString(),
    );

    const capabilities = await service.getAdminCapabilities();

    expect(capabilities.projections.neo4j).toBe(false);
    expect(capabilities.gaps.map((gap) => gap.field)).not.toContain('projections.neo4j');
  });

  it('stops trusting the worker heartbeat once it goes stale', async () => {
    let clock = new Date('2026-09-27T10:00:00.000Z');
    const { repository, service } = createReportingService({
      now: () => clock,
      runtimeCapabilityTtlSeconds: 300,
    });
    await repository.reportRuntimeCapabilities(
      'worker',
      {
        neo4jConfigured: true,
        openRouterConfigured: false,
        extractionProvider: 'local',
        retentionScheduled: true,
      },
      clock.toISOString(),
    );

    clock = new Date(clock.getTime() + 299_000);
    expect((await service.getAdminCapabilities()).projections.neo4j).toBe(true);

    clock = new Date(clock.getTime() + 2_000);
    const stale = await service.getAdminCapabilities();
    expect(stale.projections.neo4j).toBeNull();
    expect(stale.workerObservedAt).toBeNull();
    expect(stale.gaps.find((gap) => gap.field === 'projections.neo4j')?.reason).toContain(
      'no worker heartbeat within 300s',
    );
  });

  it('always reports backup verification as unobservable', async () => {
    const { repository, service } = createReportingService();
    await repository.reportRuntimeCapabilities(
      'worker',
      {
        neo4jConfigured: true,
        openRouterConfigured: true,
        extractionProvider: 'openrouter',
        retentionScheduled: true,
      },
      new Date().toISOString(),
    );

    const capabilities = await service.getAdminCapabilities();

    expect(capabilities.operations.backupVerified).toBeNull();
    expect(
      capabilities.gaps.find((gap) => gap.field === 'operations.backupVerified')?.reason,
    ).toContain('outside this process');
  });

  it('never reports an openrouter provider without a configured key', async () => {
    const { repository, service } = createReportingService();
    await repository.reportRuntimeCapabilities(
      'worker',
      {
        neo4jConfigured: false,
        openRouterConfigured: false,
        extractionProvider: 'openrouter',
        retentionScheduled: true,
      },
      new Date().toISOString(),
    );

    const capabilities = await service.getAdminCapabilities();

    expect(capabilities.extraction.openRouterConfigured).toBe(false);
    expect(capabilities.extraction.extractionProvider).toBe('openrouter');
  });
});

describe('embedding index health and reindex', () => {
  const forgetSecret = 'a-secure-test-secret-that-is-long-enough';

  function createIndexedService() {
    const provider = new DeterministicEmbeddingProvider(32);
    const semanticSearchIndex = new InMemorySemanticSearchIndex({
      profile: provider.profile,
      dimensions: provider.dimensions,
    });
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, {
      forgetSecret,
      embeddingProvider: provider,
      semanticSearchIndex,
    });
    return { provider, semanticSearchIndex, repository, service };
  }

  async function seedAccepted(service: CoreMemoryService, contents: string[]): Promise<void> {
    const session = await service.openSession({ projectId: 'reindex' });
    for (const content of contents) {
      const result = await service.proposeMemory(
        {
          sessionId: session.sessionId,
          content,
          kind: 'convention',
          scope: { type: 'project', id: 'reindex' },
          epistemicBasis: 'user_asserted',
          assessment: 'uncontested',
          confidence: 1,
          sensitivity: 'normal',
          activation: 'on_demand',
          sourceEventIds: [],
        },
        { actor: 'owner', explicitDirective: true },
      );
      expect(result.status).toBe('accepted');
    }
    await service.closeSession(session.sessionId);
  }

  it('reports a healthy index when every memory is embedded', async () => {
    const { service } = createIndexedService();
    await seedAccepted(service, ['il progetto usa pnpm', 'il progetto usa node']);

    const health = await service.getEmbeddingIndexHealth();

    expect(health.available).toBe(true);
    expect(health.profile).toBe('deterministic-v1');
    expect(health.memoryCount).toBe(2);
    expect(health.indexedForActiveProfile).toBe(2);
    expect(health.missingCount).toBe(0);
    expect(health.needsReindex).toBe(false);
  });

  it('detects the gap left by a corpus restore', async () => {
    const provider = new DeterministicEmbeddingProvider(32);
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, { forgetSecret });
    await seedAccepted(service, ['il progetto usa pnpm']);
    await service.closeSession((await service.openSession({ projectId: 'reindex' })).sessionId);

    // Same corpus, but the index the API owns is a fresh empty one: this is what
    // a restore looks like, since restoreCorpus never rebuilds embeddings.
    const rebuilt = new CoreMemoryService(new InMemoryRepository(), { forgetSecret });
    const restored = await rebuilt.restoreCorpus(await service.listCorpusExport());
    expect(restored.restored.memories).toBe(1);

    const withEmptyIndex = new CoreMemoryService(repository, {
      forgetSecret,
      embeddingProvider: provider,
      semanticSearchIndex: new InMemorySemanticSearchIndex({
        profile: provider.profile,
        dimensions: provider.dimensions,
      }),
    });
    const before = await withEmptyIndex.getEmbeddingIndexHealth();
    expect(before.memoryCount).toBe(1);
    expect(before.indexedForActiveProfile).toBe(0);
    expect(before.missingCount).toBe(1);
    expect(before.needsReindex).toBe(true);

    const result = await withEmptyIndex.reindexEmbeddings();
    expect(result).toEqual({ scanned: 1, indexed: 1 });

    const after = await withEmptyIndex.getEmbeddingIndexHealth();
    expect(after.missingCount).toBe(0);
    expect(after.needsReindex).toBe(false);
  });

  it('fails loudly instead of reporting an empty success when no provider exists', async () => {
    const service = new CoreMemoryService(new InMemoryRepository(), { forgetSecret });
    await seedAccepted(service, ['il progetto usa pnpm']);

    await expect(service.reindexEmbeddings()).rejects.toThrow('semantic_search_unavailable');
    expect((await service.getEmbeddingIndexHealth()).available).toBe(false);
  });

  it('is idempotent across repeated reindexes', async () => {
    const { service } = createIndexedService();
    await seedAccepted(service, ['il progetto usa pnpm', 'il progetto usa node']);

    const first = await service.reindexEmbeddings();
    const second = await service.reindexEmbeddings();

    expect(first).toEqual(second);
    const health = await service.getEmbeddingIndexHealth();
    expect(health.missingCount).toBe(0);
  });
});

describe('capability provenance', () => {
  it('defaults to an explicit unspecified reporter rather than a silent one', async () => {
    const service = new CoreMemoryService(new InMemoryRepository(), {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
    });

    const capabilities = await service.getAdminCapabilities();

    expect(capabilities.reporter).toBe('unspecified');
  });

  it('names the process that answered', async () => {
    const service = new CoreMemoryService(new InMemoryRepository(), {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
      reporter: 'mcp',
    });

    const capabilities = await service.getAdminCapabilities();

    expect(capabilities.reporter).toBe('mcp');
  });
});

describe('project privacy marking', () => {
  const secret = 'a-secure-test-secret-that-is-long-enough';
  const create = () => new CoreMemoryService(new InMemoryRepository(), { forgetSecret: secret });

  it('provisions projects as local_only and marks them manually', async () => {
    const service = create();
    const session = await service.openSession({ projectId: 'marked' });
    expect((await service.listProjects()).find((p) => p.id === 'marked')?.privacy).toBe(
      'local_only',
    );

    const marked = await service.setProjectPrivacy('marked', 'public');
    expect(marked.privacy).toBe('public');
    await expect(service.setProjectPrivacy('missing', 'public')).rejects.toThrow(
      'project_not_found',
    );
    expect(session.sessionId.startsWith('ses_')).toBe(true);
  });

  it('stores the node override at propose time and defaults to null', async () => {
    const service = create();
    const session = await service.openSession({ projectId: 'marked' });
    async function propose(content: string, privacy?: 'public' | 'anonymized') {
      const result = await service.proposeMemory(
        {
          sessionId: session.sessionId,
          content,
          kind: 'fact',
          scope: { type: 'project', id: 'marked' },
          epistemicBasis: 'verified',
          assessment: 'uncontested',
          confidence: 1,
          sensitivity: 'normal',
          activation: 'on_demand',
          sourceEventIds: [],
          ...(privacy === undefined ? {} : { privacy }),
        },
        { actor: 'owner', explicitDirective: true },
      );
      if (result.status !== 'accepted' || !result.memoryId) throw new Error('not_accepted');
      return result.memoryId;
    }
    const withOverride = await propose('contenuto pubblico', 'public');
    const withoutOverride = await propose('contenuto ereditato');

    const repository = (service as unknown as { repository: InMemoryRepository }).repository;
    expect((await repository.getMemory(withOverride))?.record.privacy).toBe('public');
    expect((await repository.getMemory(withoutOverride))?.record.privacy).toBeNull();
  });
});

describe('deterministic pruning inside the retention run', () => {
  const pruneSecret = 'a-secure-test-secret-that-is-long-enough';
  let now: Date;
  // One clock for both layers: the repository stamps updatedAt with its own
  // clock, so time travel has to move both or records never age.
  const createDatedService = (repository: InMemoryRepository) =>
    new CoreMemoryService(repository, { forgetSecret: pruneSecret, now: () => now });

  async function acceptedMemory(
    service: CoreMemoryService,
    sessionId: string,
    content: string,
    kind: 'episode' | 'fact',
    scope: { type: 'project'; id: string },
  ) {
    const result = await service.proposeMemory(
      {
        sessionId,
        content,
        kind,
        scope,
        epistemicBasis: 'verified',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    if (result.status !== 'accepted' || !result.memoryId) {
      throw new Error(`proposal_not_accepted:${result.status}`);
    }
    return result.memoryId;
  }

  it('expires decayed memories, prunes weak arcs, and keeps the rest', async () => {
    now = new Date('2026-10-16T12:00:00.000Z');
    const repository = new InMemoryRepository(() => now);
    const service = createDatedService(repository);
    const first = await service.openSession({ projectId: 'prune-p1' });
    // Provisions the second project; the binding itself is never read.
    await service.openSession({ projectId: 'prune-p2' });

    const oldEpisode = await acceptedMemory(
      service,
      first.sessionId,
      'ricordo della vecchia sede',
      'episode',
      { type: 'project', id: 'prune-p1' },
    );
    const keeper = await acceptedMemory(service, first.sessionId, 'legge fondamentale', 'fact', {
      type: 'project',
      id: 'prune-p1',
    });

    // Eight years pass: the episode decays below threshold, the fact is exempt.
    now = new Date('2034-10-16T12:00:00.000Z');
    const fresh = await acceptedMemory(service, first.sessionId, 'novita di oggi', 'episode', {
      type: 'project',
      id: 'prune-p1',
    });
    const weak = await service.proposeMemoryArc(
      { fromMemoryId: keeper, toMemoryId: fresh, type: 'cita', weight: 0.05 },
      { actor: 'owner', explicitDirective: false },
    );
    if (!('arcId' in weak)) throw new Error('expected_a_memory_arc');
    const structural = await service.proposeProjectArc(
      { fromProjectId: 'prune-p1', toProjectId: 'prune-p2', type: 'sotto-progetto', weight: 0.05 },
      { actor: 'owner', explicitDirective: false },
    );
    if (!('arcId' in structural)) throw new Error('expected_a_project_arc');
    // A fresh pending proposal is none of the job's business.
    await service.proposeMemory(
      {
        sessionId: first.sessionId,
        content: 'appena proposta',
        kind: 'episode',
        scope: { type: 'project', id: 'prune-p1' },
        epistemicBasis: 'verified',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'harness', explicitDirective: false },
    );

    const run = await service.runRetention();

    expect(run.pruning.memoriesExpired).toBe(1);
    expect(run.pruning.arcsPruned).toBe(1);
    expect(run.pruning.proposalsWritten).toBe(2);
    expect(run.pruning.stale).toBe(0);
    expect((await repository.getMemory(oldEpisode))?.record.lifecycle).toBe('expired');
    expect((await repository.getMemory(keeper))?.record.lifecycle).toBe('accepted');
    expect((await repository.getMemory(fresh))?.record.lifecycle).toBe('accepted');
    // The weak arc is gone, the weak hierarchical one stays: hierarchy is
    // never restructured by weight.
    expect(await repository.listAllMemoryArcs()).toHaveLength(0);
    expect(await repository.listAllProjectArcs()).toHaveLength(1);
    const ledger = await repository.listPruningLedger();
    expect(ledger.map((entry) => entry.reason).sort()).toEqual(['decay', 'edge_weight']);
    expect(await repository.listPruningProposals('accepted')).toHaveLength(2);
  });
});

describe('pruning analysis entry point', () => {
  const secret = 'a-secure-test-secret-that-is-long-enough';

  async function acceptedEpisode(
    service: CoreMemoryService,
    sessionId: string,
    content: string,
    privacy?: 'public' | 'anonymized' | 'local_only',
    projectId = 'analysis-p1',
  ) {
    const result = await service.proposeMemory(
      {
        sessionId,
        content,
        kind: 'episode',
        scope: { type: 'project', id: projectId },
        epistemicBasis: 'verified',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
        ...(privacy === undefined ? {} : { privacy }),
      },
      { actor: 'owner', explicitDirective: true },
    );
    if (result.status !== 'accepted' || !result.memoryId) throw new Error('not_accepted');
    return result.memoryId;
  }

  it('answers disabled without an analyzer, never an error', async () => {
    const service = new CoreMemoryService(new InMemoryRepository(), { forgetSecret: secret });
    expect(await service.runPruningAnalysis()).toEqual({
      status: 'disabled',
      batches: 0,
      proposalsWritten: 0,
      skipped: { batches: 0, proposals: 0 },
      reason: 'analyzer_not_configured',
    });
  });

  it('batches by flag, drops local_only, and drops hallucinated ids', async () => {
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, { forgetSecret: secret });
    const session = await service.openSession({ projectId: 'analysis-p1' });
    await service.setProjectPrivacy('analysis-p1', 'public');
    const pub = await acceptedEpisode(service, session.sessionId, 'memoria pubblica', 'public');
    const anon = await acceptedEpisode(service, session.sessionId, 'memoria anonima', 'anonymized');
    // No override would inherit the marked project, so the local case pins
    // local_only explicitly: override wins downward too.
    const local = await acceptedEpisode(service, session.sessionId, 'memoria locale', 'local_only');
    const seen: string[] = [];
    const analyzer = {
      modelVersion: 'test-model',
      analyze: async (batch: { privacy: string; items: Array<{ memoryId: string }> }) => {
        seen.push(`${batch.privacy}:${batch.items.map((item) => item.memoryId).join(',')}`);
        return {
          candidates: [
            {
              proposalType: 'redundancy' as const,
              sourceIds: [pub],
              rationale: 'duplicato',
              confidence: 0.7,
            },
            {
              proposalType: 'redundancy' as const,
              sourceIds: [pub, 'mem_inventata'],
              rationale: 'sembrano uguali',
              confidence: 0.7,
            },
          ],
          promptHash: 'abc123',
        };
      },
    };

    const run = await service.runPruningAnalysis(analyzer);

    // Two batches (public + anonymized), the local memory in neither. A
    // candidate touching one invented id is dropped whole: partial
    // hallucinations do not execute.
    expect(run).toMatchObject({ status: 'ran', batches: 2, proposalsWritten: 1 });
    expect(seen.sort()).toEqual([`anonymized:${anon}`, `public:${pub}`]);
    const proposals = await repository.listPruningProposals();
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      proposer: 'llm',
      proposalType: 'redundancy',
      sourceIds: [pub],
      modelVersion: 'test-model',
      promptHash: 'abc123',
    });
    expect(local).toBeDefined();
  });

  it('recognizes its own past: same members, batch skipped, no re-proposals', async () => {
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, { forgetSecret: secret });
    const session = await service.openSession({ projectId: 'analysis-p1' });
    await service.setProjectPrivacy('analysis-p1', 'public');
    const pub = await acceptedEpisode(service, session.sessionId, 'memoria pubblica');
    const analyzer = {
      modelVersion: 'test-model',
      analyze: async () => ({
        candidates: [
          {
            proposalType: 'redundancy' as const,
            sourceIds: [pub],
            rationale: 'duplicato',
            confidence: 0.7,
          },
        ],
        promptHash: 'abc123',
      }),
    };

    const first = await service.runPruningAnalysis(analyzer);
    expect(first).toMatchObject({ status: 'ran', batches: 1, proposalsWritten: 1 });

    // The only memory is now pending, so it is excluded from composition:
    // with nothing to compose the run is empty, never a re-ask.
    const second = await service.runPruningAnalysis(analyzer);
    expect(second).toMatchObject({
      status: 'ran',
      batches: 0,
      proposalsWritten: 0,
      skipped: { batches: 0, proposals: 0 },
    });
    expect((await repository.listPruningProposals()).map((p) => p.status)).toEqual(['pending']);
  });

  it('skips an already analyzed batch even after its proposal was decided', async () => {
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, { forgetSecret: secret });
    const session = await service.openSession({ projectId: 'analysis-p1' });
    await service.setProjectPrivacy('analysis-p1', 'public');
    const pub = await acceptedEpisode(service, session.sessionId, 'memoria pubblica');
    const analyzer = {
      modelVersion: 'test-model',
      analyze: async () => ({
        candidates: [
          {
            proposalType: 'redundancy' as const,
            sourceIds: [pub],
            rationale: 'duplicato',
            confidence: 0.7,
          },
        ],
        promptHash: 'abc123',
      }),
    };

    const first = await service.runPruningAnalysis(analyzer);
    expect(first.proposalsWritten).toBe(1);
    // The decide step rejects the redundancy proposal (no deterministic
    // basis): the ask was registered, the model must not re-ask tonight.
    await service.runRetention();

    const second = await service.runPruningAnalysis(analyzer);

    expect(second).toMatchObject({
      status: 'ran',
      batches: 0,
      proposalsWritten: 0,
      skipped: { batches: 1, proposals: 0 },
    });
    const decided = await repository.listPruningProposals();
    expect(decided).toHaveLength(1);
    expect(decided[0].status).toBe('rejected');
  });

  it('keeps memories with a pending proposal of any proposer out of the batches', async () => {
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, { forgetSecret: secret });
    const session = await service.openSession({ projectId: 'analysis-p1' });
    await service.setProjectPrivacy('analysis-p1', 'public');
    const busy = await acceptedEpisode(service, session.sessionId, 'gia in decisione');
    const free = await acceptedEpisode(service, session.sessionId, 'libera');
    await repository.createPruningProposal({
      batchId: 'deterministic-batch',
      proposer: 'deterministic',
      proposalType: 'decay',
      sourceIds: [busy],
      sourceVersions: { [busy]: 1 },
      rationale: 'sotto soglia',
      confidence: 0.8,
      scoreSnapshot: {},
    });
    const seen: Array<{ privacy: string; ids: string[] }> = [];
    const analyzer = {
      modelVersion: 'test-model',
      analyze: async (batch: { privacy: string; items: Array<{ memoryId: string }> }) => {
        seen.push({
          privacy: batch.privacy,
          ids: batch.items.map((item) => item.memoryId),
        });
        return { candidates: [], promptHash: 'abc123' };
      },
    };

    const run = await service.runPruningAnalysis(analyzer);

    // The busy memory never reaches the model even as a member: the decide
    // step owns it until it rules.
    expect(run).toMatchObject({
      status: 'ran',
      batches: 1,
      proposalsWritten: 0,
      skipped: { batches: 0, proposals: 0 },
    });
    expect(seen).toEqual([{ privacy: 'public', ids: [free] }]);
  });

  it('decides llm proposals: agrees with the score, rejects the rest', async () => {
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, { forgetSecret: secret });
    const session = await service.openSession({ projectId: 'decide-p1' });
    const scope = { type: 'project', id: 'decide-p1' } as const;
    const first = await (async () => {
      const result = await service.proposeMemory(
        {
          sessionId: session.sessionId,
          content: 'vecchia cantina',
          kind: 'episode',
          scope,
          epistemicBasis: 'verified',
          assessment: 'uncontested',
          confidence: 1,
          sensitivity: 'normal',
          activation: 'on_demand',
          sourceEventIds: [],
        },
        { actor: 'owner', explicitDirective: true },
      );
      if (result.status !== 'accepted' || !result.memoryId) throw new Error('not_accepted');
      return result.memoryId;
    })();
    // Age past the threshold through the repository clock is impossible here,
    // so the decay proposal below carries a fresh read: the score will
    // disagree and the proposal must be rejected, not executed.
    await repository.createPruningProposal({
      batchId: 'batch-llm',
      proposer: 'llm',
      proposalType: 'decay',
      sourceIds: [first],
      sourceVersions: { [first]: 1 },
      rationale: 'il modello la vuole potare',
      confidence: 0.9,
      scoreSnapshot: {},
      modelVersion: 'test-model',
      promptHash: 'abc123',
    });
    await repository.createPruningProposal({
      batchId: 'batch-llm',
      proposer: 'llm',
      proposalType: 'merge',
      sourceIds: [first],
      sourceVersions: { [first]: 1 },
      rationale: 'il modello vuole fondere',
      confidence: 0.9,
      scoreSnapshot: {},
      modelVersion: 'test-model',
      promptHash: 'abc123',
    });

    const run = await service.runRetention();

    expect(run.pruning.stale).toBe(0);
    expect((await repository.getMemory(first))?.record.lifecycle).toBe('accepted');
    const decided = await repository.listPruningProposals();
    expect(decided.filter((p) => p.status === 'rejected')).toHaveLength(2);
    expect(await repository.listPruningLedger()).toHaveLength(0);
  });

  it('prunes terminal jobs older than the retention cutoff while preserving active jobs', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const repository = new InMemoryRepository(() => now);
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
      now: () => now,
    });

    const oldFinished = await repository.createJob({
      operation: 'memory_extraction',
      status: 'succeeded',
      sessionId: 's-1',
    });
    const oldFailed = await repository.createJob({
      operation: 'memory_extraction',
      status: 'failed',
      sessionId: 's-1',
    });
    const oldQueued = await repository.createJob({
      operation: 'memory_extraction',
      status: 'queued',
      sessionId: 's-1',
    });

    // Advance 31 days past the 30-day cutoff
    now = new Date('2026-02-02T00:00:00.000Z');
    const recentFinished = await repository.createJob({
      operation: 'memory_extraction',
      status: 'succeeded',
      sessionId: 's-2',
    });

    const result = await service.runRetention();

    expect(result.deleted.terminalJobs).toBe(2);
    const remainingJobs = await repository.listAllJobs();
    const remainingIds = remainingJobs.map((j) => j.id);
    expect(remainingIds).toContain(oldQueued.id);
    expect(remainingIds).toContain(recentFinished.id);
    expect(remainingIds).not.toContain(oldFinished.id);
    expect(remainingIds).not.toContain(oldFailed.id);
  });

  it('uses the calibrated judge and score fusion to decide redundancy and merge proposals', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const repository = new InMemoryRepository(() => now);
    const service = new CoreMemoryService(repository, {
      forgetSecret: secret,
      now: () => now,
      pruningJudge: {
        rerankModel: 'qwen3-reranker-0.6b',
        instructModel: 'gemma-3-4b',
        rerank: async () => [0.94],
        verdict: async (input) => ({
          verdict: {
            verdict: 'accept',
            citedIds: input.items.map((item) => item.memoryId),
            confidence: 0.92,
            reason: 'contenuti ridondanti',
          },
          promptHash: 'f'.repeat(64),
        }),
      },
    });
    const session = await service.openSession({ projectId: 'judge-p1' });
    const scope = { type: 'project', id: 'judge-p1' } as const;
    const makeMemory = async (content: string, kind: 'preference' | 'episode') => {
      const result = await service.proposeMemory(
        {
          sessionId: session.sessionId,
          content,
          kind,
          scope,
          epistemicBasis: 'verified',
          assessment: 'uncontested',
          confidence: 1,
          sensitivity: 'normal',
          activation: 'on_demand',
          sourceEventIds: [],
        },
        { actor: 'owner', explicitDirective: true },
      );
      if (result.status !== 'accepted' || !result.memoryId) throw new Error('not_accepted');
      return result.memoryId;
    };

    const olderEpisode = await makeMemory('Episodio vecchio duplicato', 'episode');
    const newerPreference = await makeMemory('Preferenza stabile di riferimento', 'preference');
    const secondEpisode = await makeMemory('Secondo episodio da fondere', 'episode');

    // Age 240 days so episodes have low deterministic score (~0.425) while
    // remaining above the 0.25 decay-only threshold, so only fusion with the
    // calibrated judge can expire them.
    now = new Date('2026-08-29T00:00:00.000Z');

    await repository.createPruningProposal({
      batchId: 'batch-judge-1',
      proposer: 'llm',
      proposalType: 'redundancy',
      sourceIds: [newerPreference, olderEpisode],
      sourceVersions: { [newerPreference]: 1, [olderEpisode]: 1 },
      rationale: 'ridondanza rilevata dal modello',
      confidence: 0.9,
      scoreSnapshot: {},
      modelVersion: 'gemma-3-4b',
      promptHash: 'a'.repeat(64),
    });

    await repository.createPruningProposal({
      batchId: 'batch-judge-2',
      proposer: 'llm',
      proposalType: 'merge',
      sourceIds: [newerPreference, secondEpisode],
      sourceVersions: { [newerPreference]: 1, [secondEpisode]: 1 },
      rationale: 'fusione proposta dal modello',
      confidence: 0.9,
      scoreSnapshot: {},
      modelVersion: 'gemma-3-4b',
      promptHash: 'b'.repeat(64),
    });

    const run = await service.runRetention();

    expect(run.pruning.memoriesExpired).toBe(2);
    expect((await repository.getMemory(olderEpisode))?.record.lifecycle).toBe('expired');
    expect((await repository.getMemory(secondEpisode))?.record.lifecycle).toBe('expired');
    expect((await repository.getMemory(newerPreference))?.record.lifecycle).toBe('accepted');
    const decided = await repository.listPruningProposals();
    expect(decided.filter((p) => p.status === 'accepted')).toHaveLength(2);
    expect(await repository.listPruningLedger()).toHaveLength(2);
  });
});
