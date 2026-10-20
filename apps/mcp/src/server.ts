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
  listProjectMemoriesInputSchema,
  corpusExportSchema,
  memoryFeedbackSchema,
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

// A harness reads the corpus through a session: that is where its scopes come
// from, and without one it has nothing it is allowed to read. The owner is the
// operator and may read without a session, so the same tool carries a
// different required set per profile.
function sessionField(profile: 'harness' | 'owner') {
  return profile === 'harness' ? z.string().min(1) : z.string().min(1).optional();
}

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
    { name: 'mnemosyne', version: '0.1.0' },
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

  // Exploration. Search answers a question but does not show the shape of the
  // corpus, so an agent that only searches has to guess the terms and reads a
  // miss as an empty project. These four tools let it walk the corpus from
  // the outside in.
  server.registerTool(
    'memory_list_projects',
    {
      description:
        'List every project of the corpus with its size: how many memories it holds, how many are still awaiting approval, how many conflicts it has. Start here, because the project id is what memory_open_session needs.',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async () =>
      result(
        await authorized(profile, 'memory.read', async () => ({
          projects: await service.listProjectSummaries(),
        })),
      ),
  );

  server.registerTool(
    'memory_get_project',
    {
      description:
        'Read one project whole: its areas, how its memories break down by kind, lifecycle and scope, its most recent memories, its open conflicts and its project relations.',
      inputSchema: {
        projectId: z.string().min(1),
        sessionId: sessionField(profile),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) =>
      result(
        await authorized(profile, 'memory.read', () =>
          service.getProjectOutline({
            projectId: input.projectId,
            context: { actor: profile, sessionId: input.sessionId },
            limit: input.limit,
          }),
        ),
      ),
  );

  server.registerTool(
    'memory_list_project_memories',
    {
      description:
        'List the memories of one project, with filters on kind, scope and text. The result is paginated and ordered by the most recently updated first. A harness sees the accepted memories of its session, so a lifecycle filter other than accepted returns nothing.',
      inputSchema: {
        ...shape(listProjectMemoriesInputSchema),
        sessionId: sessionField(profile),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) =>
      result(
        await authorized(profile, 'memory.read', () =>
          service.listProjectMemories({
            projectId: input.projectId,
            context: { actor: profile, sessionId: input.sessionId },
            kind: input.kind,
            lifecycle: input.lifecycle,
            scopeType: input.scopeType,
            scopeId: input.scopeId,
            q: input.q,
            limit: input.limit,
            offset: input.offset,
          }),
        ),
      ),
  );

  server.registerTool(
    'memory_get_memory',
    {
      description:
        'Read one memory with its relations and conflicts. Use it to go deeper on an id returned by a search or by a project listing.',
      inputSchema: {
        memoryId: z.string().min(1),
        sessionId: sessionField(profile),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) =>
      result(
        await authorized(profile, 'memory.read', () =>
          service.getMemoryDetail({
            memoryId: input.memoryId,
            context: { actor: profile, sessionId: input.sessionId },
          }),
        ),
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

  // Arcs follow the same rule as memories: a harness may propose one, only the
  // owner may accept it.
  server.registerTool(
    'memory_propose_arc',
    {
      description:
        'Propose a directed, optionally weighted arc between two memories. It lands pending approval; only the owner can accept it. Influences may form cycles.',
      inputSchema: {
        sessionId: z.string().min(1),
        fromMemoryId: z.string().min(1),
        toMemoryId: z.string().min(1),
        type: z.string().min(1).max(100),
        weight: z.number().min(0).max(1).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (input) =>
      result(
        await authorized(profile, 'memory.propose', async () => {
          await service.assertSessionAccessible(input.sessionId);
          return service.proposeMemoryArc(
            {
              fromMemoryId: input.fromMemoryId,
              toMemoryId: input.toMemoryId,
              type: input.type,
              weight: input.weight,
            },
            { actor: 'harness', explicitDirective: false },
          );
        }),
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
      'memory_restore',
      {
        description: 'Restore a canonical corpus into an empty database.',
        inputSchema: shape(corpusExportSchema),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      },
      async (input) =>
        result(
          await authorized(profile, 'proposal.review', () =>
            service.restoreCorpus(corpusExportSchema.parse(input)),
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
      'memory_feedback',
      {
        description: 'Record non-destructive owner feedback about a memory.',
        inputSchema: shape(memoryFeedbackSchema),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async (input) =>
        result(await authorized(profile, 'proposal.review', () => service.submitFeedback(input))),
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
      'memory_admin_retrieval_telemetry',
      {
        description:
          'Read aggregate retrieval counters for this process: which path served each query, candidate and result distributions, top score bands. Counts and bands only, never queries or content.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async () => result(service.getRetrievalTelemetry()),
    );

    server.registerTool(
      'memory_admin_embedding_health',
      {
        description:
          'Compare the corpus against the semantic index. A corpus restore does not rebuild embeddings, so this is how a silent degradation to lexical-only search becomes visible.',
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
      },
      async () =>
        result(
          await authorized(profile, 'proposal.review', () => service.getEmbeddingIndexHealth()),
        ),
    );

    server.registerTool(
      'memory_admin_reindex_embeddings',
      {
        description:
          'Rebuild every embedding for the active profile. Idempotent, and the supported recovery step after a corpus restore.',
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      },
      async () =>
        result(await authorized(profile, 'proposal.review', () => service.reindexEmbeddings())),
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
      'memory_review_arc',
      {
        description: 'Accept or reject a pending arc. Accepting is what puts it in the graph.',
        inputSchema: { arcId: z.string().min(1), decision: z.enum(['accept', 'reject']) },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      },
      async ({ arcId, decision }) =>
        result(
          await authorized(profile, 'proposal.review', async () => {
            try {
              return await service.reviewMemoryArc(arcId, decision);
            } catch {
              // The id belongs to exactly one arc table, so a miss here means it
              // was a project arc.
              return service.reviewProjectArc(arcId, decision);
            }
          }),
        ),
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
