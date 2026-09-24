import { CoreMemoryService, createAccessPolicy, InMemoryRepository } from '@mnemosyne/core';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createApiServer } from './app.js';
import { openApiDocument, serializeOpenApiDocument } from './openapi.js';

const ownerToken = 'owner-token-that-is-long-enough-for-tests-123456';
const harnessToken = 'harness-token-that-is-long-enough-for-tests-123456';
const servers: Server[] = [];

function createOpenApiServer(): Server {
  const repository = new InMemoryRepository();
  const service = new CoreMemoryService(repository, {
    forgetSecret: 'forget-secret-that-is-long-enough-for-tests-0123456789',
  });
  const server = createApiServer(service, {
    accessPolicy: createAccessPolicy({ ownerToken, harnessToken }),
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

describe('OpenAPI contract', () => {
  it('publishes the current contract without authentication', async () => {
    const server = createOpenApiServer();
    const baseUrl = await listen(server);

    const response = await fetch(`${baseUrl}/v1/openapi.json`);
    const body = (await response.json()) as unknown;

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(body).toEqual(JSON.parse(serializeOpenApiDocument()));
  });

  it('keeps the checked-in YAML artifact synchronized with the served contract', async () => {
    const source = await readFile(new URL('../../../docs/openapi.yaml', import.meta.url), 'utf8');
    const document = parse(source) as unknown;

    expect(document).toEqual(openApiDocument);
  });

  it('declares every implemented REST route', () => {
    const expectedPaths = [
      '/v1/openapi.json',
      '/health/live',
      '/health/ready',
      '/v1/sessions',
      '/v1/sessions/{id}/events',
      '/v1/sessions/{id}/close',
      '/v1/proposals',
      '/v1/proposals/{id}/decision',
      '/v1/context/resolve',
      '/v1/memories',
      '/v1/memories/{id}',
      '/v1/memories/{id}/corrections',
      '/v1/memories/{id}/retractions',
      '/v1/memories/{id}/forget/prepare',
      '/v1/memories/{id}/forget',
      '/v1/memories/feedback',
      '/v1/jobs/{id}',
      '/v1/admin/overview',
      '/v1/admin/capabilities',
      '/v1/admin/memories',
      '/v1/admin/memories/{id}',
      '/v1/admin/conflicts',
      '/v1/admin/conflicts/{id}/resolution',
      '/v1/admin/sessions',
      '/v1/admin/sessions/{id}',
      '/v1/admin/jobs',
      '/v1/admin/jobs/{id}/attempts',
      '/v1/admin/retention',
      '/v1/admin/retention/run',
      '/v1/admin/exports/corpus',
      '/v1/admin/restore/corpus',
    ];

    expect(Object.keys(openApiDocument.paths ?? {})).toEqual(expectedPaths);
  });
});
