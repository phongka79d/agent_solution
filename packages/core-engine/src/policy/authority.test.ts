/**
 * @file Authority gate tests (implement/04 §3.2.1). The point of these cases is the boundary
 * between clearances and verdicts: `AUTH-4` and `AUTH-5` must be resolved before any rank
 * comparison, and `AUTHORITY_RANK` must have nothing for them to be compared against.
 */

import { describe, expect, it } from 'vitest';

import { AUTHORITY_RANK, type AssignableAuthority, type AuthorityLevel } from '../contracts/types.js';
import { evaluateAuthorityVerdict } from './authority.js';

const ASSIGNABLE_GRANTS: readonly AssignableAuthority[] = ['AUTH-0', 'AUTH-1', 'AUTH-2', 'AUTH-3'];

describe('evaluateAuthorityVerdict', () => {
  it('auto-approves a step the grant covers by rank', () => {
    expect(evaluateAuthorityVerdict('AUTH-0', 'AUTH-0')).toMatchObject({
      verdict: 'AUTO_APPROVED',
      reason: 'AUTHORIZED: AUTH-0 covers AUTH-0.',
      errorCode: null,
      rankCompared: true,
    });
    expect(evaluateAuthorityVerdict('AUTH-2', 'AUTH-1').verdict).toBe('AUTO_APPROVED');
    expect(evaluateAuthorityVerdict('AUTH-3', 'AUTH-3').verdict).toBe('AUTO_APPROVED');
  });

  it('denies a lower grant as INSUFFICIENT_AUTHORITY', () => {
    for (const required of ['AUTH-1', 'AUTH-2', 'AUTH-3'] as const) {
      expect(evaluateAuthorityVerdict('AUTH-0', required)).toMatchObject({
        verdict: 'DENIED',
        reason: expect.stringContaining(`requires ${required}`),
        errorCode: 'INSUFFICIENT_AUTHORITY',
        rankCompared: true,
      });
    }
    expect(evaluateAuthorityVerdict('AUTH-1', 'AUTH-3').verdict).toBe('DENIED');
  });

  it('routes AUTH-4 to the human gate for every grant, before any rank comparison', () => {
    for (const granted of ASSIGNABLE_GRANTS) {
      const result = evaluateAuthorityVerdict(granted, 'AUTH-4');
      expect(result.verdict).toBe('AWAITING_HUMAN_APPROVAL');
      expect(result.reason).toMatch(/^APPROVAL_REQUIRED:/);
    }
    // `AUTH-0` < `AUTH-3` by rank: an insufficient-authority compare running first would have
    // returned DENIED, so this case pins the short-circuit.
    expect(evaluateAuthorityVerdict('AUTH-0', 'AUTH-4').verdict).toBe('AWAITING_HUMAN_APPROVAL');
    expect(evaluateAuthorityVerdict('AUTH-3', 'AUTH-4').verdict).not.toBe('AUTO_APPROVED');
  });

  it('hard-denies AUTH-5 for every grant, before any rank comparison', () => {
    for (const granted of ASSIGNABLE_GRANTS) {
      const result = evaluateAuthorityVerdict(granted, 'AUTH-5');
      expect(result.verdict).toBe('DENIED');
      expect(result.reason).toMatch(/^PROHIBITED_ACTION:/);
    }
    expect(evaluateAuthorityVerdict('AUTH-3', 'AUTH-5')).toMatchObject({
      verdict: 'DENIED',
      reason: expect.stringContaining('PROHIBITED_ACTION'),
      errorCode: 'PROHIBITED_ACTION',
      rankCompared: false,
    });
  });

  it('has no rank for AUTH-4 or AUTH-5 to be compared against', () => {
    expect(Object.hasOwn(AUTHORITY_RANK, 'AUTH-4')).toBe(false);
    expect(Object.hasOwn(AUTHORITY_RANK, 'AUTH-5')).toBe(false);
    expect(Object.keys(AUTHORITY_RANK)).toEqual(['AUTH-0', 'AUTH-1', 'AUTH-2', 'AUTH-3']);
  });

  it('denies an unknown requirement instead of guessing a clearance', () => {
    for (const required of ['AUTH-6', 'AUTH-9', 'auth-3', '']) {
      const result = evaluateAuthorityVerdict('AUTH-3', required as AuthorityLevel);
      expect(result.verdict).toBe('DENIED');
      expect(result.reason).toMatch(/^INVALID_AUTHORITY_REQUIREMENT:/);
    }
  });

  it('denies an unassignable grant as INVALID_CLEARANCE and treats absence as missing', () => {
    for (const granted of ['AUTH-4', 'AUTH-5', 'AUTH-9']) {
      const result = evaluateAuthorityVerdict(granted, 'AUTH-3');
      expect(result.verdict).toBe('DENIED');
      expect(result.errorCode).toBe('INVALID_CLEARANCE');
      expect(result.reason).toMatch(/^INVALID_CLEARANCE:/);
    }

    expect(evaluateAuthorityVerdict('', 'AUTH-3')).toMatchObject({
      verdict: 'DENIED',
      errorCode: 'CLEARANCE_REQUIRED',
    });
  });
});
