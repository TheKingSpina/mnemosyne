import { describe, expect, it, vi } from 'vitest';
import type { MemoryKind } from '@mnemosyne/contracts';
import { CoreMemoryService, InMemoryCorpusCache, InMemoryRepository } from './index.js';

// Exploration is the read path an agent uses when it does not know what it is
// looking for. The rule it follows is the one search already follows: a
// harness reads the accepted memories its session can reach, the owner reads
// the corpus as it is.

function createService(repository: InMemoryRepository): CoreMemoryService {
  return new CoreMemoryService(repository, {
    forgetSecret: 'a-secure-test-secret-that-is-long-enough',
  });
}

async function propose(
  service: CoreMemoryService,
  sessionId: string,
  input: {
    content: string;
    scope: { type: 'session' | 'project' | 'area'; id: string };
    kind?: MemoryKind;
  },
  actor: 'owner' | 'harness' = 'owner',
): Promise<string> {
  const result = await service.proposeMemory(
    {
      sessionId,
      content: input.content,
      kind: input.kind ?? 'fact',
      scope: input.scope,
      epistemicBasis: 'verified',
      assessment: 'uncontested',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: [],
    },
    { actor, explicitDirective: actor === 'owner' },
  );
  if (!result.memoryId) throw new Error(`proposal_not_accepted:${result.status}`);
  return result.memoryId;
}

describe('project summaries', () => {
  it('lists every project with the size of what it holds', async () => {
    const repository = new InMemoryRepository();
    const service = createService(repository);
    const session = await service.openSession({ projectId: 'alpha' });
    await propose(service, session.sessionId, {
      content: 'il progetto usa pnpm',
      scope: { type: 'project', id: 'alpha' },
    });
    await service.openSession({ projectId: 'beta' });

    const summaries = await service.listProjectSummaries();

    expect(summaries.map((summary) => summary.id).sort()).toEqual(['alpha', 'beta']);
    const alpha = summaries.find((summary) => summary.id === 'alpha');
    expect(alpha?.memoryCount).toBe(1);
    expect(alpha?.acceptedCount).toBe(1);
    expect(alpha?.pendingApprovalCount).toBe(0);
    expect(alpha?.sessionCount).toBe(1);
    expect(alpha?.privacy).toBe('local_only');
    const beta = summaries.find((summary) => summary.id === 'beta');
    expect(beta?.memoryCount).toBe(0);
  });

  it('counts the proposals that are still waiting for the owner', async () => {
    const repository = new InMemoryRepository();
    const service = createService(repository);
    const session = await service.openSession({ projectId: 'alpha' });
    await propose(
      service,
      session.sessionId,
      { content: 'proposta in attesa', scope: { type: 'project', id: 'alpha' } },
      'harness',
    );

    const summaries = await service.listProjectSummaries();

    expect(summaries[0]?.pendingApprovalCount).toBe(1);
    expect(summaries[0]?.acceptedCount).toBe(0);
  });

  it('counts the areas a project declares', async () => {
    const repository = new InMemoryRepository();
    const service = createService(repository);
    await repository.createProject({ id: 'alpha', name: 'Alpha' });
    await repository.createArea({ id: 'area-1', projectId: 'alpha', name: 'design' });

    const summaries = await service.listProjectSummaries();

    expect(summaries[0]?.areaCount).toBe(1);
  });
});

