import type { ContextOutput, MemoryRevision } from '@mnemosyne/contracts';

export interface FormatContextOptions {
  includeDisputedWarning?: boolean;
}

/**
 * Formats resolved context items into a clean, human- and LLM-readable prompt block.
 * When memories are subject to open conflicts, explicit warning tags and conflicting IDs
 * are rendered in-band so LLM harnesses do not treat contradictory assertions as axioms.
 */
export function formatContextForPrompt(
  output: Pick<ContextOutput, 'context' | 'conflicts'>,
  options: FormatContextOptions = {},
): string {
  if (!output.context || output.context.length === 0) return '';
  const includeWarning = options.includeDisputedWarning ?? true;

  const conflictByMemoryId = new Map<string, string[]>();
  if (includeWarning && output.conflicts) {
    for (const conflict of output.conflicts) {
      for (const id of conflict.memoryIds) {
        const others = conflict.memoryIds.filter((otherId) => otherId !== id);
        const existing = conflictByMemoryId.get(id) ?? [];
        conflictByMemoryId.set(id, [...new Set([...existing, ...others])]);
      }
    }
  }

  return output.context
    .map((memory: MemoryRevision) => {
      const opposing = conflictByMemoryId.get(memory.memoryId);
      const isDisputed = memory.assessment === 'disputed' || (opposing && opposing.length > 0);
      const flag =
        includeWarning && isDisputed
          ? opposing && opposing.length > 0
            ? ` [DISPUTED / CONTRADICTS ${opposing.join(', ')}]`
            : ' [DISPUTED]'
          : '';
      return `- [${memory.kind.toUpperCase()}${flag}]: ${memory.content}`;
    })
    .join('\n');
}
