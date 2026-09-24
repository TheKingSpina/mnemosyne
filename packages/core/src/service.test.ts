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
});
