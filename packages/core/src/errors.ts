export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function toDomainError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  if (error instanceof Error) {
    const messages: Record<string, [string, number]> = {
      session_not_found: ['Session not found', 404],
      session_closed: ['Session is closed', 409],
      session_not_open: ['Session must be open', 409],
      memory_not_found: ['Memory not found', 404],
      memory_not_active: ['Memory is not active', 409],
      proposal_not_pending: ['Proposal is not pending', 409],
      memory_version_conflict: ['Memory version is stale', 409],
      idempotency_key_conflict: ['Idempotency key was already used with another payload', 409],
      idempotency_key_required: ['Idempotency-Key is required for this write', 400],
      idempotency_key_invalid: ['Idempotency-Key is invalid', 400],
      idempotency_in_progress: ['The request with this Idempotency-Key is still in progress', 409],
      restore_requires_empty_corpus: ['Corpus restore requires an empty corpus', 409],
      restore_invalid_export: ['Corpus export is not internally consistent', 400],
      session_not_closed: ['Session must be closed before consolidation', 409],
      conflict_not_found: ['Conflict not found', 404],
      scope_not_available: ['Scope is not available in this session', 403],
      harness_cannot_issue_owner_directive: ['Harness cannot issue an owner directive', 403],
      invalid_confirmation_token: ['Invalid confirmation token', 400],
      invalid_reason: ['Invalid reason', 400],
      sensitive_content: ['Sensitive content was rejected', 400],
      invalid_object_body: ['Request body must be an object', 400],
      request_body_too_large: ['Request body is too large', 413],
      invalid_json: ['Request body must be valid JSON', 400],
      forget_secret_too_short: ['Forget secret is too short', 500],
    };
    const found = messages[error.message];
    if (found) return new DomainError(error.message, found[0], found[1]);
  }
  return new DomainError('internal_error', 'Unexpected internal error', 500);
}
