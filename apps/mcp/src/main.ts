import { CoreMemoryService, createAccessPolicy, type AccessPolicy } from '@mnemosyne/core';
import { PostgresMemoryRepository } from '@mnemosyne/postgres';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { MemoryService } from '@mnemosyne/core';
import { createMcpServer } from './server.js';

const connectionString = process.env.DATABASE_URL;
const forgetSecret = process.env.MNEMOSYNE_FORGET_SECRET;
const ownerToken = process.env.MNEMOSYNE_OWNER_TOKEN;
const harnessToken = process.env.MNEMOSYNE_HARNESS_TOKEN;
if (!connectionString || !forgetSecret || !ownerToken || !harnessToken) {
  throw new Error(
    'DATABASE_URL, MNEMOSYNE_FORGET_SECRET, MNEMOSYNE_OWNER_TOKEN, and MNEMOSYNE_HARNESS_TOKEN are required',
  );
}
const accessPolicy: AccessPolicy = createAccessPolicy({ ownerToken, harnessToken });
if (process.env.MCP_TRANSPORT === 'http' && process.env.MCP_PROFILE) {
  throw new Error('MCP_PROFILE is only valid for the stdio transport');
}
const stdioProfile = process.env.MCP_PROFILE === 'owner' ? 'owner' : 'harness';
const maxRequestBodyBytes = Number(process.env.MCP_MAX_REQUEST_BODY_BYTES ?? 1_048_576);
if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes <= 0) {
  throw new Error('MCP_MAX_REQUEST_BODY_BYTES must be a positive integer');
}
const repository = await PostgresMemoryRepository.fromConnectionString(connectionString);
const service = new CoreMemoryService(repository, { forgetSecret });

if (process.env.MCP_TRANSPORT !== 'http') {
  const server = createMcpServer(service, stdioProfile);
  await server.connect(new StdioServerTransport());
} else {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const host = process.env.MCP_HOST ?? '127.0.0.1';
  const port = Number(process.env.MCP_PORT ?? 3333);
  const server = createServer((request, response) => {
    void handleMcpHttp(transports, service, accessPolicy, request, response).catch(
      (error: unknown) => {
        if (!response.headersSent) {
          const status =
            error instanceof Error && error.message === 'request_body_too_large' ? 413 : 500;
          response.writeHead(status).end();
        }
      },
    );
  });
  server.listen(port, host, () => {
    process.stdout.write(`Mnemosyne MCP listening on ${host}:${port}\n`);
  });
}

async function handleMcpHttp(
  transports: Map<string, StreamableHTTPServerTransport>,
  service: MemoryService,
  accessPolicy: AccessPolicy,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/mcp' || !['POST', 'GET', 'DELETE'].includes(request.method ?? '')) {
    response.writeHead(404).end();
    return;
  }
  let actor: 'harness' | 'owner';
  try {
    actor = accessPolicy.authenticate(request.headers.authorization);
  } catch {
    response.writeHead(401, { 'www-authenticate': 'Bearer' }).end();
    return;
  }
  const sessionId = request.headers['mcp-session-id'];
  const body =
    request.method === 'POST' ? await readJsonBody(request, maxRequestBodyBytes) : undefined;
  let transport = typeof sessionId === 'string' ? transports.get(sessionId) : undefined;
  if (request.method === 'POST' && !transport) {
    if (sessionId || !isInitializeRequest(body)) {
      response.writeHead(400).end();
      return;
    }
    const initializedTransport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, initializedTransport);
      },
    });
    transport = initializedTransport;
    initializedTransport.onclose = () => {
      if (initializedTransport.sessionId) transports.delete(initializedTransport.sessionId);
    };
    const mcpServer = createMcpServer(service, actor);
    await mcpServer.connect(initializedTransport);
  }
  if (!transport) {
    response.writeHead(400).end();
    return;
  }
  await transport.handleRequest(request, response, request.method === 'POST' ? body : undefined);
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: string[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maxBytes) throw new Error('request_body_too_large');
    chunks.push(buffer.toString('utf8'));
  }
  try {
    return JSON.parse(chunks.join('')) as unknown;
  } catch {
    throw new Error('invalid_json');
  }
}