describe('a harness explores only what its session can reach', () => {
  it('lists the accepted memories of its own project', async () => {
    const repository = new InMemoryRepository();
    const service = createService(repository);
    const session = await service.openSession({ projectId: 'alpha' });
    await propose(service, session.sessionId, {
      content: 'memoria accettata',
      scope: { type: 'project', id: 'alpha' },
    });
    await propose(
      service,
      session.sessionId,
      { content: 'memoria in attesa', scope: { type: 'project', id: 'alpha' } },
      'harness',
    );

    const listed = await service.listProjectMemories({
      projectId: 'alpha',
      context: { actor: 'harness', sessionId: session.sessionId },
    });

    expect(listed.total).toBe(1);
    expect(listed.items[0]?.content).toBe('memoria accettata');
    expect(listed.items[0]?.projectId).toBe('alpha');
  });

  it('does not list the memories of another project', async () => {
    const repository = new InMemoryRepository();
    const service = createService(repository);
    const other = await service.openSession({ projectId: 'beta' });
    await propose(service, other.sessionId, {
      content: 'memoria di un altro progetto',
      scope: { type: 'project', id: 'beta' },
    });
    const session = await service.openSession({ projectId: 'alpha' });

    const listed = await service.listProjectMemories({
      projectId: 'beta',
      context: { actor: 'harness', sessionId: session.sessionId },
    });

    expect(listed.total).toBe(0);
    expect(listed.items).toHaveLength(0);
  });

  it('refuses to read without a session, because a session carries the scopes', async () => {
    const repository = new InMemoryRepository();
    const service = createService(repository);
    const session = await service.openSession({ projectId: 'alpha' });
    await propose(service, session.sessionId, {
      content: 'memoria accettata',
      scope: { type: 'project', id: 'alpha' },
    });

    await expect(
      service.listProjectMemories({ projectId: 'alpha', context: { actor: 'harness' } }),
    ).rejects.toThrow('session_id_required');
  });

  it('reads a memory of another project only through the owner', async () => {
    const repository = new InMemoryRepository();
    const service = createService(repository);
    const other = await service.openSession({ projectId: 'beta' });
    const memoryId = await propose(service, other.sessionId, {
      content: 'memoria di un altro progetto',
      scope: { type: 'project', id: 'beta' },
    });
    const session = await service.openSession({ projectId: 'alpha' });

    await expect(
      service.getMemoryDetail({
        memoryId,
        context: { actor: 'harness', sessionId: session.sessionId },
      }),
    ).rejects.toThrow('memory_not_visible');

    const detail = await service.getMemoryDetail({
      memoryId,
      context: { actor: 'owner' },
    });
    expect(detail.memory.content).toBe('memoria di un altro progetto');
  });

  it('hides a conflict that touches a memory the harness cannot read', async () => {
    const repository = new InMemoryRepository();
    const service = createService(repository);
    const alpha = await service.openSession({ projectId: 'alpha' });
    const beta = await service.openSession({ projectId: 'beta' });
    const alphaId = await propose(service, alpha.sessionId, {
      content: 'il deploy usa docker',
      scope: { type: 'project', id: 'alpha' },
    });
    await propose(service, beta.sessionId, {
      content: 'il deploy non usa docker',
      scope: { type: 'project', id: 'beta' },
    });

    const visible = await service.getMemoryDetail({
      memoryId: alphaId,
      context: { actor: 'harness', sessionId: alpha.sessionId },
    });
    const owner = await service.getMemoryDetail({
      memoryId: alphaId,
      context: { actor: 'owner' },
    });

    expect(visible.conflicts).toHaveLength(0);
    expect(owner.conflicts).toHaveLength(1);
  });
});

describe('the owner explores the whole corpus', () => {
  it('sees every lifecycle of every project', async () => {
    const repository = new InMemoryRepository();
    const service = createService(repository);
    const session = await service.openSession({ projectId: 'alpha' });
    await propose(service, session.sessionId, {
      content: 'memoria accettata',
      scope: { type: 'project', id: 'alpha' },
    });
    await propose(
      service,
      session.sessionId,
      { content: 'memoria in attesa', scope: { type: 'project', id: 'alpha' } },
      'harness',
    );

    const listed = await service.listProjectMemories({
      projectId: 'alpha',
      context: { actor: 'owner' },
    });

    expect(listed.total).toBe(2);
    const pending = await service.listProjectMemories({
      projectId: 'alpha',
      context: { actor: 'owner' },
      lifecycle: 'pending_approval',
    });
    expect(pending.total).toBe(1);
    expect(pending.items[0]?.content).toBe('memoria in attesa');
  });

  it('reads the revision history of a memory', async () => {
    const repository = new InMemoryRepository();
    const service = createService(repository);
    const session = await service.openSession({ projectId: 'alpha' });
    const memoryId = await propose(service, session.sessionId, {
      content: 'prima versione',
      scope: { type: 'project', id: 'alpha' },
    });
    await service.correctMemory({ memoryId, expectedVersion: 1, content: 'seconda versione' });

    const detail = await service.getMemoryDetail({
      memoryId,
      context: { actor: 'owner' },
    });

    expect(detail.revisions).toHaveLength(2);
    expect(detail.memory.content).toBe('seconda versione');
  });
});

