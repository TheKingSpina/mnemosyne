import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('Mnemosyne CLI', () => {
  it('exports a validated corpus file with private permissions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mnemosyne-cli-'));
    const destination = join(directory, 'corpus.json');
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          exportedAt: '2026-01-20T10:00:00Z',
          corpusRevision: 'epoch:1',
          sessions: [],
          events: [],
          memories: [],
          revisions: [],
          conflicts: [],
          jobs: [],
          jobAttempts: [],
          forgetLedger: [],
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('MNEMOSYNE_API_URL', 'http://127.0.0.1:3000');
    vi.stubEnv('MNEMOSYNE_OWNER_TOKEN', 'synthetic-owner-token-12345678901234567890');
    process.argv = ['node', 'mnemosyne', 'export', destination];

    await import('./main.js');
    const saved = JSON.parse(await readFile(destination, 'utf8')) as { schemaVersion: number };
    const request = fetchMock.mock.calls[0];

    expect(saved.schemaVersion).toBe(1);
    expect(request?.[0]).toEqual(new URL('http://127.0.0.1:3000/v1/admin/exports/corpus'));
    expect(new Headers(request?.[1]?.headers).get('authorization')).toBe(
      'Bearer synthetic-owner-token-12345678901234567890',
    );
  });
});
