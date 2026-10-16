import type { PrivacyFlag } from './types.js';

// Effective privacy of a node: the per-node override wins over the project,
// and without an override the project flag is inherited. LOCAL_ONLY by
// construction when neither says otherwise is enforced by column defaults,
// not here: this function only resolves the precedence.
export function effectivePrivacy(
  memoryPrivacy: PrivacyFlag | null | undefined,
  projectPrivacy: PrivacyFlag,
): PrivacyFlag {
  return memoryPrivacy ?? projectPrivacy;
}
