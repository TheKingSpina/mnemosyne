import { describe, expect, it, vi } from 'vitest';
import { ExtractionProviderError, type EventRecord, type SessionRecord } from '@mnemosyne/core';
import { ProviderRouter } from './provider-router.js';

const session: SessionRecord = {
  id: 'ses_synthetic',
  projectId: 'synthetic-project',
  areaIds: [],
  sequence: 0,
  status: 'open',
  createdAt: '2026-01-20T10:00:00Z',
};
const events: EventRecord[] = [];

describe('ProviderRouter', () => {
  it('falls back to a later provider after a retryable provider failure', async () => {
    const firstExtractor = {
      extract: vi
        .fn()
        .mockRejectedValue(new ExtractionProviderError('extraction_provider_timeout')),
    };
    const fallbackExtractor = { extract: vi.fn().mockResolvedValue({ candidates: [] }) };
    const router = new ProviderRouter([
      { name: 'first', extractor: firstExtractor },
      { name: 'fallback', extractor: fallbackExtractor },
    ]);

    await expect(router.extract({ session, events })).resolves.toEqual({ candidates: [] });
    expect(firstExtractor.extract).toHaveBeenCalledOnce();
    expect(fallbackExtractor.extract).toHaveBeenCalledOnce();
  });

  it('does not fall back after a non-provider error', async () => {
    const first = { extract: vi.fn().mockRejectedValue(new Error('invalid_extractor_output')) };
    const fallback = { extract: vi.fn().mockResolvedValue({ candidates: [] }) };
    const router = new ProviderRouter([
      { name: 'first', extractor: first },
      { name: 'fallback', extractor: fallback },
    ]);

    await expect(router.extract({ session, events })).rejects.toThrow('invalid_extractor_output');
    expect(fallback.extract).not.toHaveBeenCalled();
  });
});
