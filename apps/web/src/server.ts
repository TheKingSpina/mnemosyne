import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';

const defaultMaxRequestBodyBytes = 1_048_576;
const securityHeaders = {
  'content-security-policy':
    "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
} as const;

export interface WebServerOptions {
  apiOrigin: string;
  indexPath: string;
  maxRequestBodyBytes?: number;
}

export function createWebServer(options: WebServerOptions): Server {
  const apiOrigin = new URL(options.apiOrigin);
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? defaultMaxRequestBodyBytes;
  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes <= 0) {
    throw new Error('web_max_request_body_bytes_invalid');
  }

  return createServer((request, response) => {
    void handleRequest(request, response, apiOrigin, options.indexPath, maxRequestBodyBytes).catch(
      (error: unknown) => {
        if (response.headersSent) return;
        if (error instanceof Error && error.message === 'request_body_too_large') {
          sendJson(response, 413, { code: 'request_body_too_large' });
          return;
        }
        sendJson(response, 500, { code: 'internal_error' });
      },
    );
  });
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  apiOrigin: URL,
  indexPath: string,
  maxRequestBodyBytes: number,
): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname === '/api/config') {
    sendJson(response, 200, { proxyPath: '/api/backend' });
    return;
  }
  if (url.pathname === '/api/backend' || url.pathname.startsWith('/api/backend/')) {
    await proxyApiRequest(request, response, apiOrigin, url, maxRequestBodyBytes);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    sendJson(response, 405, { code: 'method_not_allowed' });
    return;
  }
  if (url.pathname !== '/') {
    sendJson(response, 404, { code: 'not_found' });
    return;
  }
  const html = await readFile(indexPath, 'utf8');
  sendText(response, request.method === 'HEAD' ? 200 : 200, html, 'text/html; charset=utf-8');
}

async function proxyApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  apiOrigin: URL,
  url: URL,
  maxRequestBodyBytes: number,
): Promise<void> {
  if (request.method !== 'GET' && request.method !== 'POST') {
    sendJson(response, 405, { code: 'method_not_allowed' });
    return;
  }
  const path = url.pathname.slice('/api/backend'.length) || '/';
  const upstreamUrl = new URL(path, apiOrigin);
  upstreamUrl.search = url.search;
  const headers = new Headers();
  for (const name of ['accept', 'authorization', 'content-type', 'idempotency-key']) {
    const value = request.headers[name];
    if (typeof value === 'string') headers.set(name, value);
  }
  const body =
    request.method === 'POST' ? await readRequestBody(request, maxRequestBodyBytes) : undefined;
  const upstream = await fetch(upstreamUrl, {
    method: request.method,
    headers,
    body: body ? new Uint8Array(body) : undefined,
  });
  const payload = Buffer.from(await upstream.arrayBuffer());
  const responseHeaders: Record<string, string> = {
    'content-length': String(payload.length),
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    ...securityHeaders,
  };
  response.writeHead(upstream.status, responseHeaders);
  response.end(payload);
}

async function readRequestBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
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

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  sendText(response, status, JSON.stringify(body), 'application/json');
}

function sendText(
  response: ServerResponse,
  status: number,
  body: string,
  contentType: string,
): void {
  const payload = Buffer.from(body);
  response.writeHead(status, {
    'content-length': String(payload.length),
    'content-type': contentType,
    'cache-control': 'no-store',
    ...securityHeaders,
  });
  response.end(payload);
}
