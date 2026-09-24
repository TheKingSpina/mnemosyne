import { CoreMemoryService } from '@mnemosyne/core';
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
if (!connectionString || !forgetSecret) {
  throw new Error('DATABASE_URL and MNEMOSYNE_FORGET_SECRET are required');
}
const profile = process.env.MCP_PROFILE === 'owner' ? 'owner' : 'harness';
if (process.env.MCP_TRANSPORT === 'http' && !process.env.MCP_BEARER_TOKEN) {
  throw new Error('MCP_BEARER_TOKEN is required for HTTP transport');
}
const repository = await PostgresMemoryRepository.fromConnectionString(connectionString);
const service = new CoreMemoryService(repository, { forgetSecret });

if (process.env.MCP_TRANSPORT !== 'http') {
  const server = createMcpServer(service, profile);
  await server.connect(new StdioServerTransport());
} else {
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const host = process.env.MCP_HOST ?? '127.0.0.1';
  const port = Number(process.env.MCP_PORT ?? 3333);
  const server = createServer((request, response) => {
    void handleMcpHttp(transports, service, profile, request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
    });
  });
  server.listen(port, host, () => {
    process.stdout.write(`Mnemosyne MCP listening on ${host}:${port}\n`);
  });
}

async function handleMcpHttp(
  transports: Map<string, StreamableHTTPServerTransport>,
  service: MemoryService,
  profile: 'harness' | 'owner',
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname !== '/mcp' || !['POST', 'GET', 'DELETE'].includes(request.method ?? '')) {
    response.writeHead(404).end();
    return;
  }
  const authorization = request.headers.authorization;
  if (process.env.MCP_BEARER_TOKEN && authorization !== `Bearer ${process.env.MCP_BEARER_TOKEN}`) {
    response.writeHead(401).end();
    return;
  }
  const sessionId = request.headers['mcp-session-id'];
  const body = request.method === 'POST' ? await readJsonBody(request) : undefined;
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
    const mcpServer = createMcpServer(service, profile);
    await mcpServer.connect(initializedTransport);
  }
  if (!transport) {
    response.writeHead(400).end();
    return;
  }
  await transport.handleRequest(request, response, request.method === 'POST' ? body : undefined);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: string[] = [];
  for await (const chunk of request) chunks.push(String(chunk));
  return JSON.parse(chunks.join('')) as unknown;
}
