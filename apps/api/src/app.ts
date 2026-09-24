import {
  corpusExportSchema,
  listMemoryFeedbackOutputSchema,
  memoryFeedbackSchema,
  contextInputSchema,
  correctMemoryInputSchema,
  openSessionInputSchema,
  proposeMemoryInputSchema,
  recordEventsInputSchema,
  reviewProposalInputSchema,
  searchMemoriesInputSchema,
  listPendingProposalsInputSchema,
  listAdminMemoriesInputSchema,
  listAdminJobsInputSchema,
  listAdminSessionsInputSchema,
} from '@mnemosyne/contracts';
import {
  DomainError,
  InMemoryIdempotencyStore,
  hashIdempotencyPayload,
  toDomainError,
  type AccessPolicy,
  type IdempotencyStore,
  type MemoryPermission,
  type MemoryService,
  type StoredIdempotentResponse,
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
  idempotencyStore?: IdempotencyStore;
  maxRequestBodyBytes?: number;
  requireIdempotencyKey?: boolean;
}

type ApiRequest = IncomingMessage | BufferedApiRequest;

function isBufferedApiRequest(request: ApiRequest): request is BufferedApiRequest {
  return 'body' in request;
}

interface ResponseWriter {
  writeHead(statusCode: number, headers?: Record<string, string | number>): ResponseWriter;
  end(chunk?: string | Buffer): ResponseWriter;
}

