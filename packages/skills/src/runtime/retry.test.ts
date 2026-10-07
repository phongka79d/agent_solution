import { describe, expect, it } from 'vitest';

import { SkillError } from '../contracts/index.js';
import { errorCodeOf } from './retry.js';

describe('errorCodeOf', () => {
  it('prefers timeout, SkillError code, provider code, then provider message', () => {
    expect(errorCodeOf(new Error('late'), true)).toBe('TIMEOUT');
    expect(errorCodeOf(new SkillError('EFFECT_UNKNOWN', 'unknown'), false)).toBe('EFFECT_UNKNOWN');
    expect(errorCodeOf({ code: 'PROVIDER_503', message: 'unavailable' }, false)).toBe('PROVIDER_503');
    expect(errorCodeOf({ message: 'unavailable' }, false)).toBe('unavailable');
  });

  it('maps empty or non-object throws to a stable unknown code', () => {
    expect(errorCodeOf({ code: '', message: '' }, false)).toBe('UNKNOWN_ERROR');
    expect(errorCodeOf(null, false)).toBe('UNKNOWN_ERROR');
    expect(errorCodeOf('provider failed', false)).toBe('UNKNOWN_ERROR');
  });
});
