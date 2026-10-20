import { describe, expect, it } from 'vitest';
import type { Scope } from '@mnemosyne/contracts';
import { CoreMemoryService, InMemoryRepository } from './index.js';
import { RESERVED_PERSONAL_PROJECT_ID, type CreateMemoryInput } from './types.js';

// The in-memory repository has to enforce what PostgreSQL enforces, or the
// deterministic test suite would pass on rules the real database rejects.
// The cases below mirror the constraints in packages/postgres/src/schema.sql:
// uq_projects_name, uq_projects_name_ci, uq_areas_project_name, and the
// foreign key from areas to projects.

describe('projects and areas', () => {
  it('creates a project and finds it by id and by name', async () => {
    const repository = new InMemoryRepository();

    const created = await repository.createProject({ id: 'mnemosyne', name: 'Mnemosyne' });
    expect(created.name).toBe('Mnemosyne');
    expect(created.description).toBeUndefined();

    expect((await repository.findProjectById('mnemosyne'))?.name).toBe('Mnemosyne');
    expect((await repository.findProjectByName('mnemosyne'))?.id).toBe('mnemosyne');
    expect(await repository.findProjectById('assente')).toBeNull();
  });

  it('rejects a duplicate project name regardless of case', async () => {
    const repository = new InMemoryRepository();
    await repository.createProject({ id: 'p1', name: 'Alpha' });

    await expect(repository.createProject({ id: 'p2', name: 'Alpha' })).rejects.toThrow(
      'project_name_taken',
    );
    // A different case must not slip past and create a second project that a
    // lookup by name cannot tell apart.
    await expect(repository.createProject({ id: 'p3', name: 'alpha' })).rejects.toThrow(
      'project_name_taken',
    );
    expect(await repository.listProjects()).toHaveLength(1);
  });

  it('provisions a project on first use and is idempotent afterwards', async () => {
    const repository = new InMemoryRepository();

    const first = await repository.ensureProject('nuovo-progetto');
    expect(first.name).toBe('nuovo-progetto');
    const second = await repository.ensureProject('nuovo-progetto');

    expect(second.id).toBe(first.id);
    expect(await repository.listProjects()).toHaveLength(1);
  });

  it('creates areas inside a project and refuses one outside it', async () => {
    const repository = new InMemoryRepository();
    await repository.createProject({ id: 'p1', name: 'Alpha' });

    const area = await repository.createArea({
      id: 'a1',
      projectId: 'p1',
      name: 'progettazione',
    });
    expect(area.projectId).toBe('p1');
    expect(await repository.listAreas('p1')).toHaveLength(1);

    await expect(
      repository.createArea({ id: 'a2', projectId: 'inesistente', name: 'progettazione' }),
    ).rejects.toThrow('project_not_found');
  });

  it('allows the same area name in different projects but not twice in one', async () => {
    const repository = new InMemoryRepository();
    await repository.createProject({ id: 'p1', name: 'Alpha' });
    await repository.createProject({ id: 'p2', name: 'Beta' });

    await repository.createArea({ id: 'a1', projectId: 'p1', name: 'sviluppo' });
    await repository.createArea({ id: 'a2', projectId: 'p2', name: 'sviluppo' });

    await expect(
      repository.createArea({ id: 'a3', projectId: 'p1', name: 'sviluppo' }),
    ).rejects.toThrow('area_name_taken');
  });

  it('names the reserved personal project with a stable id', () => {
    expect(RESERVED_PERSONAL_PROJECT_ID).toBe('personal');
  });

  it('refuses a memory without a project, because PostgreSQL refuses it too', async () => {
    // memories.project_id is NOT NULL in the real database. The in-memory
    // backend has to refuse the same write, or the deterministic suite would
    // pass on a shape the database rejects and a bulk script would fail only
    // once it reached PostgreSQL.
    const repository = new InMemoryRepository();

    await expect(
      repository.createMemory({
        sessionId: 'ses_senza_progetto',
        content: 'memoria senza progetto',
        kind: 'fact',
        scope: { type: 'project', id: 'p1' },
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      } as unknown as CreateMemoryInput),
    ).rejects.toThrow('memory_requires_project');
  });
});

