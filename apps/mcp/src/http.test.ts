import { CoreMemoryService, createAccessPolicy, InMemoryRepository } from '@mnemosyne/core';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMcpHttpServer } from './http.js';

const ownerToken = 'owner-token-that-is-long-enough-for-http-tests-123456';
const harnessToken = 'harness-token-that-is-long-enough-for-http-tests-123456';
const servers: Server[] = [];

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

function createTestServer(
  sessionId: string,
  maxSessions = 1_000,
  options: {
    sessionIdleTimeoutMs?: number;
    enableDnsRebindingProtection?: boolean;
    allowedHosts?: string[];
    allowedOrigins?: string[];
  } = {},
): Server {
  const service = new CoreMemoryService(new InMemoryRepository(), {
    forgetSecret: 'forget-secret-that-is-long-enough-for-http-tests-0123456789',
  });
  const server = createMcpHttpServer(service, createAccessPolicy({ ownerToken, harnessToken }), {
    sessionIdGenerator: () => sessionId,
    maxSessions,
    ...options,
  });
  servers.push(server);
  return server;
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test_server_address_unavailable');
  return `http://127.0.0.1:${address.port}`;
}

async function initialize(baseUrl: string, token: string): Promise<string> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'http-test-client', version: '1.0.0' },
      },
    }),
  });
  await response.text();
  expect(response.status).toBe(200);
  const sessionId = response.headers.get('mcp-session-id');
  if (!sessionId) throw new Error('mcp_session_id_missing');
  return sessionId;
}

async function post(
  baseUrl: string,
  token: string,
  sessionId: string,
  method: string,
  origin?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'mcp-protocol-version': '2025-03-26',
      'mcp-session-id': sessionId,
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params: {} }),
  });
}

describe('Mnemosyne MCP HTTP session authorization', () => {
  it('keeps an HTTP session bound to the authenticated profile', async () => {
    const baseUrl = await listen(createTestServer('owner-session'));
    const sessionId = await initialize(baseUrl, ownerToken);

    const crossPost = await post(baseUrl, harnessToken, sessionId, 'tools/list');
    const crossGet = await fetch(`${baseUrl}/mcp`, {
      headers: {
        accept: 'text/event-stream',
        authorization: `Bearer ${harnessToken}`,
        'mcp-protocol-version': '2025-03-26',
        'mcp-session-id': sessionId,
      },
    });
    const crossDelete = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: {
        authorization: `Bearer ${harnessToken}`,
        'mcp-protocol-version': '2025-03-26',
        'mcp-session-id': sessionId,
      },
    });

    expect(crossPost.status).toBe(403);
    expect(crossGet.status).toBe(403);
    expect(crossDelete.status).toBe(403);

    const ownerPost = await post(baseUrl, ownerToken, sessionId, 'tools/list');
    await ownerPost.text();
    expect(ownerPost.status).toBe(200);
  });

  it('limits the number of active HTTP sessions', async () => {
    const baseUrl = await listen(createTestServer('first-session', 1));
    await initialize(baseUrl, ownerToken);
    const second = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'http-test-client', version: '1.0.0' },
        },
      }),
    });

    expect(second.status).toBe(503);
  });

  it('expires inactive sessions and rejects untrusted origins when configured', async () => {
    const idleBaseUrl = await listen(
      createTestServer('idle-session', 1_000, { sessionIdleTimeoutMs: 1_000 }),
    );
    const idleSessionId = await initialize(idleBaseUrl, ownerToken);
    await sleep(2_100);
    const expired = await post(idleBaseUrl, ownerToken, idleSessionId, 'tools/list');
    expect(expired.status).toBe(404);

    const protectedBaseUrl = await listen(
      createTestServer('protected-session', 1_000, {
        enableDnsRebindingProtection: true,
        allowedOrigins: ['https://allowed.example'],
      }),
    );
    const protectedSessionId = await initialize(protectedBaseUrl, ownerToken);
    const untrustedOrigin = await post(
      protectedBaseUrl,
      ownerToken,
      protectedSessionId,
      'tools/list',
      'https://evil.example',
    );
    expect(untrustedOrigin.status).toBe(403);
  });

  it('rejects an unknown session and malformed JSON', async () => {
    const baseUrl = await listen(createTestServer('known-session'));
    const unknown = await post(baseUrl, ownerToken, 'unknown-session', 'tools/list');
    const malformed = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${ownerToken}`,
        'content-type': 'application/json',
      },
      body: '{',
    });

    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(400);
  });
});
