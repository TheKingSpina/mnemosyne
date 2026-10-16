import { createHash } from 'node:crypto';
import {
  analyzerResultSchema,
  type AnalyzerBatch,
  type AnalyzerCandidate,
} from '@mnemosyne/contracts';

export interface PruningAnalyzerOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface PruningAnalyzer {
  readonly modelVersion: string;
  analyze(batch: AnalyzerBatch): Promise<{
    candidates: AnalyzerCandidate[];
    promptHash: string;
  }>;
}

export const analyzerSystemPrompt = `You propose pruning candidates for a governed memory service. Return JSON only with a candidates array. Each candidate must contain proposalType (decay, edge, redundancy, contradiction or merge), sourceIds (memory ids from the batch, never invented), rationale, and confidence between 0 and 1. TargetId only for merge, with the proposed synthesis content in rationale. You sign proposals; a deterministic job decides them, and disagreement rejects them. Prefer no candidate over an uncertain one.`;

// Remote analyzer behind the same OpenAI-compatible shape as the extraction
// provider: baseUrl override points it at BYOK endpoints (Gemma via AI Studio)
// instead of OpenRouter. Stage 1 only: it returns candidates, it never writes.
export class RemotePruningAnalyzer implements PruningAnalyzer {
  readonly modelVersion: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly requestTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: PruningAnalyzerOptions) {
    if (options.apiKey.length < 8) throw new Error('analyzer_api_key_invalid');
    if (options.model.length === 0) throw new Error('analyzer_model_invalid');
    this.apiKey = options.apiKey;
    this.modelVersion = options.model;
    this.baseUrl = options.baseUrl ?? 'https://openrouter.ai/api/v1';
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(this.requestTimeoutMs) || this.requestTimeoutMs < 1_000) {
      throw new Error('analyzer_timeout_invalid');
    }
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async analyze(batch: AnalyzerBatch): Promise<{
    candidates: AnalyzerCandidate[];
    promptHash: string;
  }> {
    const userContent = JSON.stringify({ privacy: batch.privacy, items: batch.items });
    const promptHash = createHash('sha256')
      .update(`${analyzerSystemPrompt}\n${userContent}`)
      .digest('hex');
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.modelVersion,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: analyzerSystemPrompt },
            { role: 'user', content: userContent },
          ],
        }),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'TimeoutError') {
        throw new Error('analyzer_provider_timeout', { cause: error });
      }
      throw new Error('analyzer_provider_unavailable', { cause: error });
    }
    if (!response.ok) throw new Error(`analyzer_provider_http_${response.status}`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new Error('analyzer_provider_invalid_response', { cause: error });
    }
    const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
      .choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('analyzer_provider_invalid_response');
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch (error) {
      throw new Error('analyzer_provider_invalid_json', { cause: error });
    }
    const parsed = analyzerResultSchema.safeParse(raw);
    if (!parsed.success) throw new Error('analyzer_provider_invalid_response');
    return { candidates: parsed.data.candidates, promptHash };
  }
}
