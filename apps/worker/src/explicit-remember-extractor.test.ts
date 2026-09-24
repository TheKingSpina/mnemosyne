import { extractionResultSchema } from '@mnemosyne/contracts';
import type { EventRecord, SessionRecord } from '@mnemosyne/core';
import { describe, expect, it } from 'vitest';
import { ExplicitRememberExtractor } from './explicit-remember-extractor.js';

const session: SessionRecord = {
  id: 'ses_synthetic',
  projectId: 'synthetic-project',
  areaIds: ['software'],
  sequence: 3,
  status: 'open',
  createdAt: '2026-01-20T10:00:00Z',
};

function event(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: 'evt_synthetic',
    sessionId: session.id,
    sequence: 1,
    type: 'message',
    role: 'user',
    content: 'Ricorda che il progetto usa pnpm',
    occurredAt: '2026-01-20T10:01:00Z',
    explicitMemoryRequest: true,
    ...overrides,
  };
}

describe('ExplicitRememberExtractor', () => {
  it('extracts a project convention with its source event', async () => {
    const result = extractionResultSchema.parse(
      await new ExplicitRememberExtractor().extract({ session, events: [event()] }),
    );

    expect(result.candidates).toEqual([
      expect.objectContaining({
        sessionId: session.id,
        eventIds: [event().id],
        content: 'il progetto usa pnpm',
        kind: 'convention',
        scope: { type: 'project', id: session.projectId },
        epistemicBasis: 'user_asserted',
      }),
    ]);
  });

  it('ignores events that are not explicit user memory requests', async () => {
    const result = extractionResultSchema.parse(
      await new ExplicitRememberExtractor().extract({
        session,
        events: [
          event({ id: 'evt_unmarked', explicitMemoryRequest: false }),
          event({ id: 'evt_assistant', role: 'assistant' }),
        ],
      }),
    );

    expect(result.candidates).toEqual([]);
  });

  it('uses explicit session, area, and global scope markers', async () => {
    const result = extractionResultSchema.parse(
      await new ExplicitRememberExtractor().extract({
        session,
        events: [
          event({ id: 'evt_session', content: 'Ricorda: per questa sessione usa log verbosi' }),
          event({
            id: 'evt_area',
            content: 'Ricorda che nell’area software preferisco TypeScript',
          }),
          event({
            id: 'evt_global',
            content: 'Ricorda che in tutte le sessioni preferisco risposte concise',
          }),
        ],
      }),
    );

    expect(result.candidates.map((candidate) => candidate.scope)).toEqual([
      { type: 'session', id: session.id },
      { type: 'area', id: 'software' },
      { type: 'global', id: 'personal' },
    ]);
    expect(result.candidates.map((candidate) => candidate.kind)).toEqual([
      'convention',
      'preference',
      'preference',
    ]);
  });

  it('skips conflicting scope markers and unknown areas', async () => {
    const result = extractionResultSchema.parse(
      await new ExplicitRememberExtractor().extract({
        session,
        events: [
          event({
            id: 'evt_conflict',
            content: 'Ricorda che per questa sessione e in tutte le sessioni usa log verbosi',
          }),
          event({ id: 'evt_unknown_area', content: 'Ricorda che nell’area sconosciuta usa pnpm' }),
        ],
      }),
    );

    expect(result.candidates).toEqual([]);
  });
});
