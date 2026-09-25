import {
  CoreMemoryService,
  DeterministicEmbeddingProvider,
  createAccessPolicy,
  type AccessPolicy,
} from '@mnemosyne/core';
import { PostgresMemoryRepository, PostgresSemanticSearchIndex } from '@mnemosyne/postgres';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Pool } from 'pg';
import { createMcpServer } from './server.js';
import { createMcpHttpServer } from './http.js';

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
const stdioProfile = process.env.MCP_PROFILE === 'owner' ? 'owner' : 'harness';
const maxRequestBodyBytes = Number(process.env.MCP_MAX_REQUEST_BODY_BYTES ?? 1_048_576);
const maxSessions = Number(process.env.MCP_MAX_SESSIONS ?? 1_000);
const sessionIdleTimeoutMs = Number(process.env.MCP_SESSION_IDLE_TIMEOUT_MS ?? 1_800_000);
const allowedHosts = csvOption(process.env.MCP_ALLOWED_HOSTS);
const allowedOrigins = csvOption(process.env.MCP_ALLOWED_ORIGINS);
if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes <= 0) {
  throw new Error('MCP_MAX_REQUEST_BODY_BYTES must be a positive integer');
}
if (!Number.isSafeInteger(maxSessions) || maxSessions <= 0) {
  throw new Error('MCP_MAX_SESSIONS must be a positive integer');
}
if (!Number.isSafeInteger(sessionIdleTimeoutMs) || sessionIdleTimeoutMs < 1_000) {
  throw new Error('MCP_SESSION_IDLE_TIMEOUT_MS must be at least 1000');
}
const pool = new Pool({ connectionString });
const repository = await PostgresMemoryRepository.fromPool(pool);
const embeddingProvider = new DeterministicEmbeddingProvider();
const semanticSearchIndex = new PostgresSemanticSearchIndex(pool, {
  profile: embeddingProvider.profile,
  dimensions: embeddingProvider.dimensions,
});
const service = new CoreMemoryService(repository, {
  forgetSecret,
  embeddingProvider,
  semanticSearchIndex,
});

if (process.env.MCP_TRANSPORT !== 'http') {
  const server = createMcpServer(service, stdioProfile);
  await server.connect(new StdioServerTransport());
} else {
  const host = process.env.MCP_HOST ?? '127.0.0.1';
  const port = Number(process.env.MCP_PORT ?? 3333);
  const server = createMcpHttpServer(service, accessPolicy, {
    maxRequestBodyBytes,
    maxSessions,
    sessionIdleTimeoutMs,
    enableDnsRebindingProtection: allowedHosts !== undefined || allowedOrigins !== undefined,
    allowedHosts,
    allowedOrigins,
  });
  server.listen(port, host, () => {
    process.stdout.write(`Mnemosyne MCP listening on ${host}:${port}\n`);
  });
}

function csvOption(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
