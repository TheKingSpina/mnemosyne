import {
  CoreMemoryService,
  DeterministicEmbeddingProvider,
  createAccessPolicy,
} from '@mnemosyne/core';
import {
  PostgresIdempotencyStore,
  PostgresMemoryRepository,
  PostgresSemanticSearchIndex,
} from '@mnemosyne/postgres';
import { Pool } from 'pg';
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
const host = process.env.API_HOST ?? '127.0.0.1';
const port = Number(process.env.API_PORT ?? 3000);
const server = createApiServer(service, {
  accessPolicy: createAccessPolicy({ ownerToken, harnessToken }),
  idempotencyStore: new PostgresIdempotencyStore(pool),
  requireIdempotencyKey: true,
});
server.listen(port, host, () => {
  process.stdout.write(`Mnemosyne API listening on ${host}:${port}\n`);
});
