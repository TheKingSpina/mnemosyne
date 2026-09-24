import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  assertMemoryPermission,
  toDomainError,
  type MemoryPermission,
  type MemoryService,
} from '@mnemosyne/core';
import {
  contextInputSchema,
  listPendingProposalsInputSchema,
  listAdminMemoriesInputSchema,
  listAdminJobsInputSchema,
  listAdminSessionsInputSchema,
  corpusExportSchema,
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
const pendingShape = shape(listPendingProposalsInputSchema);
const adminMemoriesShape = shape(listAdminMemoriesInputSchema);
const adminJobsShape = shape(listAdminJobsInputSchema);
const adminSessionsShape = shape(listAdminSessionsInputSchema);

async function authorized<T>(
  profile: 'harness' | 'owner',
  permission: MemoryPermission,
  operation: () => Promise<T>,
): Promise<T> {
  assertMemoryPermission(profile, permission);
  return operation();
}

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
    async (input) =>
      result(await authorized(profile, 'session.manage', () => service.openSession(input))),
  );

  server.registerTool(
    'memory_record_events',
    {
      description: 'Append incremental conversation events to a session.',
      inputSchema: recordEventsShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) =>
      result(await authorized(profile, 'events.write', () => service.recordEvents(input))),
  );

  server.registerTool(
    'memory_context',
    {
      description: 'Resolve approved memories relevant to the current task.',
      inputSchema: contextShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) =>
      result(await authorized(profile, 'context.resolve', () => service.resolveContext(input))),
  );

  server.registerTool(
    'memory_search',
    {
      description: 'Search approved memories.',
      inputSchema: searchShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) =>
      result(
        await authorized(profile, 'memory.read', async () => ({
          items: await service.searchMemories(input),
        })),
      ),
  );

  server.registerTool(
    'memory_propose',
    {
      description: 'Propose a memory; the server applies the governing policy.',
      inputSchema: proposeShape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      result(
        await authorized(profile, 'memory.propose', () =>
          service.proposeMemory(input, { actor: 'harness', explicitDirective: false }),
        ),
      ),
  );

  server.registerTool(
    'memory_close_session',
    {
      description: 'Close a memory session and queue consolidation.',
      inputSchema: { sessionId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ sessionId }) =>
      result(await authorized(profile, 'session.manage', () => service.closeSession(sessionId))),
  );

  server.registerTool(
    'memory_get_job',
    {
      description: 'Read a background job created by this server.',
      inputSchema: { jobId: z.string().min(1) },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async ({ jobId }) => {
      const value = await authorized(profile, 'job.read', () => service.getJob(jobId));
      return result(value ?? { error: 'job_not_found' });
    },
  );

  if (profile === 'owner') {
    server.registerTool(
      'memory_export',
      {
        description: 'Export the canonical corpus for owner-controlled backup and migration.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async () =>
        result(
          await authorized(profile, 'proposal.review', async () =>
            corpusExportSchema.parse(await service.listCorpusExport()),
          ),
        ),
    );

    server.registerTool(
      'memory_retention_status',
      {
        description: 'Read the configured retention profile and last owner run.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async () =>
        result(await authorized(profile, 'proposal.review', () => service.getRetentionStatus())),
    );

    server.registerTool(
      'memory_run_retention',
      {
        description: 'Run the governed balanced retention policy.',
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      async () =>
        result(await authorized(profile, 'proposal.review', () => service.runRetention())),
    );

    server.registerTool(
      'memory_admin_overview',
      {
        description: 'Read aggregate owner administration metrics.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async () =>
        result(await authorized(profile, 'proposal.review', () => service.getAdminOverview())),
    );

    server.registerTool(
      'memory_admin_capabilities',
      {
        description: 'Read implemented and missing service capabilities.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async () =>
        result(await authorized(profile, 'proposal.review', () => service.getAdminCapabilities())),
    );

    server.registerTool(
      'memory_admin_memories',
      {
        description: 'List owner memory views with lifecycle, kind, and scope filters.',
        inputSchema: adminMemoriesShape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async (input) =>
        result(
          await authorized(profile, 'proposal.review', () => service.listAdminMemories(input)),
        ),
    );

    server.registerTool(
      'memory_admin_sessions',
      {
        description: 'List owner session administration views.',
        inputSchema: adminSessionsShape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async (input) =>
        result(
          await authorized(profile, 'proposal.review', () => service.listAdminSessions(input)),
        ),
    );

    server.registerTool(
      'memory_admin_jobs',
      {
        description: 'List owner background job administration views.',
        inputSchema: adminJobsShape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async (input) =>
        result(await authorized(profile, 'proposal.review', () => service.listAdminJobs(input))),
    );

    server.registerTool(
      'memory_list_conflicts',
      {
        description: 'List owner conflict records.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async () =>
        result(await authorized(profile, 'proposal.review', () => service.listConflicts())),
    );

    server.registerTool(
      'memory_resolve_conflict',
      {
        description: 'Mark a memory conflict as resolved.',
        inputSchema: { conflictId: z.string().min(1) },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async ({ conflictId }) =>
        result(
          await authorized(profile, 'proposal.review', () => service.resolveConflict(conflictId)),
        ),
    );

    server.registerTool(
      'memory_pending_review',
      {
        description: 'List pending memory proposals visible to the current session.',
        inputSchema: pendingShape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async (input) => {
        try {
          assertMemoryPermission(profile, 'proposal.review');
          return result(await service.listPendingProposals(input));
        } catch (error) {
          return mcpError(error);
        }
      },
    );

    server.registerTool(
      'memory_review_decision',
      {
        description: 'Accept, reject, or amend a pending memory proposal.',
        inputSchema: {
          memoryId: z.string().min(1),
          expectedVersion: z.number().int().positive(),
          decision: z.enum(['accept', 'reject']),
          finalContent: z.string().min(1).max(10_000).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async (input) => {
        try {
          assertMemoryPermission(profile, 'proposal.review');
          return result(await service.reviewProposal(input));
        } catch (error) {
          return mcpError(error);
        }
      },
    );

    server.registerTool(
      'memory_propose_owner',
      {
        description: 'Submit an owner-authorized memory proposal.',
        inputSchema: shape(ownerProposalSubmissionSchema),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async (input) => {
        try {
          assertMemoryPermission(profile, 'proposal.owner');
          return result(
            await service.proposeMemory(input, {
              actor: 'owner',
              explicitDirective: input.explicitDirective,
            }),
          );
        } catch (error) {
          return mcpError(error);
        }
      },
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
      async (input) =>
        result(await authorized(profile, 'memory.correct', () => service.correctMemory(input))),
    );

    server.registerTool(
      'memory_retract',
      {
        description: 'Mark an approved memory as false.',
        inputSchema: { memoryId: z.string().min(1), reason: z.string().min(1).max(2_000) },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      async (input) =>
        result(
          await authorized(profile, 'memory.retract', () =>
            service.retractMemory(input.memoryId, input.reason),
          ),
        ),
    );

    server.registerTool(
      'memory_prepare_forget',
      {
        description: 'Prepare a confirmed, expiring forget operation.',
        inputSchema: { memoryId: z.string().min(1) },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false },
      },
      async ({ memoryId }) =>
        result(await authorized(profile, 'memory.forget', () => service.prepareForget(memoryId))),
    );

    server.registerTool(
      'memory_forget',
      {
        description: 'Irreversibly forget a memory after confirmation.',
        inputSchema: { memoryId: z.string().min(1), confirmationToken: z.string().min(1) },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      async ({ memoryId, confirmationToken }) => {
        await authorized(profile, 'memory.forget', () =>
          service.forgetMemory(memoryId, confirmationToken),
        );
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
