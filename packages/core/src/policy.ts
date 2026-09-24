import type { MemoryActor, ProposalResult, ProposeMemoryInput } from '@mnemosyne/contracts';

const secretPatterns: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/iu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"]?(?:[^\s'"]+){8,}/iu,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
];

export function containsSecret(value: string): boolean {
  return secretPatterns.some((pattern) => pattern.test(value));
}

export function decideProposal(
  input: ProposeMemoryInput,
  actor: MemoryActor,
  explicitDirective: boolean,
): ProposalResult {
  if (input.sensitivity === 'secret' || containsSecret(input.content)) {
    return { status: 'rejected', reason: 'sensitive_content' };
  }

  if (actor === 'owner' && explicitDirective) {
    return { status: 'accepted' };
  }

  if (
    (input.kind === 'preference' || input.kind === 'instruction') &&
    input.scope.type === 'global'
  ) {
    return { status: 'pending_approval' };
  }

  if (input.kind === 'hypothesis') {
    return { status: 'pending_approval' };
  }

  return { status: 'pending_approval' };
}
