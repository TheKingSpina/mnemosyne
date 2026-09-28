import {
  CoreMemoryService,
  DeterministicEmbeddingProvider,
  createAccessPolicy,
  createIssuedTokenAccessPolicy,
  type AccessPolicy,
} from '@mnemosyne/core';
import {
  PostgresClientTokenStore,
  PostgresMemoryRepository,
  PostgresSemanticSearchIndex,
} from '@mnemosyne/postgres';
import { connectCorpusCache } from '@mnemosyne/redis';
import type { MemoryActor } from '@mnemosyne/contracts';
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
const staticAccessPolicy: AccessPolicy = createAccessPolicy({ ownerToken, harnessToken });
const stdioProfile = process.env.MCP_PROFILE === 'owner' ? 'owner' : 'harness';
const maxRequestBodyBytes = Number(process.env.MCP_MAX_REQUEST_BODY_BYTES ?? 1_048_576);
const maxSessions = Number(process.env.MCP_MAX_SESSIONS ?? 1_000);
const sessionIdleTimeoutMs = Number(process.env.MCP_SESSION_IDLE_TIMEOUT_MS ?? 1_800_000);
const allowedHosts = csvOption(process.env.MCP_ALLOWED_HOSTS);
const allowedOrigins = csvOption(process.env.MCP_ALLOWED_ORIGINS);
// Opt-in escape hatch for a deployment whose perimeter is already the tailnet
// ACL. Anonymous callers get the harness profile by default, which keeps context,
// proposals, sessions and reads working while leaving forget, correct, retract,
// review and export behind a token.
const requireToken = process.env.MNEMOSYNE_MCP_REQUIRE_TOKEN !== 'false';
const anonymousProfile: MemoryActor =
  process.env.MNEMOSYNE_MCP_ANONYMOUS_PROFILE === 'owner' ? 'owner' : 'harness';
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
const clientTokenStore = new PostgresClientTokenStore(pool);
// A per-client token escalates the anonymous harness default to owner, so a
// client can hold its own revocable credential instead of the shared owner one.
const accessPolicy: AccessPolicy = createIssuedTokenAccessPolicy({
  base: staticAccessPolicy,
  lookup: (tokenHash) => clientTokenStore.findActiveByHash(tokenHash),
});
const repository = await PostgresMemoryRepository.fromPool(pool);
const embeddingProvider = new DeterministicEmbeddingProvider();
const semanticSearchIndex = new PostgresSemanticSearchIndex(pool, {
  profile: embeddingProvider.profile,
  dimensions: embeddingProvider.dimensions,
});
// Harnesses re-read the same scopes repeatedly within a task, so MCP caches
// ranked results exactly like the API does. An unset or unreachable REDIS_URL
// degrades to no cache rather than failing startup, and the degradation is
// visible as `projections.redis: false` with `reporter: "mcp"`.
const corpusCache = await connectCorpusCache(process.env.REDIS_URL);
const service = new CoreMemoryService(repository, {
  forgetSecret,
  embeddingProvider,
  semanticSearchIndex,
  corpusCache,
  runtimeCapabilityTtlSeconds: Number(process.env.MNEMOSYNE_RUNTIME_CAPABILITY_TTL_SECONDS ?? 300),
  reporter: 'mcp',
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
    requireToken,
    anonymousProfile,
  });
  server.listen(port, host, () => {
    process.stdout.write(
      `Mnemosyne MCP listening on ${host}:${port} (token ${requireToken ? 'required' : 'not required'}, anonymous profile ${anonymousProfile})\n`,
    );
  });
}

function csvOption(value: string | undefined): string[] | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
