import { describe, expect, it } from 'vitest';

import { maskEmail, maskIdentity, maskPhone, maskOpaqueIdentity } from './masking.js';

describe('identity masking', () => {
  it('retains email shape without exposing local or domain values', () => {
    expect(maskEmail('alice@example.com')).toBe('a***@e***.com');
    expect(maskIdentity('alice@example.com', 'email')).toBe('a***@e***.com');
  });

  it('retains only the last four phone digits', () => {
    expect(maskPhone('+886 9123-4567')).toBe('***4567');
    expect(maskIdentity('+886 9123-4567', 'phone')).toBe('***4567');
  });

  it('fails closed for opaque and malformed identities', () => {
    expect(maskOpaqueIdentity('line-user-123')).toBe('l***23');
    expect(maskIdentity('short', 'line')).toBe('s***rt');
    expect(maskEmail('not-an-email')).toBe('***');
  });
});
