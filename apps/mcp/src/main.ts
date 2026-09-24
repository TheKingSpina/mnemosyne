import { CoreMemoryService } from '@mnemosyne/core';
import { PostgresMemoryRepository } from '@mnemosyne/postgres';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer } from './server.js';

const connectionString = process.env.DATABASE_URL;
const forgetSecret = process.env.MNEMOSYNE_FORGET_SECRET;
if (!connectionString || !forgetSecret) {
  throw new Error('DATABASE_URL and MNEMOSYNE_FORGET_SECRET are required');
}
const profile = process.env.MCP_PROFILE === 'owner' ? 'owner' : 'harness';
const repository = await PostgresMemoryRepository.fromConnectionString(connectionString);
const service = new CoreMemoryService(repository, { forgetSecret });
const server = createMcpServer(service, profile);
await server.connect(new StdioServerTransport());
