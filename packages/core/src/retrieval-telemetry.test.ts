import { describe, expect, it } from 'vitest';
import { retrievalTelemetryOutputSchema } from '@mnemosyne/contracts';
import {
  CoreMemoryService,
  DeterministicEmbeddingProvider,
  InMemoryCorpusCache,
  InMemoryRepository,
  InMemorySemanticSearchIndex,
  RetrievalTelemetryCollector,
} from './index.js';

const forgetSecret = 'a-secure-test-secret-that-is-long-enough';
const projectScope = { type: 'project' as const, id: 'telemetry' };

function createService(
  options: { semantic?: boolean; cache?: boolean; telemetry?: RetrievalTelemetryCollector } = {},
) {
  const repository = new InMemoryRepository();
  const serviceOptions: ConstructorParameters<typeof CoreMemoryService>[1] = { forgetSecret };
  if (options.cache) serviceOptions.corpusCache = new InMemoryCorpusCache();
  if (options.semantic) {
    const provider = new DeterministicEmbeddingProvider(32);
    serviceOptions.embeddingProvider = provider;
    serviceOptions.semanticSearchIndex = new InMemorySemanticSearchIndex({
      profile: provider.profile,
      dimensions: provider.dimensions,
    });
  }
  if (options.telemetry) serviceOptions.telemetry = options.telemetry;
  return { repository, service: new CoreMemoryService(repository, serviceOptions) };
}

async function seedAndOpen(service: CoreMemoryService) {
  const session = await service.openSession({ projectId: 'telemetry' });
  for (const content of [
    'il progetto usa pnpm come package manager',
    'il retrieval usa BM25 e fusione semantica',
    'la retention elimina i candidati non approvati',
  ]) {
    await service.proposeMemory(
      {
        sessionId: session.sessionId,
        content,
        kind: 'convention',
        scope: projectScope,
        epistemicBasis: 'user_asserted',
        assessment: 'uncontested',
        confidence: 1,
        sensitivity: 'normal',
        activation: 'on_demand',
        sourceEventIds: [],
      },
      { actor: 'owner', explicitDirective: true },
    );
  }
  return session.sessionId;
}

describe('retrieval telemetry', () => {
  it('counts searches by the path that served them', async () => {
    const { service } = createService({ semantic: true });
    const sessionId = await seedAndOpen(service);

    await service.searchMemories({
      sessionId,
      query: 'pnpm package manager',
      limit: 20,
      offset: 0,
    });

    const telemetry = service.getRetrievalTelemetry();
    expect(telemetry.searches).toBe(1);
    expect(telemetry.reporter).toBe('unspecified');
    expect(Object.values(telemetry.paths).reduce((a, b) => a + b, 0)).toBe(1);
    expect(telemetry.paths.empty).toBe(0);
  });

  it('counts a cache hit separately from a scored search', async () => {
    const { service } = createService({ cache: true });
    const sessionId = await seedAndOpen(service);

    await service.searchMemories({ sessionId, query: 'retention candidati', limit: 20, offset: 0 });
    await service.searchMemories({ sessionId, query: 'retention candidati', limit: 20, offset: 0 });

    const telemetry = service.getRetrievalTelemetry();
    expect(telemetry.searches).toBe(2);
    expect(telemetry.cacheHits).toBe(1);
    expect(telemetry.cacheMisses).toBe(1);
  });

  it('counts an empty result set rather than dropping it', async () => {
    const { service } = createService();
    const sessionId = await seedAndOpen(service);

    await service.searchMemories({ sessionId, query: 'qwertyuiopasdfgh', limit: 20, offset: 0 });

    expect(service.getRetrievalTelemetry().paths.empty).toBe(1);
  });

  it('counts context resolutions separately from searches', async () => {
    const { service } = createService();
    const sessionId = await seedAndOpen(service);

    await service.resolveContext({ sessionId, query: 'retention', budgetTokens: 1200 });

    const telemetry = service.getRetrievalTelemetry();
    expect(telemetry.contextResolutions).toBe(1);
    expect(telemetry.searches).toBe(0);
  });

  it('counts a semantic index that throws instead of losing the signal', async () => {
    const provider = new DeterministicEmbeddingProvider(32);
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, {
      forgetSecret,
      embeddingProvider: provider,
      semanticSearchIndex: {
        profile: provider.profile,
        dimensions: provider.dimensions,
        upsert: async () => undefined,
        remove: async () => undefined,
        countByProfile: async () => [],
        search: async () => {
          throw new Error('semantic_index_unavailable');
        },
      },
    });
    const sessionId = await seedAndOpen(service);

    await service.searchMemories({ sessionId, query: 'pnpm', limit: 20, offset: 0 });

    expect(service.getRetrievalTelemetry().semanticUnavailable).toBe(1);
  });

  it('never carries a query, a memory id or corpus content', async () => {
    // This is the guard for the whole feature. If a future change starts
    // recording something identifying, the schema below must reject it.
    const { service } = createService();
    const sessionId = await seedAndOpen(service);
    await service.searchMemories({ sessionId, query: 'pnpm', limit: 20, offset: 0 });

    const snapshot = service.getRetrievalTelemetry();
    const serialized = JSON.stringify(snapshot);
    expect(serialized).not.toContain('pnpm');
    expect(serialized).not.toContain('mem_');
    expect(serialized).not.toContain('telemetry');

    const leafValues: unknown[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === 'string' || typeof value === 'number') leafValues.push(value);
      else if (value && typeof value === 'object') {
        for (const inner of Object.values(value)) walk(inner);
      }
    };
    walk(snapshot);
    for (const value of leafValues) {
      if (typeof value === 'string') {
        expect(value.length).toBeLessThan(120);
      } else {
        expect(typeof value === 'number' || value === null).toBe(true);
      }
    }
    expect(() => retrievalTelemetryOutputSchema.parse(snapshot)).not.toThrow();
  });

  it('starts every bucket at zero and is resettable', () => {
    const collector = new RetrievalTelemetryCollector();
    const fresh = collector.snapshot('api');
    expect(Object.values(fresh.candidates).every((count) => count === 0)).toBe(true);
    expect(Object.values(fresh.results).every((count) => count === 0)).toBe(true);
    expect(Object.values(fresh.topScoreBands).every((count) => count === 0)).toBe(true);

    collector.recordSearch({
      candidateCount: 30,
      resultCount: 3,
      topScore: 0.8,
      lexical: true,
      semantic: true,
      cached: false,
    });
    expect(collector.snapshot('api').searches).toBe(1);
    collector.reset();
    expect(collector.snapshot('api').searches).toBe(0);
  });

  it('is per process, so the reporter disambiguates who counted', async () => {
    const telemetry = new RetrievalTelemetryCollector();
    const api = new CoreMemoryService(new InMemoryRepository(), {
      forgetSecret,
      reporter: 'api',
      telemetry,
    });
    const mcp = new CoreMemoryService(new InMemoryRepository(), {
      forgetSecret,
      reporter: 'mcp',
      telemetry,
    });

    expect(api.getRetrievalTelemetry().reporter).toBe('api');
    expect(mcp.getRetrievalTelemetry().reporter).toBe('mcp');
  });
});
