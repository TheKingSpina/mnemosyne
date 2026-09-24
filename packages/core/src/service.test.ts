import { describe, expect, it } from 'vitest';
import {
  CoreMemoryService,
  DeterministicEmbeddingProvider,
  InMemoryRepository,
  InMemoryCorpusCache,
  InMemorySemanticSearchIndex,
} from './index.js';

const projectScope = { type: 'project' as const, id: 'memory-service' };
const globalScope = { type: 'global' as const, id: 'personal' };

function createService() {
  return new CoreMemoryService(new InMemoryRepository(), {
    forgetSecret: 'a-secure-test-secret-that-is-long-enough',
  });
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

  it('does not expose a pending global preference until review', async () => {
    const service = createService();
    const session = await service.openSession({ projectId: 'memory-service' });
    const proposed = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Preferisco risposte concise',
        kind: 'preference',
        scope: globalScope,
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
        scope: globalScope,
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
            currentVersion: 1,
            lifecycle: 'accepted' as const,
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
});
