import {
  contextInputSchema,
  correctMemoryInputSchema,
  openSessionInputSchema,
  proposeMemoryInputSchema,
  recordEventsInputSchema,
  reviewProposalInputSchema,
  searchMemoriesInputSchema,
  listPendingProposalsInputSchema,
  listAdminMemoriesInputSchema,
} from '@mnemosyne/contracts';
import {
  DomainError,
  toDomainError,
  type AccessPolicy,
  type MemoryPermission,
  type MemoryService,
} from '@mnemosyne/core';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { z } from 'zod';

const paramsSchema = z.object({ id: z.string().min(1) });
const bodylessSchema = z.object({});
const searchQuerySchema = z.object({
  sessionId: z.string().min(1),
  q: z.string().min(1),
  scopeType: z.enum(['session', 'project', 'area', 'global']).optional(),
  scopeId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
const pendingQuerySchema = z.object({
  sessionId: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

interface ApiServerOptions {
  accessPolicy?: AccessPolicy;
  maxRequestBodyBytes?: number;
}

export function createApiServer(service: MemoryService, options: ApiServerOptions): Server {
  return createServer((request, response) => {
    void handleRequest(service, options, request, response).catch((error: unknown) => {
      sendError(response, error);
    });
  });
}

async function handleRequest(
  service: MemoryService,
  options: ApiServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (request.method === 'GET' && url.pathname === '/health/live') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/health/ready') {
    try {
      await service.getCorpusRevision();
      sendJson(response, 200, { status: 'ready' });
    } catch (error) {
      sendError(response, error);
    }
    return;
  }
  let actor: 'harness' | 'owner' | undefined;
  if (url.pathname.startsWith('/v1/')) {
    const accessPolicy = options.accessPolicy;
    if (!accessPolicy) throw new Error('api_access_policy_not_configured');
    actor = accessPolicy.authenticate(request.headers.authorization);
    const permission = permissionForPath(url.pathname, request.method);
    accessPolicy.authorize(actor, permission);
  }
  if (request.method !== 'POST' && request.method !== 'GET') {
    sendJson(response, 405, { code: 'method_not_allowed', message: 'Method not allowed' });
    return;
  }

  if (url.pathname.startsWith('/v1/')) {
    await handleAuthorizedRequest(
      service,
      actor ?? 'harness',
      request,
      response,
      url,
      options.maxRequestBodyBytes ?? 1_048_576,
    );
    return;
  }

  sendJson(response, 404, { code: 'not_found', message: 'Route not found' });
}

async function handleAuthorizedRequest(
  service: MemoryService,
  actor: 'owner' | 'harness',
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  maxRequestBodyBytes: number,
): Promise<void> {
  if (request.method === 'POST' && url.pathname === '/v1/sessions') {
    const body = await readJson(request, maxRequestBodyBytes);
    sendJson(response, 201, await service.openSession(openSessionInputSchema.parse(body)));
    return;
  }
  const sessionEvents = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/u);
  if (request.method === 'POST' && sessionEvents) {
    const { id } = paramsSchema.parse({ id: sessionEvents[1] });
    const body = objectBody(await readJson(request, maxRequestBodyBytes));
    const input = recordEventsInputSchema.parse({ ...body, sessionId: id });
    sendJson(response, 202, await service.recordEvents(input));
    return;
  }
  const sessionClose = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/close$/u);
  if (request.method === 'POST' && sessionClose) {
    const { id } = paramsSchema.parse({ id: sessionClose[1] });
    bodylessSchema.parse(await readJson(request, maxRequestBodyBytes));
    sendJson(response, 202, await service.closeSession(id));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/proposals') {
    sendJson(
      response,
      201,
      await service.proposeMemory(
        proposeMemoryInputSchema.parse(await readJson(request, maxRequestBodyBytes)),
        { actor, explicitDirective: false },
      ),
    );
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/context/resolve') {
    sendJson(
      response,
      200,
      await service.resolveContext(
        contextInputSchema.parse(await readJson(request, maxRequestBodyBytes)),
      ),
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/memories') {
    const query = searchQuerySchema.parse({
      ...Object.fromEntries(url.searchParams),
      sessionId: url.searchParams.get('sessionId') ?? '',
    });
    const input = searchMemoriesInputSchema.parse({
      sessionId: query.sessionId,
      query: query.q,
      limit: query.limit,
      offset: query.offset,
      scope:
        query.scopeType && query.scopeId ? { type: query.scopeType, id: query.scopeId } : undefined,
    });
    sendJson(response, 200, { items: await service.searchMemories(input) });
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/proposals') {
    const query = pendingQuerySchema.parse({
      sessionId: url.searchParams.get('sessionId') ?? '',
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined,
    });
    const input = listPendingProposalsInputSchema.parse(query);
    sendJson(response, 200, await service.listPendingProposals(input));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/admin/memories') {
    const query = listAdminMemoriesInputSchema.parse({
      q: url.searchParams.get('q') ?? '',
      lifecycle: url.searchParams.get('lifecycle') || undefined,
      kind: url.searchParams.get('kind') || undefined,
      scopeType: url.searchParams.get('scopeType') || undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined,
    });
    sendJson(response, 200, await service.listAdminMemories(query));
    return;
  }
  const adminMemory = url.pathname.match(/^\/v1\/admin\/memories\/([^/]+)$/u);
  if (request.method === 'GET' && adminMemory) {
    const { id } = paramsSchema.parse({ id: adminMemory[1] });
    const value = await service.getMemoryAdminView(id);
    if (!value) {
      sendJson(response, 404, { code: 'memory_not_found', message: 'Memory not found' });
      return;
    }
    sendJson(response, 200, value);
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/admin/conflicts') {
    sendJson(response, 200, await service.listConflicts());
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/admin/overview') {
    sendJson(response, 200, await service.getAdminOverview());
    return;
  }
  const memory = url.pathname.match(/^\/v1\/memories\/([^/]+)$/u);
  if (request.method === 'GET' && memory) {
    const { id } = paramsSchema.parse({ id: memory[1] });
    if (actor === 'owner') {
      const value = await service.getMemoryAdminView(id);
      if (!value) {
        sendJson(response, 404, { code: 'memory_not_found', message: 'Memory not found' });
        return;
      }
      sendJson(response, 200, value);
      return;
    }
    const value = await service.getMemory(id);
    if (!value) {
      sendJson(response, 404, { code: 'memory_not_found', message: 'Memory not found' });
      return;
    }
    sendJson(response, 200, value);
    return;
  }
  const correction = url.pathname.match(/^\/v1\/memories\/([^/]+)\/corrections$/u);
  if (request.method === 'POST' && correction) {
    const { id } = paramsSchema.parse({ id: correction[1] });
    const input = correctMemoryInputSchema.parse({
      ...objectBody(await readJson(request, maxRequestBodyBytes)),
      memoryId: id,
    });
    sendJson(response, 200, await service.correctMemory(input));
    return;
  }
  const proposalDecision = url.pathname.match(/^\/v1\/proposals\/([^/]+)\/decision$/u);
  if (request.method === 'POST' && proposalDecision) {
    const { id } = paramsSchema.parse({ id: proposalDecision[1] });
    const input = reviewProposalInputSchema.parse({
      ...objectBody(await readJson(request, maxRequestBodyBytes)),
      memoryId: id,
    });
    sendJson(response, 200, await service.reviewProposal(input));
    return;
  }
  const retraction = url.pathname.match(/^\/v1\/memories\/([^/]+)\/retractions$/u);
  if (request.method === 'POST' && retraction) {
    const { id } = paramsSchema.parse({ id: retraction[1] });
    const body = z
      .object({ reason: z.string().min(1).max(2_000) })
      .parse(await readJson(request, maxRequestBodyBytes));
    sendJson(response, 200, await service.retractMemory(id, body.reason));
    return;
  }
  const forgetPrepare = url.pathname.match(/^\/v1\/memories\/([^/]+)\/forget\/prepare$/u);
  if (request.method === 'POST' && forgetPrepare) {
    const { id } = paramsSchema.parse({ id: forgetPrepare[1] });
    bodylessSchema.parse(await readJson(request, maxRequestBodyBytes));
    sendJson(response, 200, await service.prepareForget(id));
    return;
  }
  const forget = url.pathname.match(/^\/v1\/memories\/([^/]+)\/forget$/u);
  if (request.method === 'POST' && forget) {
    const { id } = paramsSchema.parse({ id: forget[1] });
    const body = z
      .object({ confirmationToken: z.string().min(1) })
      .parse(await readJson(request, maxRequestBodyBytes));
    await service.forgetMemory(id, body.confirmationToken);
    sendJson(response, 204, null);
    return;
  }
  const job = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/u);
  if (request.method === 'GET' && job) {
    const value = await service.getJob(job[1]);
    if (!value) {
      sendJson(response, 404, { code: 'job_not_found', message: 'Job not found' });
      return;
    }
    sendJson(response, 200, value);
    return;
  }
  sendJson(response, 404, { code: 'not_found', message: 'Route not found' });
}

function permissionForPath(pathname: string, method: string | undefined): MemoryPermission {
  if (pathname === '/v1/proposals' && method === 'GET') return 'proposal.review';
  if (pathname === '/v1/proposals' && method === 'POST') return 'memory.propose';
  if (pathname.startsWith('/v1/admin/')) return 'proposal.review';
  if (pathname.includes('/decision')) return 'proposal.review';
  if (pathname.includes('/corrections')) return 'memory.correct';
  if (pathname.includes('/retractions')) return 'memory.retract';
  if (pathname.includes('/forget')) return 'memory.forget';
  if (pathname === '/v1/memories') return 'memory.read';
  if (pathname === '/v1/context/resolve') return 'context.resolve';
  if (pathname.startsWith('/v1/memories/')) return 'memory.read';
  if (pathname.endsWith('/events')) return 'events.write';
  if (pathname.endsWith('/close')) return 'session.manage';
  if (pathname.startsWith('/v1/sessions')) return 'session.manage';
  if (pathname.startsWith('/v1/jobs/')) return 'job.read';
  return 'memory.read';
}

async function readJson(request: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  const chunks: string[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maxBytes) throw new Error('request_body_too_large');
    chunks.push(buffer.toString('utf8'));
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(chunks.join('')) as unknown;
  } catch {
    throw new Error('invalid_json');
  }
}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('invalid_object_body');
  }
  return value as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (status === 204) {
    response.writeHead(204).end();
    return;
  }
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

function sendError(response: ServerResponse, error: unknown): void {
  const domainError =
    error instanceof z.ZodError
      ? new DomainError('validation_error', 'Invalid request', 400)
      : toDomainError(error);
  sendJson(response, domainError.status, {
    type: `https://mnemosyne.local/problems/${domainError.code}`,
    title: domainError.message,
    status: domainError.status,
    code: domainError.code,
  });
}
