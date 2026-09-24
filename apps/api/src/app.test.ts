import { CoreMemoryService, createAccessPolicy, InMemoryRepository } from '@mnemosyne/core';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiServer } from './app.js';

const ownerToken = 'owner-token-that-is-long-enough-for-tests-123456';
const harnessToken = 'harness-token-that-is-long-enough-for-tests-123456';
const servers: Server[] = [];

function createTestServer(
  options: { withoutAccessPolicy?: boolean; requireIdempotencyKey?: boolean } = {},
): {
  service: CoreMemoryService;
  repository: InMemoryRepository;
  server: Server;
} {
  const repository = new InMemoryRepository();
  const service = new CoreMemoryService(repository, {
    forgetSecret: 'forget-secret-that-is-long-enough-for-tests-0123456789',
  });
  const server = createApiServer(service, {
    ...(options.withoutAccessPolicy
      ? {}
      : { accessPolicy: createAccessPolicy({ ownerToken, harnessToken }) }),
    requireIdempotencyKey: options.requireIdempotencyKey ?? false,
  });
  servers.push(server);
  return { service, repository, server };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test_server_address_unavailable');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe('Mnemosyne API authorization', () => {
  it('replays a successful write for the same idempotency key and payload', async () => {
    const { repository, server } = createTestServer({ requireIdempotencyKey: true });
    const baseUrl = await listen(server);
    const request = {
      method: 'POST',
      headers: {
        authorization: `Bearer ${harnessToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'session-request-1',
      },
      body: JSON.stringify({ projectId: 'synthetic-project' }),
    };

    const first = await fetch(`${baseUrl}/v1/sessions`, request);
    const firstBody = (await first.json()) as unknown;
    const second = await fetch(`${baseUrl}/v1/sessions`, request);
    const secondBody = (await second.json()) as unknown;

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(secondBody).toEqual(firstBody);
    expect(await repository.listSessions()).toHaveLength(1);
  });

  it('rejects a reused idempotency key with a different payload', async () => {
    const { repository, server } = createTestServer({ requireIdempotencyKey: true });
    const baseUrl = await listen(server);
    const headers = {
      authorization: `Bearer ${harnessToken}`,
      'content-type': 'application/json',
      'idempotency-key': 'conflicting-session-request',
    };

    const first = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId: 'synthetic-project-a' }),
    });
    const second = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId: 'synthetic-project-b' }),
    });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: 'idempotency_key_conflict' });
    expect(await repository.listSessions()).toHaveLength(1);
  });

  it('requires an idempotency key for state-changing writes when configured', async () => {
    const { repository, server } = createTestServer({ requireIdempotencyKey: true });
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${harnessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ projectId: 'synthetic-project' }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: 'idempotency_key_required' });
    expect(await repository.listSessions()).toHaveLength(0);
  });

  it('releases an idempotency key after a failed write so it can be retried', async () => {
    const { repository, server } = createTestServer({ requireIdempotencyKey: true });
    const baseUrl = await listen(server);
    const headers = {
      authorization: `Bearer ${harnessToken}`,
      'content-type': 'application/json',
      'idempotency-key': 'retryable-session-request',
    };
    const invalid = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId: '' }),
    });
    const valid = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ projectId: 'synthetic-project' }),
    });

    expect(invalid.status).toBe(400);
    expect(valid.status).toBe(201);
    expect(await repository.listSessions()).toHaveLength(1);
  });

  it('fails closed when the API has no access policy configured', async () => {
    const { server } = createTestServer({ withoutAccessPolicy: true });
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${harnessToken}` },
      body: '{}',
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: 'internal_error' });
  });

  it('rejects an unauthenticated REST request', async () => {
    const { service, server } = createTestServer();
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'synthetic-project' }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ code: 'unauthorized' });
    expect(await service.getCorpusRevision()).toEqual(expect.any(String));
  });

  it('allows a harness to create a pending proposal but not review it', async () => {
    const { service, server } = createTestServer();
    const baseUrl = await listen(server);
    const session = await service.openSession({ projectId: 'synthetic-project' });

    const proposalResponse = await fetch(`${baseUrl}/v1/proposals`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${harnessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        sessionId: session.sessionId,
        content: 'Il progetto usa pnpm',
        kind: 'convention',
        scope: { type: 'project', id: 'synthetic-project' },
        epistemicBasis: 'observed',
      }),
    });
    expect(proposalResponse.status).toBe(201);
    const proposal = (await proposalResponse.json()) as { memoryId: string };

    const reviewResponse = await fetch(`${baseUrl}/v1/proposals/${proposal.memoryId}/decision`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${harnessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 1, decision: 'accept' }),
    });

    expect(reviewResponse.status).toBe(403);
    expect(await reviewResponse.json()).toMatchObject({ code: 'forbidden' });
  });

  it('denies harness correction, retraction, and forget operations', async () => {
    const { service, server } = createTestServer();
    const baseUrl = await listen(server);
    const session = await service.openSession({ projectId: 'synthetic-project' });
    const proposed = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa npm',
        kind: 'convention',
        scope: { type: 'project', id: 'synthetic-project' },
        epistemicBasis: 'observed',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    const memoryId = proposed.memoryId!;
    const correctionResponse = await fetch(`${baseUrl}/v1/memories/${memoryId}/corrections`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${harnessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 1, content: 'Il progetto usa pnpm' }),
    });
    const retractionResponse = await fetch(`${baseUrl}/v1/memories/${memoryId}/retractions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${harnessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ reason: 'synthetic administrative test' }),
    });
    const forgetResponse = await fetch(`${baseUrl}/v1/memories/${memoryId}/forget/prepare`, {
      method: 'POST',
      headers: { authorization: `Bearer ${harnessToken}` },
      body: '{}',
    });

    expect(correctionResponse.status).toBe(403);
    expect(retractionResponse.status).toBe(403);
    expect(forgetResponse.status).toBe(403);
  });

  it('allows the owner token to review a proposal', async () => {
    const { service, server } = createTestServer();
    const baseUrl = await listen(server);
    const session = await service.openSession({ projectId: 'synthetic-project' });
    const proposed = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Preferisco risposte concise',
        kind: 'preference',
        scope: { type: 'global', id: 'personal' },
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'private',
        activation: 'always',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: false },
    );

    const response = await fetch(`${baseUrl}/v1/proposals/${proposed.memoryId}/decision`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ expectedVersion: 1, decision: 'accept' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ memory: { lifecycle: 'accepted' } });
  });

  it('allows the owner to inspect the admin overview and memory history', async () => {
    const { service, server } = createTestServer();
    const baseUrl = await listen(server);
    const session = await service.openSession({ projectId: 'synthetic-project' });
    const proposed = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa npm',
        kind: 'convention',
        scope: { type: 'project', id: 'synthetic-project' },
        epistemicBasis: 'observed',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    const memoryId = proposed.memoryId!;
    await service.correctMemory({ memoryId, expectedVersion: 1, content: 'Il progetto usa pnpm' });

    const overview = await fetch(`${baseUrl}/v1/admin/overview`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const detail = await fetch(`${baseUrl}/v1/admin/memories/${memoryId}`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(overview.status).toBe(200);
    expect(await overview.json()).toMatchObject({ total: 1, accepted: 1, pendingApproval: 0 });
    expect(detail.status).toBe(200);
    const detailBody = (await detail.json()) as { revisions: Array<{ version: number }> };
    expect(detailBody.revisions.map((revision) => revision.version)).toEqual([2, 1]);
  });

  it('reports missing operations and projections to the owner', async () => {
    const { server } = createTestServer();
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/admin/capabilities`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      extraction: { localExtractor: true, openRouterConfigured: false },
      projections: { redis: false, neo4j: false, semanticSearch: false },
      operations: { backupVerified: false, retentionManaged: true, exportAvailable: true },
    });
  });

  it('exposes balanced retention status and runs retention only for the owner', async () => {
    const { server } = createTestServer();
    const baseUrl = await listen(server);
    const harnessResponse = await fetch(`${baseUrl}/v1/admin/retention`, {
      headers: { authorization: `Bearer ${harnessToken}` },
    });
    const ownerStatus = await fetch(`${baseUrl}/v1/admin/retention`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const ownerRun = await fetch(`${baseUrl}/v1/admin/retention/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'retention-run-1',
      },
      body: '{}',
    });
    const replay = await fetch(`${baseUrl}/v1/admin/retention/run`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'retention-run-1',
      },
      body: '{}',
    });
    const status = (await ownerStatus.json()) as {
      profile: string;
      policy: Record<string, number>;
    };
    const run = (await ownerRun.json()) as { profile: string; deleted: Record<string, number> };
    const replayedRun = (await replay.json()) as typeof run;

    expect(harnessResponse.status).toBe(403);
    expect(ownerStatus.status).toBe(200);
    expect(status.profile).toBe('balanced');
    expect(status.policy).toEqual({
      closedEventDays: 30,
      pendingCandidateDays: 30,
      rejectedCandidateDays: 7,
      supersededRevisionDays: 90,
      retractedMemoryDays: 30,
    });
    expect(ownerRun.status).toBe(200);
    expect(run.profile).toBe('balanced');
    expect(run.deleted).toEqual({
      closedSessionEvents: 0,
      pendingCandidates: 0,
      rejectedCandidates: 0,
      supersededRevisions: 0,
      retractedMemories: 0,
      conflicts: 0,
    });
    expect(replay.status).toBe(200);
    expect(replayedRun).toEqual(run);
  });

  it('exports the canonical corpus with a no-store attachment response', async () => {
    const { service, server } = createTestServer();
    const baseUrl = await listen(server);
    const session = await service.openSession({ projectId: 'synthetic-project' });
    const events = await service.recordEvents({
      sessionId: session.sessionId,
      events: [
        {
          eventId: 'event-export-1',
          type: 'message',
          role: 'user',
          content: 'Messaggio sintetico',
          occurredAt: '2026-01-20T10:00:00Z',
          explicitMemoryRequest: false,
        },
      ],
    });
    const response = await fetch(`${baseUrl}/v1/admin/exports/corpus`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const body = (await response.json()) as {
      sessions: Array<{ id: string }>;
      events: Array<{ id: string }>;
      jobIds?: string[];
      memories: unknown[];
      revisions: unknown[];
      jobs: unknown[];
      jobAttempts: unknown[];
      forgetLedger: unknown[];
    };

    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain('mnemosyne-corpus-export.json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body.sessions[0]?.id).toBe(session.sessionId);
    expect(body.events[0]?.id).toBe('event-export-1');
    expect(body.jobIds).toBeUndefined();
    expect(body.memories).toEqual([]);
    expect(body.jobs).toHaveLength(1);
    expect(body.jobAttempts).toEqual([]);
    expect(events.jobIds).toHaveLength(1);
  });

  it('restores an empty corpus through an owner-only endpoint', async () => {
    const { service, server } = createTestServer({ requireIdempotencyKey: true });
    const baseUrl = await listen(server);
    const emptyExport = await service.listCorpusExport();
    const harnessResponse = await fetch(`${baseUrl}/v1/admin/restore/corpus`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${harnessToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'restore-harness',
      },
      body: JSON.stringify(emptyExport),
    });
    const ownerResponse = await fetch(`${baseUrl}/v1/admin/restore/corpus`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'restore-owner',
      },
      body: JSON.stringify(emptyExport),
    });
    const result = (await ownerResponse.json()) as { restored: { sessions: number } };

    expect(harnessResponse.status).toBe(403);
    expect(ownerResponse.status).toBe(200);
    expect(result.restored.sessions).toBe(0);
  });

  it('records feedback through the owner API and keeps the memory active', async () => {
    const { service, server } = createTestServer({ requireIdempotencyKey: true });
    const baseUrl = await listen(server);
    const session = await service.openSession({ projectId: 'synthetic-project' });
    const proposed = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Memoria con feedback sintetico',
        kind: 'fact',
        scope: { type: 'project', id: 'synthetic-project' },
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    const response = await fetch(`${baseUrl}/v1/memories/feedback`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'feedback-1',
      },
      body: JSON.stringify({
        memoryId: proposed.memoryId,
        sessionId: session.sessionId,
        kind: 'useful',
        observedAt: '2026-09-24T12:00:00.000Z',
      }),
    });
    const feedback = (await response.json()) as { kind: string };
    const memory = await service.getMemoryAdminView(proposed.memoryId!);

    expect(response.status).toBe(201);
    expect(feedback.kind).toBe('useful');
    expect(memory?.memory.lifecycle).toBe('accepted');
  });

  it('denies feedback submission to the harness profile', async () => {
    const { service, server } = createTestServer({ requireIdempotencyKey: true });
    const baseUrl = await listen(server);
    const session = await service.openSession({ projectId: 'synthetic-project' });
    const proposed = await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Memoria protetta da feedback',
        kind: 'fact',
        scope: { type: 'project', id: 'synthetic-project' },
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    const response = await fetch(`${baseUrl}/v1/memories/feedback`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${harnessToken}`,
        'content-type': 'application/json',
        'idempotency-key': 'feedback-harness',
      },
      body: JSON.stringify({
        memoryId: proposed.memoryId,
        sessionId: session.sessionId,
        kind: 'useful',
        observedAt: '2026-09-24T12:00:00.000Z',
      }),
    });

    expect(response.status).toBe(403);
  });

  it('filters owner memories by exact scope identifier', async () => {
    const { service, server } = createTestServer();
    const baseUrl = await listen(server);
    const session = await service.openSession({ projectId: 'synthetic-project' });
    await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa pnpm',
        kind: 'convention',
        scope: { type: 'project', id: 'synthetic-project' },
        epistemicBasis: 'observed',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Preferisco risposte concise',
        kind: 'preference',
        scope: { type: 'global', id: 'personal' },
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'private',
        activation: 'always',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );

    const response = await fetch(
      `${baseUrl}/v1/admin/memories?scopeType=project&scopeId=synthetic-project`,
      { headers: { authorization: `Bearer ${ownerToken}` } },
    );
    const body = (await response.json()) as { items: Array<{ content: string }> };

    expect(response.status).toBe(200);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.content).toBe('Il progetto usa pnpm');
  });

  it('exposes owner session and job administration', async () => {
    const { service, server } = createTestServer();
    const baseUrl = await listen(server);
    const session = await service.openSession({ projectId: 'synthetic-project' });
    const events = await service.recordEvents({
      sessionId: session.sessionId,
      events: [
        {
          eventId: 'event-admin-1',
          type: 'message',
          role: 'user',
          content: 'Messaggio sintetico',
          occurredAt: '2026-01-20T10:00:00Z',
          explicitMemoryRequest: false,
        },
      ],
    });

    const sessions = await fetch(`${baseUrl}/v1/admin/sessions`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const detail = await fetch(`${baseUrl}/v1/admin/sessions/${session.sessionId}`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const jobs = await fetch(`${baseUrl}/v1/admin/jobs`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(sessions.status).toBe(200);
    expect(await sessions.json()).toMatchObject({ total: 1 });
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      session: { id: session.sessionId },
      events: [{ id: 'event-admin-1' }],
      jobs: [{ id: events.jobIds[0], status: 'queued' }],
    });
    expect(jobs.status).toBe(200);
    expect(await jobs.json()).toMatchObject({ total: 1 });
  });

  it('allows only the owner to resolve a conflict', async () => {
    const { service, server } = createTestServer();
    const baseUrl = await listen(server);
    const session = await service.openSession({ projectId: 'synthetic-project' });
    await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa pnpm',
        kind: 'convention',
        scope: { type: 'project', id: 'synthetic-project' },
        epistemicBasis: 'observed',
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
      scope: { type: 'project', id: 'synthetic-project' },
      epistemicBasis: 'user_asserted',
      assessment: 'disputed',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: [],
    });
    const path = `/v1/admin/conflicts/${contradiction.conflictId}/resolution`;

    const harnessResponse = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${harnessToken}`, 'content-type': 'application/json' },
      body: '{}',
    });
    const ownerResponse = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' },
      body: '{}',
    });

    expect(harnessResponse.status).toBe(403);
    expect(ownerResponse.status).toBe(200);
    expect(await ownerResponse.json()).toMatchObject({ status: 'resolved' });
  });

  it('exposes job attempts only to the owner and returns a 404 for an unknown job', async () => {
    const { service, repository, server } = createTestServer();
    const baseUrl = await listen(server);
    const session = await service.openSession({ projectId: 'synthetic-project' });
    const events = await service.recordEvents({
      sessionId: session.sessionId,
      events: [
        {
          eventId: 'event-attempts-1',
          type: 'message',
          role: 'user',
          content: 'Messaggio sintetico',
          occurredAt: '2026-01-20T10:00:00Z',
          explicitMemoryRequest: false,
        },
      ],
    });
    const jobId = events.jobIds[0];
    const claimed = await repository.claimNextJob('test-worker', 5_000);
    if (!claimed) throw new Error('test_job_not_claimed');
    const attempt = await repository.createJobAttempt(
      { jobId, attempt: 1, status: 'running' },
      'test-worker',
    );
    await repository.finishJobAttempt(attempt.id, 'failed', 'test-worker', 'synthetic_error');
    const harnessResponse = await fetch(`${baseUrl}/v1/admin/jobs/${jobId}/attempts`, {
      headers: { authorization: `Bearer ${harnessToken}` },
    });
    const ownerResponse = await fetch(`${baseUrl}/v1/admin/jobs/${jobId}/attempts`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const missingResponse = await fetch(`${baseUrl}/v1/admin/jobs/job_missing/attempts`, {
      headers: { authorization: `Bearer ${ownerToken}` },
    });

    expect(harnessResponse.status).toBe(403);
    expect(ownerResponse.status).toBe(200);
    const attempts = (await ownerResponse.json()) as { items: Record<string, unknown>[] };
    expect(attempts.items[0]).toMatchObject({
      id: attempt.id,
      jobId,
      workerId: 'test-worker',
      attempt: 1,
      status: 'failed',
      errorCode: 'synthetic_error',
    });
    expect(typeof attempts.items[0]?.createdAt).toBe('string');
    expect(typeof attempts.items[0]?.updatedAt).toBe('string');
    expect(missingResponse.status).toBe(404);
  });

  it('returns a validation error for an oversized body without persisting it', async () => {
    const { service, server } = createTestServer();
    const baseUrl = await listen(server);
    const response = await fetch(`${baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${harnessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ projectId: 'x'.repeat(1_100_000) }),
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'request_body_too_large' });
    expect(await service.getCorpusRevision()).toEqual(expect.any(String));
  });
});
