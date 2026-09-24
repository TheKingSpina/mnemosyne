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
}

export class ExtractionWorker {
  private readonly leaseMs: number;

  constructor(private readonly options: ExtractionWorkerOptions) {
    this.leaseMs = options.leaseMs ?? 30_000;
    if (this.leaseMs < 1_000) throw new Error('extraction_lease_too_short');
  }

  async runOnce(): Promise<ExtractionResult | null> {
    const job = await this.options.repository.claimNextJob(this.options.workerId, this.leaseMs);
    if (!job) return null;
    if (job.operation !== 'memory_extraction') {
      await this.options.repository.updateJob(job.id, 'succeeded');
      return { candidates: [] };
    }
    const session = await this.options.repository.findSession(job.sessionId);
    if (!session) {
      await this.fail(job.id, 'session_not_found');
      return { candidates: [] };
    }
    const events = await this.options.repository.listEvents(job.sessionId);
    const previousAttempts = await this.options.repository.listJobAttempts(job.id);
    const attempt = await this.options.repository.createJobAttempt({
      jobId: job.id,
      attempt: previousAttempts.items.length + 1,
      status: 'running',
    });
    try {
      const raw = await this.options.extractor.extract({ session, events });
      const result = extractionResultSchema.parse(raw);
      const candidates = this.filterCandidates(result.candidates, session, events);
      for (const candidate of candidates) {
        await this.createCandidate(candidate, session);
      }
      await this.options.repository.finishJobAttempt(attempt.id, 'succeeded');
      await this.options.repository.updateJob(job.id, 'succeeded');
      return { candidates };
    } catch (error) {
      await this.options.repository.finishJobAttempt(
        attempt.id,
        'quarantined',
        error instanceof Error ? error.message : 'extraction_failed',
      );
      await this.options.repository.updateJob(job.id, 'failed');
      return { candidates: [] };
    }
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

  private async fail(jobId: string, errorCode: string): Promise<void> {
    await this.options.repository.updateJob(jobId, 'failed');
    void errorCode;
  }
}