describe('the project outline', () => {
  it('describes the project, its areas, its breakdown and its recent memories', async () => {
    const repository = new InMemoryRepository();
    const service = createService(repository);
    await repository.createProject({ id: 'alpha', name: 'Alpha' });
    await repository.createArea({ id: 'area-1', projectId: 'alpha', name: 'design' });
    const session = await service.openSession({ projectId: 'alpha', areaIds: ['area-1'] });
    await propose(service, session.sessionId, {
      content: 'decisione presa',
      scope: { type: 'project', id: 'alpha' },
      kind: 'decision',
    });
    await propose(service, session.sessionId, {
      content: 'vincolo del progetto',
      scope: { type: 'area', id: 'area-1' },
      kind: 'constraint',
    });

    const outline = await service.getProjectOutline({
      projectId: 'alpha',
      context: { actor: 'owner' },
    });

    expect(outline.project.id).toBe('alpha');
    expect(outline.project.memoryCount).toBe(2);
    expect(outline.areas.map((area) => area.id)).toEqual(['area-1']);
    expect(outline.counts.byKind.decision).toBe(1);
    expect(outline.counts.byKind.constraint).toBe(1);
    expect(outline.counts.byKind.fact).toBe(0);
    expect(outline.counts.byLifecycle.accepted).toBe(2);
    expect(outline.counts.byScope.project).toBe(1);
    expect(outline.counts.byScope.area).toBe(1);
    expect(outline.recentMemories).toHaveLength(2);
    expect(outline.recentMemories[0]?.projectId).toBe('alpha');
  });

  it('shows a harness only the memories its session can reach', async () => {
    const repository = new InMemoryRepository();
    const service = createService(repository);
    const other = await service.openSession({ projectId: 'beta' });
    await propose(service, other.sessionId, {
      content: 'memoria di un altro progetto',
      scope: { type: 'project', id: 'beta' },
    });
    const session = await service.openSession({ projectId: 'alpha' });
    await propose(service, session.sessionId, {
      content: 'memoria del mio progetto',
      scope: { type: 'project', id: 'alpha' },
    });

    const outline = await service.getProjectOutline({
      projectId: 'alpha',
      context: { actor: 'harness', sessionId: session.sessionId },
    });

    expect(outline.recentMemories).toHaveLength(1);
    expect(outline.recentMemories[0]?.content).toBe('memoria del mio progetto');
    // The counts describe the project, not the reader: the same numbers the
    // owner reads, so the two views never disagree about the size of a project.
    expect(outline.counts.byLifecycle.accepted).toBe(1);
  });

  it('fails on a project that does not exist', async () => {
    const repository = new InMemoryRepository();
    const service = createService(repository);

    await expect(
      service.getProjectOutline({ projectId: 'inesistente', context: { actor: 'owner' } }),
    ).rejects.toThrow('project_not_found');
  });
});

describe('the project directory is cached without going stale', () => {
  const createCachedService = (repository: InMemoryRepository) =>
    new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
      corpusCache: new InMemoryCorpusCache(),
    });

  it('serves the corpus counts from the cache until the corpus changes', async () => {
    const repository = new InMemoryRepository();
    const service = createCachedService(repository);
    const aggregates = vi.spyOn(repository, 'listProjectCorpusAggregates');

    await service.listProjectSummaries();
    expect(aggregates).toHaveBeenCalledTimes(1);

    await service.listProjectSummaries();
    expect(aggregates).toHaveBeenCalledTimes(1);

    const session = await service.openSession({ projectId: 'alpha' });
    await propose(service, session.sessionId, {
      content: 'memoria accettata',
      scope: { type: 'project', id: 'alpha' },
    });
    await service.listProjectSummaries();
    expect(aggregates).toHaveBeenCalledTimes(2);
  });

  it('shows a project created after the cache was warmed', async () => {
    // The trap: creating a project does not bump the corpus revision, so a
    // directory cached under the revision alone would hide the project that
    // was just created, and the agent that opened a session on it would not
    // find it in the list.
    const repository = new InMemoryRepository();
    const service = createCachedService(repository);
    await service.listProjectSummaries();

    await service.openSession({ projectId: 'appena-creato' });

    const summaries = await service.listProjectSummaries();
    expect(summaries.map((summary) => summary.id)).toContain('appena-creato');
  });

  it('counts the sessions of a project that the revision does not cover', async () => {
    const repository = new InMemoryRepository();
    const service = createCachedService(repository);
    await service.listProjectSummaries();

    await service.openSession({ projectId: 'alpha' });

    const summaries = await service.listProjectSummaries();
    expect(summaries.find((summary) => summary.id === 'alpha')?.sessionCount).toBe(1);
  });
});
