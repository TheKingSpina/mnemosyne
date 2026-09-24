import { CoreMemoryService } from '@mnemosyne/core';
import { PostgresMemoryRepository } from '@mnemosyne/postgres';
import { createApiServer } from './app.js';

const connectionString = process.env.DATABASE_URL;
const forgetSecret = process.env.MNEMOSYNE_FORGET_SECRET;
if (!connectionString || !forgetSecret) {
  throw new Error('DATABASE_URL and MNEMOSYNE_FORGET_SECRET are required');
}

const repository = await PostgresMemoryRepository.fromConnectionString(connectionString);
const service = new CoreMemoryService(repository, { forgetSecret });
const host = process.env.API_HOST ?? '127.0.0.1';
const port = Number(process.env.API_PORT ?? 3000);
const server = createApiServer(service);
server.listen(port, host, () => {
  process.stdout.write(`Mnemosyne API listening on ${host}:${port}\n`);
});
