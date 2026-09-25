import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { MemoryActor } from '@mnemosyne/contracts';
import type { AccessPolicy, MemoryService } from '@mnemosyne/core';
import { createMcpServer } from './server.js';

interface McpHttpSession {
  profile: MemoryActor;
  transport: StreamableHTTPServerTransport;
  lastSeen: number;
}

export interface McpHttpServerOptions {
  maxRequestBodyBytes?: number;
  maxSessions?: number;
  sessionIdleTimeoutMs?: number;
  enableDnsRebindingProtection?: boolean;
  allowedHosts?: string[];
  allowedOrigins?: string[];
  sessionIdGenerator?: () => string;
}

export function createMcpHttpServer(
  service: MemoryService,
  accessPolicy: AccessPolicy,
  options: McpHttpServerOptions = {},
): Server {
  const sessions = new Map<string, McpHttpSession>();
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? 1_048_576;
  const maxSessions = options.maxSessions ?? 1_000;
  const sessionIdleTimeoutMs = options.sessionIdleTimeoutMs ?? 30 * 60 * 1_000;
  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes <= 0) {
    throw new Error('MCP_MAX_REQUEST_BODY_BYTES must be a positive integer');
  }
  if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0) {
    throw new Error('MCP_MAX_SESSIONS must be a positive integer');
  }
  if (!Number.isSafeInteger(sessionIdleTimeoutMs) || sessionIdleTimeoutMs < 1_000) {
    throw new Error('MCP_SESSION_IDLE_TIMEOUT_MS must be at least 1000');
  }
  const cleanupTimer = setInterval(
    () => {
      const now = Date.now();
      for (const [id, session] of sessions) {
        if (now - session.lastSeen < sessionIdleTimeoutMs) continue;
        sessions.delete(id);
        void session.transport.close().catch(() => undefined);
      }
    },
    Math.min(sessionIdleTimeoutMs, 60_000),
  );
  cleanupTimer.unref();
  const server = createServer((request, response) => {
    void handleMcpHttpRequest(
      sessions,
      service,
      accessPolicy,
      options.sessionIdGenerator ?? (() => randomUUID()),
      maxRequestBodyBytes,
      maxSessions,
      options.enableDnsRebindingProtection ?? false,
      options.allowedHosts,
      options.allowedOrigins,
      request,
      response,
    ).catch((error: unknown) => {
      if (response.headersSent) return;
      const status =
        error instanceof Error && error.message === 'request_body_too_large'
          ? 413
          : error instanceof Error && error.message === 'invalid_json'
            ? 400
            : 500;
      response.writeHead(status).end();
    });
  });
  server.on('close', () => {
    clearInterval(cleanupTimer);
    for (const session of sessions.values()) {
      void session.transport.close().catch(() => undefined);
    }
    sessions.clear();
  });
  return server;
}

async function handleMcpHttpRequest(
  sessions: Map<string, McpHttpSession>,
  service: MemoryService,
  accessPolicy: AccessPolicy,
  generateSessionId: () => string,
  maxRequestBodyBytes: number,
  maxSessions: number,
  enableDnsRebindingProtection: boolean,
  allowedHosts: string[] | undefined,
  allowedOrigins: string[] | undefined,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/mcp' || !['POST', 'GET', 'DELETE'].includes(request.method ?? '')) {
    response.writeHead(404).end();
    return;
  }

  let actor: MemoryActor;
  try {
    actor = accessPolicy.authenticate(request.headers.authorization);
  } catch {
    response.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
    return;
  }

  const rawSessionId = request.headers['mcp-session-id'];
  if (Array.isArray(rawSessionId)) {
    response.writeHead(400).end();
    return;
  }
  const sessionId =
    typeof rawSessionId === 'string' && rawSessionId.length > 0 ? rawSessionId : undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;
  if (sessionId && !session) {
    response.writeHead(404).end();
    return;
  }
  if (session && session.profile !== actor) {
    response.writeHead(403).end();
    return;
  }
  if (session) session.lastSeen = Date.now();

  const body =
    request.method === 'POST' ? await readJsonBody(request, maxRequestBodyBytes) : undefined;
  let transport = session?.transport;
  if (request.method === 'POST' && !transport) {
    if (sessionId || !isInitializeRequest(body)) {
      response.writeHead(400).end();
      return;
    }
    if (sessions.size >= maxSessions) {
      response.writeHead(503, { 'retry-after': '1' }).end();
      return;
    }
    const initializedTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: generateSessionId,
      enableDnsRebindingProtection,
      allowedHosts,
      allowedOrigins,
      onsessioninitialized: (initializedSessionId) => {
        if (sessions.has(initializedSessionId)) throw new Error('mcp_session_id_collision');
        sessions.set(initializedSessionId, {
          profile: actor,
          transport: initializedTransport,
          lastSeen: Date.now(),
        });
      },
    });
    initializedTransport.onclose = () => {
      if (!initializedTransport.sessionId) return;
      const current = sessions.get(initializedTransport.sessionId);
      if (current?.transport === initializedTransport)
        sessions.delete(initializedTransport.sessionId);
    };
    const mcpServer = createMcpServer(service, actor);
    await mcpServer.connect(initializedTransport);
    transport = initializedTransport;
  }

  if (!transport) {
    response.writeHead(400).end();
    return;
  }
  await transport.handleRequest(request, response, request.method === 'POST' ? body : undefined);
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maxBytes) throw new Error('request_body_too_large');
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new Error('invalid_json');
  }
}
