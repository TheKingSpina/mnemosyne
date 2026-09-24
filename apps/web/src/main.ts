import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.WEB_PORT ?? 8080);
const host = process.env.WEB_HOST ?? '127.0.0.1';
const apiOrigin = process.env.WEB_API_ORIGIN ?? 'http://127.0.0.1:3000';
const indexPath = fileURLToPath(new URL('./index.html', import.meta.url));

const server = createServer((request, response) => {
  void handleRequest(request, response).catch(() => {
    if (!response.headersSent) response.writeHead(500).end();
  });
});
server.listen(port, host, () => {
  process.stdout.write(`Mnemosyne web listening on ${host}:${port}\n`);
});

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);
  if (url.pathname === '/api/config') {
    sendJson(response, 200, { apiOrigin });
    return;
  }
  if (url.pathname !== '/') {
    response.writeHead(404).end();
    return;
  }
  const html = await readFile(indexPath, 'utf8');
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
  });
  response.end(html);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}
