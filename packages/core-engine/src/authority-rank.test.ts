import { describe, expect, it } from 'vitest';

import { AUTHORITY_RANK } from './contracts/index.js';

describe('AUTHORITY_RANK', () => {
  it('contains exactly the four assignable clearances', () => {
    expect(Object.keys(AUTHORITY_RANK)).toEqual(['AUTH-0', 'AUTH-1', 'AUTH-2', 'AUTH-3']);
  });

  it('omits AUTH-4 and AUTH-5, which are verdicts and never rank-compared', () => {
    expect(AUTHORITY_RANK).not.toHaveProperty('AUTH-4');
    expect(AUTHORITY_RANK).not.toHaveProperty('AUTH-5');
    expect(AUTHORITY_RANK['AUTH-3']).toBeGreaterThan(AUTHORITY_RANK['AUTH-0']);
  });
});