describe('openSession and declared areas', () => {
  const createService = (repository: InMemoryRepository) =>
    new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
    });

  it('accepts a session scoped to declared areas of its project', async () => {
    const repository = new InMemoryRepository();
    await repository.createProject({ id: 'p1', name: 'Alpha' });
    await repository.createArea({ id: 'a1', projectId: 'p1', name: 'progettazione' });
    await repository.createArea({ id: 'a2', projectId: 'p1', name: 'sviluppo' });

    const opened = await createService(repository).openSession({
      projectId: 'p1',
      areaIds: ['a1', 'a2'],
    });

    expect(opened.areaIds).toEqual(['a1', 'a2']);
  });

  it('refuses an area that was never declared', async () => {
    const repository = new InMemoryRepository();
    await repository.createProject({ id: 'p1', name: 'Alpha' });

    await expect(
      createService(repository).openSession({ projectId: 'p1', areaIds: ['area-fantasma'] }),
    ).rejects.toThrow('Area area-fantasma not found');
  });

  it('refuses an area belonging to another project', async () => {
    const repository = new InMemoryRepository();
    await repository.createProject({ id: 'p1', name: 'Alpha' });
    await repository.createProject({ id: 'p2', name: 'Beta' });
    await repository.createArea({ id: 'a-beta', projectId: 'p2', name: 'progettazione' });

    await expect(
      createService(repository).openSession({ projectId: 'p1', areaIds: ['a-beta'] }),
    ).rejects.toThrow('does not belong to project p1');
  });

  it('leaves areas optional', async () => {
    const repository = new InMemoryRepository();
    await repository.createProject({ id: 'p1', name: 'Alpha' });

    const opened = await createService(repository).openSession({ projectId: 'p1' });

    expect(opened.areaIds).toEqual([]);
  });
});

describe('a memory belongs to a project', () => {
  const createService = (repository: InMemoryRepository) =>
    new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
    });

  // Narrows the proposal union here so each test reads as an assertion about the
  // project rather than about the result shape.
  const propose = async (
    service: CoreMemoryService,
    sessionId: string,
    scope: Scope,
    content: string,
  ): Promise<string> => {
    const result = await service.proposeMemory(
      {
        sessionId,
        content,
        kind: 'fact',
        scope,
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
  };

  it('takes the project of the session it was proposed in', async () => {
    const repository = new InMemoryRepository();
    const service = createService(repository);
    const session = await service.openSession({ projectId: 'mnemosyne' });

    const memoryId = await propose(
      service,
      session.sessionId,
      { type: 'project', id: 'mnemosyne' },
      'memoria di progetto',
    );

    const record = await repository.getMemory(memoryId);
    expect(record?.record.projectId).toBe('mnemosyne');
  });

  it('takes the project of an area-scoped memory, not the area id', async () => {
    const repository = new InMemoryRepository();
    const service = createService(repository);
    await repository.createProject({ id: 'mnemosyne', name: 'Mnemosyne' });
    await repository.createArea({ id: 'area-1', projectId: 'mnemosyne', name: 'progettazione' });
    const session = await service.openSession({ projectId: 'mnemosyne', areaIds: ['area-1'] });

    const memoryId = await propose(
      service,
      session.sessionId,
      { type: 'area', id: 'area-1' },
      'memoria di area',
    );

    const record = await repository.getMemory(memoryId);
    expect(record?.record.projectId).toBe('mnemosyne');
  });

  it('puts a personal-project memory proposed from another project in the reserved personal project', async () => {
    const repository = new InMemoryRepository();
    const service = createService(repository);
    const session = await service.openSession({ projectId: 'mnemosyne' });

    const memoryId = await propose(
      service,
      session.sessionId,
      { type: 'project', id: 'personal' },
      'memoria personale',
    );

    const record = await repository.getMemory(memoryId);
    expect(record?.record.projectId).toBe(RESERVED_PERSONAL_PROJECT_ID);
  });
});

describe('openSession and project existence', () => {
  const createService = (repository: InMemoryRepository) =>
    new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
    });

  it('provisions the project instead of failing on an unknown id', async () => {
    const repository = new InMemoryRepository();

    const opened = await createService(repository).openSession({
      projectId: 'progetto-che-non-esisteva',
    });

    expect(opened.projectId).toBe('progetto-che-non-esisteva');
    expect(await repository.findProjectById('progetto-che-non-esisteva')).not.toBeNull();
  });

  it('reuses an existing project rather than replacing it', async () => {
    const repository = new InMemoryRepository();
    await repository.createProject({ id: 'p1', name: 'Nome Scelto' });

    await createService(repository).openSession({ projectId: 'p1' });

    // ensureProject must not overwrite the declared name with the id.
    expect((await repository.findProjectById('p1'))?.name).toBe('Nome Scelto');
  });
});
