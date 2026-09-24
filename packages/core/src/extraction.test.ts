import { describe, expect, it } from 'vitest';
import { CoreMemoryService, ExtractionWorker, InMemoryRepository } from './index.js';

const projectScope = { type: 'project' as const, id: 'worker-project' };

describe('ExtractionWorker', () => {
  it('extracts valid candidates and keeps them pending', async () => {
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
    });
    const session = await service.openSession({ projectId: 'worker-project' });
    const events = await service.recordEvents({
      sessionId: session.sessionId,
      events: [
        {
          eventId: 'worker-event-1',
          type: 'message',
          role: 'user',
          content: 'Ricorda che questo progetto usa pnpm',
          occurredAt: '2026-01-20T10:00:00Z',
          explicitMemoryRequest: true,
        },
      ],
    });
    const worker = new ExtractionWorker({
      repository,
      service,
      workerId: 'test-worker',
      leaseMs: 5_000,
      extractor: {
        extract: async () => ({
          candidates: [
            {
              sessionId: session.sessionId,
              eventIds: ['worker-event-1'],
              content: 'Il progetto usa pnpm',
              kind: 'convention',
              scope: projectScope,
              epistemicBasis: 'observed',
              assessment: 'uncontested',
              confidence: 0.9,
              sensitivity: 'normal',
              activation: 'on_demand',
            },
          ],
        }),
      },
    });

    const result = await worker.runOnce();
    const candidates = await service.listPendingProposals({
      sessionId: session.sessionId,
      limit: 20,
      offset: 0,
    });
    const job = await service.getJob(events.jobIds[0]);

    expect(result?.candidates).toHaveLength(1);
    expect(candidates.items).toHaveLength(1);
    expect(candidates.items[0]?.content).toBe('Il progetto usa pnpm');
    expect(job?.status).toBe('succeeded');
  });

  it('quarantines malformed extractor output', async () => {
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
    });
    const session = await service.openSession({ projectId: 'worker-project' });
    const events = await service.recordEvents({
      sessionId: session.sessionId,
      events: [
        {
          eventId: 'worker-event-2',
          type: 'message',
          role: 'user',
          content: 'Messaggio sintetico',
          occurredAt: '2026-01-20T10:00:00Z',
          explicitMemoryRequest: false,
        },
      ],
    });
    const worker = new ExtractionWorker({
      repository,
      service,
      workerId: 'test-worker',
      extractor: { extract: async () => ({ candidates: 'not-an-array' }) },
    });

    await worker.runOnce();
    const job = await service.getJob(events.jobIds[0]);
    const attempts = await service.listJobAttempts(events.jobIds[0]);

    expect(job?.status).toBe('failed');
    expect(attempts.items[0]?.status).toBe('quarantined');
  });
});
