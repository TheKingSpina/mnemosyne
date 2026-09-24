import { CoreMemoryService, createAccessPolicy, InMemoryRepository } from '@mnemosyne/core';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiServer } from './app.js';

const ownerToken = 'owner-token-that-is-long-enough-for-tests-123456';
const harnessToken = 'harness-token-that-is-long-enough-for-tests-123456';
const servers: Server[] = [];

function createTestServer(options: { withoutAccessPolicy?: boolean } = {}): {
  service: CoreMemoryService;
  server: Server;
} {
  const service = new CoreMemoryService(new InMemoryRepository(), {
    forgetSecret: 'forget-secret-that-is-long-enough-for-tests-0123456789',
  });
  const server = createApiServer(
    service,
    options.withoutAccessPolicy
      ? {}
      : { accessPolicy: createAccessPolicy({ ownerToken, harnessToken }) },
  );
  servers.push(server);
  return { service, server };
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
