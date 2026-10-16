import { describe, expect, it } from 'vitest';
import { effectivePrivacy } from './privacy.js';

describe('effectivePrivacy', () => {
  it('lets the node override win over the project', () => {
    expect(effectivePrivacy('public', 'local_only')).toBe('public');
    expect(effectivePrivacy('local_only', 'public')).toBe('local_only');
  });

  it('inherits the project flag without an override', () => {
    expect(effectivePrivacy(null, 'anonymized')).toBe('anonymized');
    expect(effectivePrivacy(undefined, 'public')).toBe('public');
    expect(effectivePrivacy(null, 'local_only')).toBe('local_only');
  });
});
