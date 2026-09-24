import { CoreMemoryService, createAccessPolicy } from '@mnemosyne/core';
import { PostgresMemoryRepository } from '@mnemosyne/postgres';
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

const repository = await PostgresMemoryRepository.fromConnectionString(connectionString);
const service = new CoreMemoryService(repository, { forgetSecret });
const host = process.env.API_HOST ?? '127.0.0.1';
const port = Number(process.env.API_PORT ?? 3000);
const server = createApiServer(service, {
  accessPolicy: createAccessPolicy({ ownerToken, harnessToken }),
});
server.listen(port, host, () => {
  process.stdout.write(`Mnemosyne API listening on ${host}:${port}\n`);
});
