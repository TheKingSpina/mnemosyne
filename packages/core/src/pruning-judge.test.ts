import { describe, expect, it, vi } from 'vitest';
import {
  fusePruningScores,
  judgeVerdictJsonSchema,
  LlamaCppPruningJudge,
  type PruningJudgeVerdictInput,
} from './pruning-judge.js';

const sampleVerdictInput: PruningJudgeVerdictInput = {
  proposalType: 'redundancy',
  items: [
    {
      memoryId: 'mem_1',
      kind: 'preference',
      content: 'Preferisco risposte concise e dirette.',
    },
    {
      memoryId: 'mem_2',
      kind: 'preference',
      content: 'Usa sempre risposte brevi e dirette.',
    },
  ],
  rationale: 'Entrambe esprimono la stessa preferenza di brevità',
};

function fetchRerankOk(results: Array<{ index: number; relevance_score: number }>) {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function fetchVerdictOk(body: unknown) {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(body) } }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

describe('LlamaCppPruningJudge', () => {
  it('validates constructor options eagerly', () => {
    expect(
      () => new LlamaCppPruningJudge({ rerankModel: '', instructModel: 'gemma-3-4b' }),
    ).toThrow('judge_rerank_model_invalid');
    expect(
      () => new LlamaCppPruningJudge({ rerankModel: 'qwen3-reranker-0.6b', instructModel: '  ' }),
    ).toThrow('judge_instruct_model_invalid');
    expect(
      () =>
        new LlamaCppPruningJudge({
          rerankModel: 'qwen3-reranker-0.6b',
          instructModel: 'gemma-3-4b',
          requestTimeoutMs: 500,
        }),
    ).toThrow('judge_timeout_invalid');
  });

  it('calls /v1/rerank and reorders scores by document index', async () => {
    const fetchImpl = fetchRerankOk([
      { index: 1, relevance_score: 0.92 },
      { index: 0, relevance_score: 0.31 },
    ]);
    const judge = new LlamaCppPruningJudge({
      rerankModel: 'qwen3-reranker-0.6b',
      instructModel: 'gemma-3-4b',
      baseUrl: 'http://host.docker.internal:8081/v1/',
      fetchImpl,
    });

    const scores = await judge.rerank('risposte concise', ['doc zero', 'doc uno']);

    expect(scores).toEqual([0.31, 0.92]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const url = fetchImpl.mock.calls[0]?.[0];
    const init = fetchImpl.mock.calls[0]?.[1];
    expect(url).toBe('http://host.docker.internal:8081/v1/rerank');
    const sent = JSON.parse((init as { body: string }).body) as {
      model: string;
      query: string;
      documents: string[];
    };
    expect(sent).toEqual({
      model: 'qwen3-reranker-0.6b',
      query: 'risposte concise',
      documents: ['doc zero', 'doc uno'],
    });
  });

  it('rejects malformed or out-of-bounds rerank indices', async () => {
    const fetchImpl = fetchRerankOk([
      { index: 0, relevance_score: 0.8 },
      { index: 5, relevance_score: 0.9 },
    ]);
    const judge = new LlamaCppPruningJudge({
      rerankModel: 'qwen3-reranker-0.6b',
      instructModel: 'gemma-3-4b',
      fetchImpl,
    });

    await expect(judge.rerank('query', ['a', 'b'])).rejects.toThrow(
      'judge_provider_invalid_response',
    );
  });

  it('calls /v1/chat/completions with forced json_schema and validates citedIds', async () => {
    const fetchImpl = fetchVerdictOk({
      verdict: 'accept',
      citedIds: ['mem_1', 'mem_2'],
      confidence: 0.88,
      reason: 'Stessa preferenza formulata due volte',
    });
    const judge = new LlamaCppPruningJudge({
      rerankModel: 'qwen3-reranker-0.6b',
      instructModel: 'gemma-3-4b',
      apiKey: 'local-token',
      fetchImpl,
    });

    const result = await judge.verdict(sampleVerdictInput);

    expect(result.verdict).toEqual({
      verdict: 'accept',
      citedIds: ['mem_1', 'mem_2'],
      confidence: 0.88,
      reason: 'Stessa preferenza formulata due volte',
    });
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
    const init = fetchImpl.mock.calls[0]?.[1];
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.authorization).toBe('Bearer local-token');
    const sent = JSON.parse((init as { body: string }).body) as {
      model: string;
      temperature: number;
      response_format: { type: string; json_schema: { strict: boolean; schema: unknown } };
    };
    expect(sent.model).toBe('gemma-3-4b');
    expect(sent.temperature).toBe(0);
    expect(sent.response_format.type).toBe('json_schema');
    expect(sent.response_format.json_schema.strict).toBe(true);
    expect(sent.response_format.json_schema.schema).toEqual(judgeVerdictJsonSchema);
  });

  it('refuses verdicts that cite hallucinated memory ids', async () => {
    const fetchImpl = fetchVerdictOk({
      verdict: 'accept',
      citedIds: ['mem_1', 'mem_invented'],
      confidence: 0.95,
      reason: 'allucinazione id',
    });
    const judge = new LlamaCppPruningJudge({
      rerankModel: 'qwen3-reranker-0.6b',
      instructModel: 'gemma-3-4b',
      fetchImpl,
    });

    await expect(judge.verdict(sampleVerdictInput)).rejects.toThrow(
      'judge_provider_hallucinated_id',
    );
  });

  it('maps HTTP failures on both endpoints to judge provider errors', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('busy', { status: 503 }));
    const judge = new LlamaCppPruningJudge({
      rerankModel: 'qwen3-reranker-0.6b',
      instructModel: 'gemma-3-4b',
      fetchImpl,
    });

    await expect(judge.rerank('q', ['d'])).rejects.toThrow('judge_provider_http_503');
  });
});

describe('fusePruningScores', () => {
  it('returns consensus when deterministic and calibrated judge agree', () => {
    const acceptBoth = fusePruningScores({
      deterministicScore: 0.15,
      calibratedScore: 0.9,
      calibratedVerdict: 'accept',
    });
    expect(acceptBoth.decision).toBe('accept');
    expect(acceptBoth.winner).toBe('consensus');

    const rejectBoth = fusePruningScores({
      deterministicScore: 0.7,
      calibratedScore: 0.9,
      calibratedVerdict: 'reject',
    });
    expect(rejectBoth.decision).toBe('reject');
    expect(rejectBoth.winner).toBe('consensus');
  });

  it('awards exact parity to the deterministic score', () => {
    // deterministicScore = 0.6 -> deterministicPressure = 0.4 (keep, >= 0.25)
    // calibratedScore = 0.8 (accept) -> fusedScore = 0.5 * 0.4 + 0.5 * 0.8 = 0.60 === threshold
    const tieKeep = fusePruningScores({
      deterministicScore: 0.6,
      calibratedScore: 0.8,
      calibratedVerdict: 'accept',
    });
    expect(tieKeep.fusedScore).toBeCloseTo(0.6, 6);
    expect(tieKeep.decision).toBe('reject');
    expect(tieKeep.winner).toBe('deterministic');
  });

  it('ignores calibrated accept below the verdict confidence floor', () => {
    const lowConfidence = fusePruningScores({
      deterministicScore: 0.3,
      calibratedScore: 0.6,
      calibratedVerdict: 'accept',
    });
    expect(lowConfidence.decision).toBe('reject');
    expect(lowConfidence.winner).toBe('consensus');
  });
});
