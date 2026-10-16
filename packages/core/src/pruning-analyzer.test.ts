import { describe, expect, it, vi } from 'vitest';
import { RemotePruningAnalyzer } from './pruning-analyzer.js';
import type { AnalyzerBatch } from '@mnemosyne/contracts';

const batch: AnalyzerBatch = {
  privacy: 'public',
  items: [
    {
      memoryId: 'mem_1',
      kind: 'fact',
      scopeKind: 'project',
      ageBucket: '<30d',
      incidentArcTypes: [],
      content: 'il progetto usa pnpm',
    },
  ],
};

function fetchOk(body: unknown) {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(body) } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

describe('RemotePruningAnalyzer', () => {
  it('parses candidates and hashes the exact prompt', async () => {
    const fetchImpl = fetchOk({
      candidates: [
        {
          proposalType: 'redundancy',
          sourceIds: ['mem_1'],
          rationale: 'duplicato evidente',
          confidence: 0.8,
        },
      ],
    });
    const analyzer = new RemotePruningAnalyzer({
      apiKey: 'test-key-long-enough',
      model: 'gemma-4-26b',
      baseUrl: 'https://example.invalid/v1beta/openai',
      fetchImpl,
    });

    const result = await analyzer.analyze(batch);

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ proposalType: 'redundancy' });
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
    const sent = JSON.parse((fetchImpl.mock.calls[0]?.[1] as { body: string }).body) as {
      model: string;
      temperature: number;
    };
    expect(sent.model).toBe('gemma-4-26b');
    expect(sent.temperature).toBe(0);
    expect(analyzer.modelVersion).toBe('gemma-4-26b');
  });

  it('rejects unparsable model output without writing anything', async () => {
    const fetchImpl = fetchOk({ candidates: [{ proposalType: 'nope' }] });
    const analyzer = new RemotePruningAnalyzer({
      apiKey: 'test-key-long-enough',
      model: 'gemma-4-26b',
      fetchImpl,
    });
    await expect(analyzer.analyze(batch)).rejects.toThrow('analyzer_provider_invalid_response');
  });

  it('maps HTTP failures to provider errors', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('nope', { status: 429 }));
    const analyzer = new RemotePruningAnalyzer({
      apiKey: 'test-key-long-enough',
      model: 'gemma-4-26b',
      fetchImpl,
    });
    await expect(analyzer.analyze(batch)).rejects.toThrow('analyzer_provider_http_429');
  });

  it('refuses a missing key at construction, not at first call', () => {
    expect(() => new RemotePruningAnalyzer({ apiKey: '', model: 'gemma-4-26b' })).toThrow(
      'analyzer_api_key_invalid',
    );
  });
});
