import { describe, expect, it } from 'vitest';
import { CoreMemoryService, InMemoryRepository } from './index.js';

const forgetSecret = 'a-secure-test-secret-that-is-long-enough';

async function acceptedMemory(service: CoreMemoryService, sessionId: string, content: string) {
  const result = await service.proposeMemory(
    {
      sessionId,
      content,
      kind: 'fact',
      scope: { type: 'project', id: 'mnemosyne' },
      epistemicBasis: 'verified',
      assessment: 'uncontested',
      confidence: 1,
      sensitivity: 'normal',
      activation: 'on_demand',
      sourceEventIds: [],
    },
    { actor: 'owner', explicitDirective: true },
  );
  if (result.status !== 'accepted' || !result.memoryId) {
    throw new Error(`proposal_not_accepted:${result.status}`);
  }
  return result.memoryId;
}

async function fixture() {
  const repository = new InMemoryRepository();
  const service = new CoreMemoryService(repository, { forgetSecret });
  const session = await service.openSession({ projectId: 'mnemosyne' });
  const first = await acceptedMemory(service, session.sessionId, 'il progetto usa pnpm');
  const second = await acceptedMemory(service, session.sessionId, 'il progetto non usa npm');
  return { repository, service, sessionId: session.sessionId, first, second };
}

describe('proposing arcs', () => {
  it('lands a client arc pending and only the owner can accept it', async () => {
    const { service, first, second } = await fixture();

    const proposed = await service.proposeMemoryArc({
      fromMemoryId: first,
      toMemoryId: second,
      type: 'contraddice',
      weight: 0.8,
    });

    expect(proposed.status).toBe('pending_approval');
    expect(proposed.lifecycle).toBe('pending_approval');
    if (!('arcId' in proposed)) throw new Error('expected_a_memory_arc');
    const accepted = await service.reviewMemoryArc(proposed.arcId, 'accept');
    expect(accepted.lifecycle).toBe('accepted');
    expect(accepted.weight).toBe(0.8);
  });

  it('lands an owner arc accepted without a second step', async () => {
    const { service, first, second } = await fixture();

    const proposed = await service.proposeMemoryArc(
      { fromMemoryId: first, toMemoryId: second, type: 'influenza', weight: 0.5 },
      { actor: 'owner', explicitDirective: false },
    );

    expect(proposed.status).toBe('accepted');
    expect(proposed.lifecycle).toBe('accepted');
  });

  it('refuses an arc whose weight is outside 0..1', async () => {
    const { service, first, second } = await fixture();

    await expect(
      service.proposeMemoryArc({ fromMemoryId: first, toMemoryId: second, type: 'x', weight: 3 }),
    ).rejects.toThrow('Arc weight must be between 0 and 1');
  });

  it('refuses an arc to a memory that does not exist', async () => {
    const { service, first } = await fixture();

    await expect(
      service.proposeMemoryArc({ fromMemoryId: first, toMemoryId: 'mem_fantasma', type: 'x' }),
    ).rejects.toThrow('Memory not found');
  });

  it('allows a cycle, because two memories can influence each other', async () => {
    const { service, first, second } = await fixture();

    await service.proposeMemoryArc({ fromMemoryId: first, toMemoryId: second, type: 'influenza' });
    const back = await service.proposeMemoryArc({
      fromMemoryId: second,
      toMemoryId: first,
      type: 'influenza',
    });

    // Distinct types, so the triple uniqueness does not reject the reverse arc.
    expect(back.status).toBe('pending_approval');
  });

  it('refuses the same arc twice, so retrying a proposal is idempotent', async () => {
    const { service, first, second } = await fixture();
    await service.proposeMemoryArc({ fromMemoryId: first, toMemoryId: second, type: 'influenza' });

    await expect(
      service.proposeMemoryArc({ fromMemoryId: first, toMemoryId: second, type: 'influenza' }),
    ).rejects.toThrow('arc_duplicate');
  });

  it('refuses a second review of an arc already decided', async () => {
    const { service, first, second } = await fixture();
    const proposed = await service.proposeMemoryArc({
      fromMemoryId: first,
      toMemoryId: second,
      type: 'influenza',
    });
    if (!('arcId' in proposed)) throw new Error('expected_a_memory_arc');
    await service.reviewMemoryArc(proposed.arcId, 'accept');

    await expect(service.reviewMemoryArc(proposed.arcId, 'reject')).rejects.toThrow(
      'arc_not_pending',
    );
  });

  it('lists arcs from both ends of a memory', async () => {
    const { service, first, second } = await fixture();
    await service.proposeMemoryArc({ fromMemoryId: first, toMemoryId: second, type: 'influenza' });

    expect(await service.listMemoryArcs(first)).toMatchObject({
      from: [{ toMemoryId: second }],
      to: [],
    });
    expect(await service.listMemoryArcs(second)).toMatchObject({
      from: [],
      to: [{ fromMemoryId: first }],
    });
  });
});

describe('listing every arc at once', () => {
  it('returns both tables in one call for the owner dashboard', async () => {
    const { repository, service, first, second } = await fixture();
    await service.proposeMemoryArc(
      { fromMemoryId: first, toMemoryId: second, type: 'influenza', weight: 0.6 },
      { actor: 'owner', explicitDirective: false },
    );
    await repository.createProject({ id: 'altro', name: 'Altro' });
    await service.proposeProjectArc(
      { fromProjectId: 'mnemosyne', toProjectId: 'altro', type: 'dipende' },
      { actor: 'owner', explicitDirective: false },
    );

    const all = await service.listAllArcs();

    expect(all.memoryArcs).toHaveLength(1);
    expect(all.memoryArcs[0]).toMatchObject({ fromMemoryId: first, toMemoryId: second });
    expect(all.projectArcs).toHaveLength(1);
    expect(all.projectArcs[0]).toMatchObject({
      fromProjectId: 'mnemosyne',
      toProjectId: 'altro',
    });
  });
});

describe('project arcs', () => {
  it('proposes between two declared projects and refuses a self reference', async () => {
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, { forgetSecret });
    await repository.createProject({ id: 'mnemosyne', name: 'Mnemosyne' });
    await repository.createProject({ id: 'altro', name: 'Altro' });

    const arc = await service.proposeProjectArc(
      { fromProjectId: 'mnemosyne', toProjectId: 'altro', type: 'dipende' },
      { actor: 'owner', explicitDirective: false },
    );
    expect(arc.status).toBe('accepted');

    await expect(
      service.proposeProjectArc({
        fromProjectId: 'mnemosyne',
        toProjectId: 'mnemosyne',
        type: 'x',
      }),
    ).rejects.toThrow('cannot link an element to itself');
    await expect(
      service.proposeProjectArc({ fromProjectId: 'mnemosyne', toProjectId: 'fantasma', type: 'x' }),
    ).rejects.toThrow('Project not found');
  });

  it('lists arcs touching a project from either side', async () => {
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, { forgetSecret });
    await repository.createProject({ id: 'a', name: 'A' });
    await repository.createProject({ id: 'b', name: 'B' });
    await repository.createProject({ id: 'c', name: 'C' });
    await service.proposeProjectArc(
      { fromProjectId: 'a', toProjectId: 'b', type: 'dipende' },
      { actor: 'owner', explicitDirective: false },
    );
    await service.proposeProjectArc(
      { fromProjectId: 'c', toProjectId: 'a', type: 'dipende' },
      { actor: 'owner', explicitDirective: false },
    );

    const touching = await service.listProjectArcs('a');
    expect(touching).toHaveLength(2);
  });
});