export function createApiServer(service: MemoryService, options: ApiServerOptions): Server {
  const serverOptions: ApiServerOptions = {
    ...options,
    idempotencyStore: options.idempotencyStore ?? new InMemoryIdempotencyStore(),
  };
  return createServer((request, response) => {
    void handleRequest(service, serverOptions, request, response).catch((error: unknown) => {
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
      options.idempotencyStore,
      options.requireIdempotencyKey ?? false,
    );
    return;
  }

  sendJson(response, 404, { code: 'not_found', message: 'Route not found' });
}

async function handleAuthorizedRequest(
  service: MemoryService,
  actor: 'owner' | 'harness',
  request: ApiRequest,
  response: ResponseWriter,
  url: URL,
  maxRequestBodyBytes: number,
  idempotencyStore: IdempotencyStore | undefined,
  requireIdempotencyKey: boolean,
): Promise<void> {
  if (
    !isBufferedApiRequest(request) &&
    isStateChangingRoute(url, request.method) &&
    idempotencyStore
  ) {
    const key = idempotencyKeyFrom(request);
    if (!key && !requireIdempotencyKey)
      return handleAuthorizedRequestUnchecked(
        service,
        actor,
        request,
        response,
        url,
        maxRequestBodyBytes,
      );
    await handleIdempotentPost(
      idempotencyStore,
      request,
      key,
      response,
      url,
      maxRequestBodyBytes,
      actor,
      (bufferedService, bufferedActor, bufferedRequest, bufferedResponse) =>
        handleAuthorizedRequestUnchecked(
          bufferedService,
          bufferedActor,
          bufferedRequest,
          bufferedResponse,
          url,
          maxRequestBodyBytes,
        ),
      service,
    );
    return;
  }
  await handleAuthorizedRequestUnchecked(
    service,
    actor,
    request,
    response,
    url,
    maxRequestBodyBytes,
  );
}

async function handleAuthorizedRequestUnchecked(
  service: MemoryService,
  actor: 'owner' | 'harness',
  request: ApiRequest,
  response: ResponseWriter,
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
      scopeId: url.searchParams.get('scopeId') || undefined,
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
  const adminConflictResolution = url.pathname.match(
    /^\/v1\/admin\/conflicts\/([^/]+)\/resolution$/u,
  );
  if (request.method === 'POST' && adminConflictResolution) {
    const { id } = paramsSchema.parse({ id: adminConflictResolution[1] });
    bodylessSchema.parse(await readJson(request, maxRequestBodyBytes));
    sendJson(response, 200, await service.resolveConflict(id));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/admin/overview') {
    sendJson(response, 200, await service.getAdminOverview());
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/admin/capabilities') {
    sendJson(response, 200, await service.getAdminCapabilities());
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/admin/retention') {
    sendJson(response, 200, await service.getRetentionStatus());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/admin/retention/run') {
    bodylessSchema.parse(await readJson(request, maxRequestBodyBytes));
    sendJson(response, 200, await service.runRetention());
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/memories/feedback') {
    const body = memoryFeedbackSchema.parse(await readJson(request, maxRequestBodyBytes));
    sendJson(response, 201, await service.submitFeedback(body));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/memories/feedback') {
    const memoryId = url.searchParams.get('memoryId');
    if (!memoryId) {
      sendJson(response, 400, { code: 'memory_id_required', message: 'memoryId is required' });
      return;
    }
    sendJson(
      response,
      200,
      listMemoryFeedbackOutputSchema.parse(await service.listFeedback(memoryId)),
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/admin/exports/corpus') {
    const payload = await service.listCorpusExport();
    const serialized = JSON.stringify(payload);
    response.writeHead(200, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(serialized),
      'content-disposition': 'attachment; filename="mnemosyne-corpus-export.json"',
      'cache-control': 'no-store',
    });
    response.end(serialized);
    return;
  }
  if (request.method === 'POST' && url.pathname === '/v1/admin/restore/corpus') {
    const body = corpusExportSchema.parse(await readJson(request, maxRequestBodyBytes));
    sendJson(response, 200, await service.restoreCorpus(body));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/admin/sessions') {
    const input = listAdminSessionsInputSchema.parse({
      projectId: url.searchParams.get('projectId') || undefined,
      status: url.searchParams.get('status') || undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined,
    });
    sendJson(response, 200, await service.listAdminSessions(input));
    return;
  }
  const adminSession = url.pathname.match(/^\/v1\/admin\/sessions\/([^/]+)$/u);
  if (request.method === 'GET' && adminSession) {
    const { id } = paramsSchema.parse({ id: adminSession[1] });
    sendJson(response, 200, await service.getAdminSessionDetail(id));
    return;
  }
  const adminJobAttempts = url.pathname.match(/^\/v1\/admin\/jobs\/([^/]+)\/attempts$/u);
  if (request.method === 'GET' && adminJobAttempts) {
    const { id } = paramsSchema.parse({ id: adminJobAttempts[1] });
    const job = await service.getJob(id);
    if (!job) {
      sendJson(response, 404, { code: 'job_not_found', message: 'Job not found' });
      return;
    }
    sendJson(response, 200, await service.listJobAttempts(id));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/v1/admin/jobs') {
    const input = listAdminJobsInputSchema.parse({
      status: url.searchParams.get('status') || undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      offset: url.searchParams.get('offset') ?? undefined,
    });
    sendJson(response, 200, await service.listAdminJobs(input));
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

interface BufferedApiRequest {
  method: 'POST';
  url: URL;
  body: Buffer;
}

type BufferedApiHandler = (
  service: MemoryService,
  actor: 'owner' | 'harness',
  request: BufferedApiRequest,
  response: ResponseWriter,
) => Promise<void>;

class BufferedResponse implements ResponseWriter {
  statusCode = 200;
  private responseBody = Buffer.alloc(0);

  writeHead(statusCode: number): this {
    this.statusCode = statusCode;
    return this;
  }

  end(chunk?: string | Buffer): this {
    this.responseBody = Buffer.isBuffer(chunk)
      ? Buffer.from(chunk)
      : Buffer.from(chunk ?? '', 'utf8');
    return this;
  }

  result(): StoredIdempotentResponse {
    if (this.statusCode === 204 || this.responseBody.length === 0) {
      return { status: this.statusCode, body: null };
    }
    return {
      status: this.statusCode,
      body: JSON.parse(this.responseBody.toString('utf8')) as unknown,
    };
  }
}

function isStateChangingRoute(url: URL, method: string | undefined): boolean {
  if (method !== 'POST') return false;
  if (url.pathname === '/v1/context/resolve') return false;
  if (url.pathname.endsWith('/forget/prepare')) return false;
  return true;
}

function idempotencyKeyFrom(request: IncomingMessage): string | undefined {
  const value = request.headers['idempotency-key'];
  if (value === undefined) return undefined;
  if (Array.isArray(value) || !/^[A-Za-z0-9._:-]{1,200}$/u.test(value)) {
    throw new Error('idempotency_key_invalid');
  }
  return value;
}

function requestPayload(request: BufferedApiRequest, actor: 'owner' | 'harness'): unknown {
  let body: unknown;
  try {
    body = JSON.parse(request.body.toString('utf8') || '{}') as unknown;
  } catch {
    throw new Error('invalid_json');
  }
  return {
    method: request.method,
    path: `${request.url.pathname}${request.url.search}`,
    actor,
    body,
  };
}

function sendStoredResponse(response: ResponseWriter, stored: StoredIdempotentResponse): void {
  sendJson(response, stored.status, stored.body);
}

async function handleIdempotentPost(
  store: IdempotencyStore,
  request: IncomingMessage,
  key: string | undefined,
  response: ResponseWriter,
  url: URL,
  maxRequestBodyBytes: number,
  actor: 'owner' | 'harness',
  handler: BufferedApiHandler,
  service: MemoryService,
): Promise<void> {
  if (!key) throw new Error('idempotency_key_required');
  const body = await readRequestBuffer(request, maxRequestBodyBytes);
  const payload = requestPayload({ method: 'POST', url, body }, actor);
  const payloadHash = hashIdempotencyPayload(payload);
  const reservation = await store.acquire(key, payloadHash);
  if (reservation.state !== 'reserved' && !reservation.payloadMatches) {
    throw new Error('idempotency_key_conflict');
  }
  if (reservation.state === 'existing') {
    sendStoredResponse(response, reservation.response);
    return;
  }
  if (reservation.state === 'in_progress') throw new Error('idempotency_in_progress');
  try {
    const stored = await executeBufferedHandler(
      service,
      actor,
      { method: 'POST', url, body },
      handler,
    );
    await store.save(key, payloadHash, stored);
    sendStoredResponse(response, stored);
  } catch (error) {
    await store.abort(key, payloadHash);
    throw error;
  }
}

async function executeBufferedHandler(
  service: MemoryService,
  actor: 'owner' | 'harness',
  request: BufferedApiRequest,
  handler: BufferedApiHandler,
): Promise<StoredIdempotentResponse> {
  const response = new BufferedResponse();
  await handler(service, actor, request, response);
  return response.result();
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

async function readJson(request: ApiRequest, maxBytes = 1_048_576): Promise<unknown> {
  if (isBufferedApiRequest(request)) {
    if (request.body.length > maxBytes) throw new Error('request_body_too_large');
    return parseJson(request.body);
  }
  const body = await readRequestBuffer(request, maxBytes);
  return parseJson(body);
}

async function readRequestBuffer(request: IncomingMessage, maxBytes = 1_048_576): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > maxBytes) throw new Error('request_body_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function parseJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8') || '{}') as unknown;
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

function sendJson(response: ResponseWriter, status: number, body: unknown): void {
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
