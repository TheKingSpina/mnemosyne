import { describe, expect, it } from 'vitest';
import { PostgresMemoryRepository } from './index.js';

interface Call {
  text: string;
  values?: unknown[];
}

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    name: 'Alpha',
    description: null,
    created_at: new Date('2026-10-15T00:00:00.000Z'),
    updated_at: new Date('2026-10-15T00:00:00.000Z'),
    ...overrides,
  };
}

// A fake database that answers by statement kind, so a path with an INSERT
// followed by a fallback SELECT can be observed separately from a single insert
// that returns its row.
function fakeDatabase(options: { insertRows?: unknown[]; selectRows?: unknown[] } = {}) {
  const calls: Call[] = [];
  const database = {
    query: async (text: string, values?: unknown[]) => {
      calls.push({ text, values });
      const rows = text.includes('INSERT')
        ? (options.insertRows ?? [])
        : (options.selectRows ?? []);
      return { rows };
    },
  };
  return { database, calls };
}

describe('PostgresMemoryRepository projects and areas', () => {
  it('provisions a project without reading first, so concurrent opens cannot race', async () => {
    const { database, calls } = fakeDatabase({ insertRows: [projectRow()] });
    const repository = new PostgresMemoryRepository(database as never);

    await repository.ensureProject('p1');

    expect(calls).toHaveLength(1);
    expect(calls[0].text).toContain('INSERT INTO projects');
    // A read-then-write would let two sessions opening on the same new project
    // both pass the check and one fail on the unique name.
    expect(calls[0].text).toContain('ON CONFLICT (id) DO NOTHING');
  });

  it('falls back to a read when the insert was a no-op', async () => {
    const { database, calls } = fakeDatabase({ selectRows: [projectRow()] });
    const repository = new PostgresMemoryRepository(database as never);

    const project = await repository.ensureProject('p1');

    expect(calls).toHaveLength(2);
    expect(calls[1].text).toContain('SELECT * FROM projects WHERE id = $1');
    expect(project.name).toBe('Alpha');
  });

  it('maps a project row, omitting an absent description rather than emitting null', async () => {
    const { database } = fakeDatabase({ insertRows: [projectRow()] });
    const repository = new PostgresMemoryRepository(database as never);

    const project = await repository.createProject({ id: 'p1', name: 'Alpha' });

    expect(project.description).toBeUndefined();
    expect(project.createdAt).toBe('2026-10-15T00:00:00.000Z');
  });

  it('looks a project up by name case-insensitively', async () => {
    const { database, calls } = fakeDatabase();
    const repository = new PostgresMemoryRepository(database as never);

    await repository.findProjectByName('ALPHA');

    expect(calls[0].text).toContain('lower(name) = lower($1)');
  });

  it('scopes area listing to one project', async () => {
    const { database, calls } = fakeDatabase();
    const repository = new PostgresMemoryRepository(database as never);

    await repository.listAreas('p1');

    expect(calls[0].text).toContain('WHERE project_id = $1');
    expect(calls[0].values).toEqual(['p1']);
  });
});
