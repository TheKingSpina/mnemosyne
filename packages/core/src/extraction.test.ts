import { describe, expect, it, vi } from 'vitest';
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

    expect(job?.status).toBe('quarantined');
    expect(attempts.items[0]?.status).toBe('quarantined');
  });

  it('queues a retryable provider failure until the maximum attempt', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-20T10:00:00Z'));
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
    });
    const session = await service.openSession({ projectId: 'worker-project' });
    const events = await service.recordEvents({
      sessionId: session.sessionId,
      events: [
        {
          eventId: 'worker-event-3',
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
      maxAttempts: 2,
      backoffMs: 1_000,
      extractor: {
        extract: async () => {
          throw new Error('extraction_provider_timeout');
        },
      },
    });

    await worker.runOnce();
    expect((await service.getJob(events.jobIds[0]))?.status).toBe('queued');
    expect(await worker.runOnce()).toBeNull();

    vi.advanceTimersByTime(1_000);
    await worker.runOnce();
    const job = await service.getJob(events.jobIds[0]);
    const attempts = await service.listJobAttempts(events.jobIds[0]);
    vi.useRealTimers();

    expect(job?.status).toBe('failed');
    expect(attempts.items.map((attempt) => attempt.status)).toEqual(['failed', 'failed']);
  });

  it('uses the configured retry classification for provider errors', async () => {
    const repository = new InMemoryRepository();
    const service = new CoreMemoryService(repository, {
      forgetSecret: 'a-secure-test-secret-that-is-long-enough',
    });
    const session = await service.openSession({ projectId: 'worker-project' });
    const events = await service.recordEvents({
      sessionId: session.sessionId,
      events: [
        {
          eventId: 'worker-event-retry-config',
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
      maxAttempts: 2,
      retryableErrorCodes: ['extraction_provider_truncated'],
      extractor: {
        extract: async () => {
          throw new Error('extraction_provider_truncated');
        },
      },
    });

    await worker.runOnce();

    expect((await service.getJob(events.jobIds[0]))?.status).toBe('queued');
  });

  it('recovers a running job after its lease expires', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-20T10:00:00Z'));
    const repository = new InMemoryRepository();
    const job = await repository.createJob({
      operation: 'memory_extraction',
      status: 'queued',
      sessionId: 'synthetic-session',
    });
    const firstClaim = await repository.claimNextJob('first-worker', 1_000);
    if (!firstClaim) throw new Error('test_job_not_claimed');
    await repository.createJobAttempt(
      { jobId: job.id, attempt: 1, status: 'running' },
      'first-worker',
    );
    const secondClaim = await repository.claimNextJob('second-worker', 1_000);

    vi.advanceTimersByTime(1_001);
    const recovered = await repository.claimNextJob('second-worker', 1_000);
    const attempts = await repository.listJobAttempts(job.id);
    vi.useRealTimers();

    expect(firstClaim.id).toBe(job.id);
    expect(firstClaim.leaseOwner).toBe('first-worker');
    expect(secondClaim).toBeNull();
    expect(recovered?.id).toBe(job.id);
    expect(recovered?.leaseOwner).toBe('second-worker');
    expect(recovered?.status).toBe('running');
    expect(attempts.items[0]).toMatchObject({
      attempt: 1,
      status: 'failed',
      errorCode: 'lease_expired',
    });
    expect((await repository.getJob(job.id))?.id).toBe(job.id);
  });

  it('renews a lease only for the worker that owns it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-20T10:00:00Z'));
    const repository = new InMemoryRepository();
    await repository.createJob({
      operation: 'memory_extraction',
      status: 'queued',
      sessionId: 'synthetic-session',
    });
    const claimed = await repository.claimNextJob('owner-worker', 1_000);
    if (!claimed) throw new Error('test_job_not_claimed');

    await expect(repository.renewJobLease(claimed.id, 'other-worker', 1_000)).rejects.toThrow(
      'job_lease_lost',
    );
    const renewed = await repository.renewJobLease(claimed.id, 'owner-worker', 2_000);
    vi.useRealTimers();

    expect(renewed.leaseOwner).toBe('owner-worker');
    expect(renewed.leaseExpiresAt).toBe('2026-01-20T10:00:02.000Z');
  });
});
