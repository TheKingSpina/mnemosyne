import { createHash } from 'node:crypto';
import {
  judgeVerdictSchema,
  pruningPolicy,
  rerankResponseSchema,
  type JudgeVerdict,
  type MemoryKind,
} from '@mnemosyne/contracts';

export interface PruningJudgeOptions {
  rerankModel: string;
  instructModel: string;
  baseUrl?: string;
  rerankBaseUrl?: string;
  apiKey?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface PruningJudgeVerdictInput {
  proposalType: 'redundancy' | 'contradiction' | 'merge';
  items: Array<{
    memoryId: string;
    kind: MemoryKind;
    content: string;
  }>;
  rationale?: string;
}

export interface PruningJudge {
  readonly rerankModel: string;
  readonly instructModel: string;
  rerank(query: string, documents: string[]): Promise<number[]>;
  verdict(input: PruningJudgeVerdictInput): Promise<{
    verdict: JudgeVerdict;
    promptHash: string;
  }>;
}

export const judgeSystemPrompt = `You are a calibrated pruning judge for a governed memory service. Evaluate whether the proposed pruning action (redundancy, contradiction, or merge) is strictly justified by the supplied memory items. Return JSON matching the forced schema with verdict ("accept" or "reject"), citedIds (only memoryId values from the input, never invented), confidence between 0 and 1, and a concise reason. When uncertain, reject.`;

// Constrained grammar schema passed to llama-server via response_format so the
// output format is deterministic even though the judgment is model-driven.
export const judgeVerdictJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'citedIds', 'confidence', 'reason'],
  properties: {
    verdict: { type: 'string', enum: ['accept', 'reject'] },
    citedIds: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const;

export class LlamaCppPruningJudge implements PruningJudge {
  readonly rerankModel: string;
  readonly instructModel: string;
  private readonly baseUrl: string;
  private readonly rerankBaseUrl: string;
  private readonly apiKey?: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PruningJudgeOptions) {
    if (options.rerankModel.trim().length === 0) throw new Error('judge_rerank_model_invalid');
    if (options.instructModel.trim().length === 0) throw new Error('judge_instruct_model_invalid');
    this.rerankModel = options.rerankModel.trim();
    this.instructModel = options.instructModel.trim();
    this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8081/v1').replace(/\/+$/u, '');
    this.rerankBaseUrl = (options.rerankBaseUrl ?? this.baseUrl).replace(/\/+$/u, '');
    this.apiKey = options.apiKey;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1_000) {
      throw new Error('judge_timeout_invalid');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const base: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey && this.apiKey.length > 0) {
      base.authorization = `Bearer ${this.apiKey}`;
    }
    return base;
  }

  async rerank(query: string, documents: string[]): Promise<number[]> {
    if (query.trim().length === 0 || documents.length === 0) {
      throw new Error('judge_rerank_input_invalid');
    }
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.rerankBaseUrl}/rerank`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.rerankModel,
          query,
          documents,
        }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new Error('judge_provider_timeout', { cause: error });
      }
      throw new Error('judge_provider_unavailable', { cause: error });
    }
    if (!response.ok) throw new Error(`judge_provider_http_${response.status}`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error('judge_provider_invalid_response', { cause: error });
    }
    const parsed = rerankResponseSchema.safeParse(payload);
    if (!parsed.success || parsed.data.results.length !== documents.length) {
      throw new Error('judge_provider_invalid_response');
    }
    // Cross-encoder models (e.g. BGE reranker) output unbounded logits;
    // normalize the whole batch with standard sigmoid when using a logit-based
    // reranker or when any score in the batch is outside [0, 1].
    const useSigmoid =
      this.rerankModel.toLowerCase().includes('bge') ||
      parsed.data.results.some((item) => item.relevance_score < 0 || item.relevance_score > 1);
    const ordered = new Array<number | undefined>(documents.length);
    for (const item of parsed.data.results) {
      if (item.index < 0 || item.index >= documents.length || ordered[item.index] !== undefined) {
        throw new Error('judge_provider_invalid_response');
      }
      const raw = item.relevance_score;
      const normalized = useSigmoid ? 1 / (1 + Math.exp(-raw)) : raw;
      ordered[item.index] = normalized;
    }
    return ordered.map((score) => score ?? 0);
  }

  async verdict(input: PruningJudgeVerdictInput): Promise<{
    verdict: JudgeVerdict;
    promptHash: string;
  }> {
    if (input.items.length < 2) throw new Error('judge_verdict_input_invalid');
    const allowedIds = new Set(input.items.map((item) => item.memoryId));
    const userContent = JSON.stringify({
      proposalType: input.proposalType,
      items: input.items,
      ...(input.rationale === undefined ? {} : { rationale: input.rationale }),
    });
    const promptHash = createHash('sha256')
      .update(`${judgeSystemPrompt}\n${userContent}`)
      .digest('hex');

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.instructModel,
          temperature: 0,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'judge_verdict',
              strict: true,
              schema: judgeVerdictJsonSchema,
            },
          },
          messages: [
            { role: 'system', content: judgeSystemPrompt },
            { role: 'user', content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new Error('judge_provider_timeout', { cause: error });
      }
      throw new Error('judge_provider_unavailable', { cause: error });
    }
    if (!response.ok) throw new Error(`judge_provider_http_${response.status}`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error('judge_provider_invalid_response', { cause: error });
    }
    const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
      .choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('judge_provider_invalid_response');
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (error) {
      throw new Error('judge_provider_invalid_json', { cause: error });
    }
    const parsed = judgeVerdictSchema.safeParse(raw);
    if (!parsed.success) throw new Error('judge_provider_invalid_response');
    // Never allow invented identifiers in any verdict path.
    if (!parsed.data.citedIds.every((id) => allowedIds.has(id))) {
      throw new Error('judge_provider_hallucinated_id');
    }
    return { verdict: parsed.data, promptHash };
  }
}

export interface PruningFusionInput {
  // Deterministic retention score in 0..1 (lower means stronger decay pressure).
  deterministicScore: number;
  // Calibrated judge score/confidence in 0..1 supporting the pruning proposal.
  calibratedScore: number;
  calibratedVerdict: 'accept' | 'reject';
}

export interface PruningFusionOutput {
  fusedScore: number;
  decision: 'accept' | 'reject';
  winner: 'consensus' | 'deterministic' | 'calibrated';
}

// Explicit fusion policy between the deterministic retention score and the
// calibrated judge on llama.cpp. Rule: on a tie or when the calibrated verdict
// is below its confidence floor, the deterministic side always wins.
export function fusePruningScores(input: PruningFusionInput): PruningFusionOutput {
  const deterministicWantsPrune = input.deterministicScore < pruningPolicy.memoryScoreThreshold;
  const deterministicPressure = Math.max(0, Math.min(1, 1 - input.deterministicScore));
  const calibratedEffective =
    input.calibratedVerdict === 'accept' &&
    input.calibratedScore >= pruningPolicy.verdictConfidenceThreshold
      ? Math.max(0, Math.min(1, input.calibratedScore))
      : 0;
  const calibratedWantsPrune = calibratedEffective > 0;

  const fusedScore =
    pruningPolicy.fusionWeights.deterministic * deterministicPressure +
    pruningPolicy.fusionWeights.calibrated * calibratedEffective;

  if (deterministicWantsPrune === calibratedWantsPrune) {
    return {
      fusedScore,
      decision: deterministicWantsPrune ? 'accept' : 'reject',
      winner: 'consensus',
    };
  }

  // Tie-break rule from potatura-semantica.md §1/§4: in parity, the
  // deterministic score always wins.
  if (Math.abs(fusedScore - pruningPolicy.fusionAcceptThreshold) < 1e-9) {
    return {
      fusedScore,
      decision: deterministicWantsPrune ? 'accept' : 'reject',
      winner: 'deterministic',
    };
  }

  const decision = fusedScore > pruningPolicy.fusionAcceptThreshold ? 'accept' : 'reject';
  return {
    fusedScore,
    decision,
    winner: (decision === 'accept') === deterministicWantsPrune ? 'deterministic' : 'calibrated',
  };
}
