import type {
  ExtractionCandidate,
  ExtractionResult,
  ProposeMemoryInput,
  Scope,
} from '@mnemosyne/contracts';
import { extractionResultSchema } from '@mnemosyne/contracts';
import { containsSecret } from './policy.js';
import type { EventRecord, MemoryRepository, MemoryService, SessionRecord } from './types.js';

export interface Extractor {
  extract(input: { session: SessionRecord; events: EventRecord[] }): Promise<unknown>;
}

export interface ExtractionWorkerOptions {
  repository: MemoryRepository;
  service: MemoryService;
  extractor: Extractor;
  workerId: string;
  leaseMs?: number;
  maxAttempts?: number;
  backoffMs?: number;
  heartbeatMs?: number;
  retryableErrorCodes?: readonly string[];
}

export class ExtractionWorker {
  private readonly leaseMs: number;
  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly heartbeatMs: number;
  private readonly retryableErrorCodes: ReadonlySet<string>;

  constructor(private readonly options: ExtractionWorkerOptions) {
    this.leaseMs = options.leaseMs ?? 30_000;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.backoffMs = options.backoffMs ?? 1_000;
    this.heartbeatMs = options.heartbeatMs ?? Math.max(250, Math.floor(this.leaseMs / 3));
    this.retryableErrorCodes = new Set(
      options.retryableErrorCodes ?? [
        'extraction_provider_timeout',
        'extraction_provider_unavailable',
        'extraction_temporarily_unavailable',
      ],
    );
    if (this.leaseMs < 1_000) throw new Error('extraction_lease_too_short');
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1)
      throw new Error('extraction_max_attempts_invalid');
    if (!Number.isSafeInteger(this.backoffMs) || this.backoffMs < 0)
      throw new Error('extraction_backoff_invalid');
    if (
      !Number.isSafeInteger(this.heartbeatMs) ||
      this.heartbeatMs < 250 ||
      this.heartbeatMs >= this.leaseMs
    )
      throw new Error('extraction_heartbeat_invalid');
  }

  async runOnce(): Promise<ExtractionResult | null> {
    const job = await this.options.repository.claimNextJob(this.options.workerId, this.leaseMs);
    if (!job) return null;
    if (job.operation !== 'memory_extraction') {
      await this.options.repository.updateJob(job.id, 'succeeded', this.options.workerId);
      return { candidates: [] };
    }
    const session = await this.options.repository.findSession(job.sessionId);
    if (!session) {
      await this.options.repository.updateJob(job.id, 'failed', this.options.workerId);
      return { candidates: [] };
    }
    const events = await this.options.repository.listEvents(job.sessionId);
    const previousAttempts = await this.options.repository.listJobAttempts(job.id);
    if (previousAttempts.items.length >= this.maxAttempts) {
      await this.options.repository.updateJob(job.id, 'failed', this.options.workerId);
      return { candidates: [] };
    }
    const attemptNumber = previousAttempts.items.length + 1;
    const attempt = await this.options.repository.createJobAttempt(
      {
        jobId: job.id,
        attempt: attemptNumber,
        status: 'running',
      },
      this.options.workerId,
    );
    const heartbeat = setInterval(() => {
      void this.options.repository
        .renewJobLease(job.id, this.options.workerId, this.leaseMs)
        .catch(() => undefined);
    }, this.heartbeatMs);
    heartbeat.unref();
    try {
      const raw = await this.options.extractor.extract({ session, events });
      const result = extractionResultSchema.parse(raw);
      const candidates = this.filterCandidates(result.candidates, session, events);
      for (const candidate of candidates) {
        await this.createCandidate(candidate, session);
      }
      await this.options.repository.finishJobAttempt(
        attempt.id,
        'succeeded',
        this.options.workerId,
      );
      await this.options.repository.updateJob(job.id, 'succeeded', this.options.workerId);
      return { candidates };
    } catch (error) {
      const errorCode = error instanceof Error ? error.message : 'extraction_failed';
      const retryable = this.isRetryable(errorCode);
      await this.options.repository.finishJobAttempt(
        attempt.id,
        retryable ? 'failed' : 'quarantined',
        this.options.workerId,
        errorCode,
      );
      if (retryable && attemptNumber < this.maxAttempts) {
        const availableAt = Date.now() + this.backoffMs * 2 ** (attemptNumber - 1);
        await this.options.repository.retryJob(
          job.id,
          this.options.workerId,
          new Date(availableAt).toISOString(),
        );
      } else {
        await this.options.repository.updateJob(
          job.id,
          retryable ? 'failed' : 'quarantined',
          this.options.workerId,
        );
      }
      return { candidates: [] };
    } finally {
      clearInterval(heartbeat);
    }
  }

  private isRetryable(errorCode: string): boolean {
    return this.retryableErrorCodes.has(errorCode);
  }

  private filterCandidates(
    candidates: readonly ExtractionCandidate[],
    session: SessionRecord,
    events: readonly EventRecord[],
  ): ExtractionCandidate[] {
    const eventIds = new Set(events.map((event) => event.id));
    return candidates.filter((candidate) => {
      if (candidate.sessionId !== session.id) return false;
      if (!candidate.eventIds.every((eventId) => eventIds.has(eventId))) return false;
      if (containsSecret(candidate.content) || candidate.sensitivity === 'secret') return false;
      return (
        candidate.scope.type === 'session' || this.scopeMatchesSession(candidate.scope, session)
      );
    });
  }

  private async createCandidate(
    candidate: ExtractionCandidate,
    session: SessionRecord,
  ): Promise<void> {
    const input: ProposeMemoryInput = {
      sessionId: session.id,
      content: candidate.content,
      kind: candidate.kind,
      scope: candidate.scope,
      epistemicBasis: candidate.epistemicBasis,
      assessment: candidate.assessment,
      confidence: candidate.confidence,
      sensitivity: candidate.sensitivity,
      activation: candidate.activation,
      sourceEventIds: candidate.eventIds,
    };
    const result = await this.options.service.proposeMemory(input, {
      actor: 'harness',
      explicitDirective: false,
    });
    if (result.status === 'accepted') {
      throw new Error('extraction_candidate_was_auto_accepted');
    }
  }

  private scopeMatchesSession(scope: Scope, session: SessionRecord): boolean {
    return (
      (scope.type === 'project' && scope.id === session.projectId) ||
      (scope.type === 'area' && session.areaIds.includes(scope.id)) ||
      (scope.type === 'global' && scope.id === 'personal')
    );
  }
}
