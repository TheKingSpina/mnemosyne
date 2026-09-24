import { extractionResultSchema } from '@mnemosyne/contracts';
import type { EventRecord, SessionRecord } from '@mnemosyne/core';
import { describe, expect, it, vi } from 'vitest';
import { OpenRouterExtractor } from './provider-extractor.js';

const session: SessionRecord = {
  id: 'ses_synthetic',
  projectId: 'synthetic-project',
  areaIds: ['software'],
  sequence: 1,
  status: 'open',
  createdAt: '2026-01-20T10:00:00Z',
};

const event: EventRecord = {
  id: 'evt_synthetic',
  sessionId: session.id,
  sequence: 1,
  type: 'message',
  role: 'user',
  content: 'Ricorda che il progetto usa pnpm',
  occurredAt: '2026-01-20T10:01:00Z',
  explicitMemoryRequest: true,
};

function providerResponse(content: string, status = 200): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content }, finish_reason: 'stop' }],
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventIds: [event.id],
    content: 'Il progetto usa pnpm',
    kind: 'convention',
    scopeType: 'project',
    scopeId: session.projectId,
    epistemicBasis: 'user_asserted',
    assessment: 'uncontested',
    confidence: 0.9,
    sensitivity: 'normal',
    activation: 'on_demand',
    ...overrides,
  };
}

function createExtractor(fetchImpl: typeof fetch): OpenRouterExtractor {
  return new OpenRouterExtractor({
    apiKey: 'synthetic-provider-key-1234567890',
    model: 'synthetic/model',
    fetchImpl,
  });
}

describe('OpenRouterExtractor', () => {
  it('maps a valid provider candidate and sends the authenticated request', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(providerResponse(JSON.stringify({ candidates: [candidate()] })));
    const result = extractionResultSchema.parse(
      await createExtractor(fetchImpl).extract({ session, events: [event] }),
    );

    expect(result.candidates).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        eventIds: [event.id],
        content: 'Il progetto usa pnpm',
        kind: 'convention',
        scope: { type: 'project', id: session.projectId },
      }),
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    const request = fetchImpl.mock.calls[0];
    const headers = new Headers(request?.[1]?.headers);
    expect(headers.get('authorization')).toBe('Bearer synthetic-provider-key-1234567890');
  });

  it('returns no candidates when the provider returns none', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(providerResponse(JSON.stringify({ candidates: [] })));
    await expect(createExtractor(fetchImpl).extract({ session, events: [event] })).resolves.toEqual(
      { candidates: [] },
    );
  });

  it('quarantines malformed provider JSON', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(providerResponse('not-json'));
    await expect(createExtractor(fetchImpl).extract({ session, events: [event] })).rejects.toThrow(
      'extraction_provider_invalid_json',
    );
  });

  it('rejects a provider candidate with an invalid classification', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        providerResponse(JSON.stringify({ candidates: [candidate({ kind: 'unknown-kind' })] })),
      );

    await expect(
      createExtractor(fetchImpl).extract({ session, events: [event] }),
    ).rejects.toThrow();
  });

  it('maps provider HTTP failures to retryable and non-retryable error codes', async () => {
    const retryable = vi.fn<typeof fetch>().mockResolvedValue(providerResponse('{}', 503));
    const permanent = vi.fn<typeof fetch>().mockResolvedValue(providerResponse('{}', 400));

    await expect(createExtractor(retryable).extract({ session, events: [event] })).rejects.toThrow(
      'extraction_provider_unavailable',
    );
    await expect(createExtractor(permanent).extract({ session, events: [event] })).rejects.toThrow(
      'extraction_provider_http_error',
    );
  });
});
