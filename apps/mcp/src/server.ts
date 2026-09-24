import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toDomainError, type MemoryService } from '@mnemosyne/core';
import {
  contextInputSchema,
  ownerProposalSubmissionSchema,
  openSessionInputSchema,
  proposeMemoryInputSchema,
  recordEventsInputSchema,
  searchMemoriesInputSchema,
} from '@mnemosyne/contracts';
import { z } from 'zod';

const openSessionShape = shape(openSessionInputSchema);
const recordEventsShape = shape(recordEventsInputSchema);
const proposeShape = shape(proposeMemoryInputSchema);
const contextShape = shape(contextInputSchema);
const searchShape = shape(searchMemoriesInputSchema);

export function createMcpServer(service: MemoryService, profile: 'harness' | 'owner'): McpServer {
  const server = new McpServer(
    { name: 'mnemosyne', version: '0.0.0' },
    { instructions: 'Persistent, governed memory for LLM harnesses.' },
  );

  server.registerTool(
    'memory_open_session',
    {
      description: 'Open a governed memory session.',
      inputSchema: openSessionShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) => result(await service.openSession(input)),
  );

  server.registerTool(
    'memory_record_events',
    {
      description: 'Append incremental conversation events to a session.',
      inputSchema: recordEventsShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => result(await service.recordEvents(input)),
  );

  server.registerTool(
    'memory_context',
    {
      description: 'Resolve approved memories relevant to the current task.',
      inputSchema: contextShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => result(await service.resolveContext(input)),
  );

  server.registerTool(
    'memory_search',
    {
      description: 'Search approved memories.',
      inputSchema: searchShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => result({ items: await service.searchMemories(input) }),
  );

  server.registerTool(
    'memory_propose',
    {
      description: 'Propose a memory; the server applies the governing policy.',
      inputSchema: proposeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      result(await service.proposeMemory(input, { actor: 'harness', explicitDirective: false })),
  );

  server.registerTool(
    'memory_close_session',
    {
      description: 'Close a memory session and queue consolidation.',
      inputSchema: { sessionId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ sessionId }) => result(await service.closeSession(sessionId)),
  );

  server.registerTool(
    'memory_get_job',
    {
      description: 'Read a background job created by this server.',
      inputSchema: { jobId: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ jobId }) => {
      const value = await service.getJob(jobId);
      return result(value ?? { error: 'job_not_found' });
    },
  );

  if (profile === 'owner') {
    server.registerTool(
      'memory_propose_owner',
      {
        description: 'Submit an owner-authorized memory proposal.',
        inputSchema: shape(ownerProposalSubmissionSchema),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async (input) =>
        result(
          await service.proposeMemory(input, {
            actor: 'owner',
            explicitDirective: input.explicitDirective,
          }),
        ),
    );

    server.registerTool(
      'memory_correct',
      {
        description: 'Create a new version of an approved memory.',
        inputSchema: {
          memoryId: z.string().min(1),
          expectedVersion: z.number().int().positive(),
          content: z.string().min(1).max(10_000),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async (input) => result(await service.correctMemory(input)),
    );

    server.registerTool(
      'memory_retract',
      {
        description: 'Mark an approved memory as false.',
        inputSchema: { memoryId: z.string().min(1), reason: z.string().min(1).max(2_000) },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      async (input) => result(await service.retractMemory(input.memoryId, input.reason)),
    );

    server.registerTool(
      'memory_prepare_forget',
      {
        description: 'Prepare a confirmed, expiring forget operation.',
        inputSchema: { memoryId: z.string().min(1) },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
      },
      async ({ memoryId }) => result(await service.prepareForget(memoryId)),
    );

    server.registerTool(
      'memory_forget',
      {
        description: 'Irreversibly forget a memory after confirmation.',
        inputSchema: { memoryId: z.string().min(1), confirmationToken: z.string().min(1) },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      async ({ memoryId, confirmationToken }) => {
        await service.forgetMemory(memoryId, confirmationToken);
        return result({ forgotten: true });
      },
    );
  }

  return server;
}

function shape<T extends z.ZodObject<z.ZodRawShape>>(schema: T): T['_def']['shape'] {
  return schema.shape;
}

function result(value: unknown) {
  return {
    structuredContent: value as Record<string, unknown>,
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  };
}

export function mcpError(error: unknown) {
  const domainError = toDomainError(error);
  return {
    isError: true,
    structuredContent: { code: domainError.code, status: domainError.status },
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ code: domainError.code, status: domainError.status }),
      },
    ],
  };
}
