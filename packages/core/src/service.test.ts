import { describe, expect, it } from 'vitest';
import { CoreMemoryService, InMemoryRepository } from './index.js';

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
      forgetLedger: [{ memoryId: proposed.memoryId }],
    });
  });
});
