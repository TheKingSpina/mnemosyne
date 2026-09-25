import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { afterEach } from 'vitest';
import { createWebServer } from './server.js';

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

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test_server_address_unavailable');
  return `http://127.0.0.1:${address.port}`;
}

describe('Mnemosyne web server', () => {
  it('serves the console with security headers', async () => {
    const server = createWebServer({
      apiOrigin: 'http://127.0.0.1:3000',
      indexPath: new URL('./index.html', import.meta.url).pathname,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test_server_address_unavailable');
    const response = await fetch(`http://127.0.0.1:${address.port}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(await response.text()).toContain('Mnemosyne');
  });

  it('proxies authenticated API requests through the browser origin', async () => {
    const upstream = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ authorization: request.headers.authorization }));
    });
    servers.push(upstream);
    const upstreamUrl = await listen(upstream);
    const web = createWebServer({
      apiOrigin: upstreamUrl,
      indexPath: new URL('./index.html', import.meta.url).pathname,
    });
    servers.push(web);
    const webUrl = await listen(web);

    const response = await fetch(`${webUrl}/api/backend/v1/admin/overview`, {
      headers: { authorization: 'Bearer owner-test-token' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authorization: 'Bearer owner-test-token' });
  });

  it('uses session storage instead of local storage for the owner token', () => {
    const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
    expect(html).toContain("sessionStorage.setItem('mnemosyne-owner-token'");
    expect(html).toContain('Inserisci il token owner e premi Connetti.');
    expect(html).not.toContain("localStorage.setItem('mnemosyne-owner-token'");
  });
});
