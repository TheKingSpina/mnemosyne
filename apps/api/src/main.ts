import {
  CoreMemoryService,
  DeterministicEmbeddingProvider,
  createAccessPolicy,
  createIssuedTokenAccessPolicy,
} from '@mnemosyne/core';
import {
  PostgresClientTokenStore,
  PostgresIdempotencyStore,
  PostgresMemoryRepository,
  PostgresSemanticSearchIndex,
} from '@mnemosyne/postgres';
import { connectCorpusCache } from '@mnemosyne/redis';
import { Pool } from 'pg';
import { RemotePruningAnalyzer } from '@mnemosyne/core';
import { createApiServer } from './app.js';

const connectionString = process.env.DATABASE_URL;
const forgetSecret = process.env.MNEMOSYNE_FORGET_SECRET;
const ownerToken = process.env.MNEMOSYNE_OWNER_TOKEN;
const harnessToken = process.env.MNEMOSYNE_HARNESS_TOKEN;
if (!connectionString || !forgetSecret || !ownerToken || !harnessToken) {
  throw new Error(
    'DATABASE_URL, MNEMOSYNE_FORGET_SECRET, MNEMOSYNE_OWNER_TOKEN, and MNEMOSYNE_HARNESS_TOKEN are required',
  );
}

const pool = new Pool({
  connectionString,
  connectionTimeoutMillis: Number(process.env.PG_CONNECTION_TIMEOUT_MS ?? 10_000),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS ?? 30_000),
});
const repository = await PostgresMemoryRepository.fromPool(pool);
const embeddingProvider = new DeterministicEmbeddingProvider();
const semanticSearchIndex = new PostgresSemanticSearchIndex(pool, {
  profile: embeddingProvider.profile,
  dimensions: embeddingProvider.dimensions,
});
const corpusCache = await connectCorpusCache(process.env.REDIS_URL);
const service = new CoreMemoryService(repository, {
  forgetSecret,
  embeddingProvider,
  semanticSearchIndex,
  corpusCache,
  runtimeCapabilityTtlSeconds: Number(process.env.MNEMOSYNE_RUNTIME_CAPABILITY_TTL_SECONDS ?? 300),
  reporter: 'api',
});
const host = process.env.API_HOST ?? '127.0.0.1';
const port = Number(process.env.API_PORT ?? 3000);
const clientTokenStore = new PostgresClientTokenStore(pool);
// Analyzer enablement is explicit and off by default: without the flag, or
// without a key and a model, the endpoint answers disabled and nothing leaves.
// Credentials come from env only, never the repo.
const pruningAnalyzerEnabled = process.env.PRUNING_ANALYZER_ENABLED === 'true';
const pruningAnalyzer =
  pruningAnalyzerEnabled &&
  process.env.PRUNING_ANALYZER_API_KEY &&
  process.env.PRUNING_ANALYZER_MODEL
    ? new RemotePruningAnalyzer({
        apiKey: process.env.PRUNING_ANALYZER_API_KEY,
        model: process.env.PRUNING_ANALYZER_MODEL,
        baseUrl: process.env.PRUNING_ANALYZER_BASE_URL,
      })
    : null;
if (pruningAnalyzerEnabled && !pruningAnalyzer) {
  throw new Error('PRUNING_ANALYZER_API_KEY and PRUNING_ANALYZER_MODEL are required together');
}
const server = createApiServer(service, {
  accessPolicy: createIssuedTokenAccessPolicy({
    base: createAccessPolicy({ ownerToken, harnessToken }),
    lookup: (tokenHash) => clientTokenStore.findActiveByHash(tokenHash),
  }),
  idempotencyStore: new PostgresIdempotencyStore(pool),
  clientTokenStore,
  requireIdempotencyKey: true,
  pruningAnalyzer,
});
// Node's default keepAliveTimeout (5s) is too short for clients that reuse
// connections across Tailscale with gaps between requests: the server closes
// the socket and the next call surfaces as a socket hang-up / timeout. Keep
// idle connections alive long enough to outlive a normal think pause.
server.keepAliveTimeout = Number(process.env.API_KEEP_ALIVE_TIMEOUT_MS ?? 120_000);
server.headersTimeout = server.keepAliveTimeout + 5_000;
server.timeout = Number(process.env.API_REQUEST_TIMEOUT_MS ?? 300_000);
server.listen(port, host, () => {
  process.stdout.write(`Mnemosyne API listening on ${host}:${port}\n`);
});
