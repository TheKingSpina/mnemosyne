import {
  CoreMemoryService,
  DeterministicEmbeddingProvider,
  InMemoryRepository,
  InMemorySemanticSearchIndex,
} from '@mnemosyne/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from './server.js';

const closeables: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(closeables.splice(0).map((closeable) => closeable.close()));
});

function createService(): CoreMemoryService {
  const embeddingProvider = new DeterministicEmbeddingProvider();
  return new CoreMemoryService(new InMemoryRepository(), {
    forgetSecret: 'forget-secret-that-is-long-enough-for-tests-0123456789',
    embeddingProvider,
    semanticSearchIndex: new InMemorySemanticSearchIndex({
      profile: embeddingProvider.profile,
      dimensions: embeddingProvider.dimensions,
    }),
  });
}

async function connect(profile: 'harness' | 'owner') {
  const server = createMcpServer(createService(), profile);
  const client = new Client({ name: 'test-client', version: '0.1.0' });
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

  it('exposes the exploration tools in both profiles', async () => {
    const harness = await connect('harness');
    const owner = await connect('owner');
    const exploration = [
      'memory_list_projects',
      'memory_get_project',
      'memory_list_project_memories',
      'memory_get_memory',
    ];

    for (const client of [harness.client, owner.client]) {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(exploration));
    }
  });

  it('requires a session from the harness and not from the owner', async () => {
    const harness = await connect('harness');
    const owner = await connect('owner');

    const harnessTool = (await harness.client.listTools()).tools.find(
      (tool) => tool.name === 'memory_get_project',
    );
    const ownerTool = (await owner.client.listTools()).tools.find(
      (tool) => tool.name === 'memory_get_project',
    );

    expect(harnessTool?.inputSchema.required).toContain('sessionId');
    expect(ownerTool?.inputSchema.required).not.toContain('sessionId');
  });

  it('exposes owner conflict administration in the owner profile', async () => {
    const { client } = await connect('owner');
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['memory_list_conflicts', 'memory_resolve_conflict']),
    );
    expect(tools.map((tool) => tool.name)).toContain('memory_admin_capabilities');
    expect(tools.map((tool) => tool.name)).toContain('memory_export');
    expect(tools.map((tool) => tool.name)).toContain('memory_restore');
    expect(tools.map((tool) => tool.name)).toContain('memory_retention_status');
    expect(tools.map((tool) => tool.name)).toContain('memory_run_retention');
    expect(tools.map((tool) => tool.name)).toContain('memory_feedback');
  });

  it('reports semantic search capabilities for the owner profile', async () => {
    const { client } = await connect('owner');
    const response = await client.callTool({
      name: 'memory_admin_capabilities',
      arguments: {},
    });

    expect(response.isError).not.toBe(true);
    expect(response).toHaveProperty(
      'content.0.text',
      expect.stringContaining('"semanticSearch":true'),
    );
  });

  it('resolves a conflict through the owner MCP tool', async () => {
    const service = createService();
    const server = createMcpServer(service, 'owner');
    const client = new Client({ name: 'test-client', version: '0.1.0' });
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

describe('Mnemosyne MCP exploration tools', () => {
  it('walks a harness from the project list to a single memory', async () => {
    const service = createService();
    const server = createMcpServer(service, 'harness');
    const client = new Client({ name: 'test-client', version: '0.1.0' });
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

    const projects = await client.callTool({ name: 'memory_list_projects', arguments: {} });
    const listed = await client.callTool({
      name: 'memory_list_project_memories',
      arguments: { projectId: 'synthetic-project', sessionId: session.sessionId },
    });
    const memoryId = (listed.structuredContent as { items: { memoryId: string }[] }).items[0]
      ?.memoryId;
    const detail = await client.callTool({
      name: 'memory_get_memory',
      arguments: { memoryId: memoryId ?? '', sessionId: session.sessionId },
    });

    expect(projects.isError).not.toBe(true);
    expect(projects.structuredContent).toHaveProperty('projects.0.id', 'synthetic-project');
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toHaveProperty('total', 1);
    expect(detail.isError).not.toBe(true);
    expect(detail.structuredContent).toHaveProperty('memory.content', 'Il progetto usa pnpm');
  });

  it('shows a harness the outline of the project its session belongs to', async () => {
    const service = createService();
    const server = createMcpServer(service, 'harness');
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(server, client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const session = await service.openSession({ projectId: 'synthetic-project' });

    const response = await client.callTool({
      name: 'memory_get_project',
      arguments: { projectId: 'synthetic-project', sessionId: session.sessionId },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toHaveProperty('project.id', 'synthetic-project');
    expect(response.structuredContent).toHaveProperty('counts.byKind.fact', 0);
  });

  it('refuses a harness that reads a project without a session', async () => {
    const service = createService();
    const server = createMcpServer(service, 'harness');
    const client = new Client({ name: 'test-client', version: '0.1.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    closeables.push(server, client);
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const response = await client.callTool({
      name: 'memory_list_project_memories',
      arguments: { projectId: 'synthetic-project' },
    });

    expect(response.isError).toBe(true);
  });
});
