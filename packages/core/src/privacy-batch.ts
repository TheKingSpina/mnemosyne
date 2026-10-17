import type { PrivacyFlag } from './types.js';
import type { AnalyzerBatch, AnalyzerNode, MemoryKind } from '@mnemosyne/contracts';
import { effectivePrivacy } from './privacy.js';

export interface AnalyzerBatchInput {
  memoryId: string;
  kind: MemoryKind;
  scopeKind: 'session' | 'project' | 'area';
  updatedAt: string;
  content: string;
  recordPrivacy: PrivacyFlag | null;
  projectPrivacy: PrivacyFlag | undefined;
  incidentArcTypes: string[];
}

// Splits analyzable memories into same-flag batches, dropping everything
// local_only before it can reach a network call. A missing project resolves
// to local_only: when the root is unknown, nothing leaves the perimeter.
export function composeAnalyzerBatches(
  memories: AnalyzerBatchInput[],
  maxBatchSize: number,
  now: string,
): AnalyzerBatch[] {
  const batches: AnalyzerBatch[] = [];
  const open = new Map<'public' | 'anonymized', AnalyzerNode[]>();
  // Fixed flag order and memoryId-sorted members: the same corpus state always
  // produces the same batches, so a re-run can recognise its own past by id.
  const flush = (privacy: 'public' | 'anonymized', items: AnalyzerNode[]) => {
    const ordered = items.sort((left, right) => left.memoryId.localeCompare(right.memoryId));
    for (let index = 0; index < ordered.length; index += maxBatchSize) {
      batches.push({ privacy, items: ordered.slice(index, index + maxBatchSize) });
    }
  };
  for (const memory of memories) {
    const effective = effectivePrivacy(memory.recordPrivacy, memory.projectPrivacy ?? 'local_only');
    if (effective !== 'public' && effective !== 'anonymized') continue;
    const node: AnalyzerNode =
      effective === 'public'
        ? {
            memoryId: memory.memoryId,
            kind: memory.kind,
            scopeKind: memory.scopeKind,
            ageBucket: ageBucket(memory.updatedAt, now),
            incidentArcTypes: [...memory.incidentArcTypes],
            content: memory.content,
          }
        : {
            memoryId: memory.memoryId,
            kind: memory.kind,
            scopeKind: memory.scopeKind,
            ageBucket: ageBucket(memory.updatedAt, now),
            incidentArcTypes: [...memory.incidentArcTypes],
          };
    const group = open.get(effective);
    if (group) group.push(node);
    else open.set(effective, [node]);
  }
  for (const privacy of ['public', 'anonymized'] as const) {
    const items = open.get(privacy);
    if (items) flush(privacy, items);
  }
  return batches;
}

function ageBucket(updatedAt: string, now: string): AnalyzerNode['ageBucket'] {
  const ageDays = Math.max(0, (Date.parse(now) - Date.parse(updatedAt)) / 86_400_000);
  if (ageDays < 7) return '<7d';
  if (ageDays < 30) return '<30d';
  if (ageDays < 180) return '<180d';
  return 'older';
}
