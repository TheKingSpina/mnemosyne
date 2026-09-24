import { CoreMemoryService, InMemoryRepository } from '@mnemosyne/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from './server.js';

const closeables: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
});

function createService(): CoreMemoryService {
  return new CoreMemoryService(new InMemoryRepository(), {
    forgetSecret: 'forget-secret-that-is-long-enough-for-tests-0123456789',
  });
}

async function connect(profile: 'harness' | 'owner') {
  const server = createMcpServer(createService(), profile);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  closeables.push(server, client);
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe('Mnemosyne MCP tool profiles', () => {
  it('does not expose owner tools in the harness profile', async () => {
    const { client } = await connect('harness');
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'memory_open_session',
        'memory_record_events',
        'memory_context',
        'memory_search',
        'memory_propose',
        'memory_close_session',
        'memory_get_job',
      ]),
    );
    expect(tools.map((tool) => tool.name)).not.toContain('memory_review_decision');
    expect(tools.map((tool) => tool.name)).not.toContain('memory_resolve_conflict');
  });

  it('exposes owner conflict administration in the owner profile', async () => {
    const { client } = await connect('owner');
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['memory_list_conflicts', 'memory_resolve_conflict']),
    );
    expect(tools.map((tool) => tool.name)).toContain('memory_admin_capabilities');
  });

  it('resolves a conflict through the owner MCP tool', async () => {
    const service = createService();
    const server = createMcpServer(service, 'owner');
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(server, client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const session = await service.openSession({ projectId: 'synthetic-project' });
    await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content: 'Il progetto usa pnpm',
        kind: 'convention',
        scope: { type: 'project', id: 'synthetic-project' },
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
    const contradiction = await service.proposeMemory({
      sessionId: session.sessionId,
      content: 'Il progetto non usa pnpm',
      kind: 'convention',
      scope: { type: 'project', id: 'synthetic-project' },
      epistemicBasis: 'user_asserted',
      assessment: 'disputed',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: [],
    });

    const response = await client.callTool({
      name: 'memory_resolve_conflict',
      arguments: { conflictId: contradiction.conflictId },
    });
    const conflicts = await service.listConflicts();

    expect(response.isError).not.toBe(true);
    expect(conflicts.items[0]?.status).toBe('resolved');
  });
});
