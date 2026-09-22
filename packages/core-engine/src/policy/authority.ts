/**
 * @file Canonical authority verdict (implement/04 §3.2.1, SRS §12, BR-008/BR-009).
 *
 * The only numeric comparison in the platform is
 * `AUTHORITY_RANK[granted] < AUTHORITY_RANK[required]`, and it is reachable only when BOTH values
 * are assignable clearances (`AUTH-0..AUTH-3`). `AUTH-4` and `AUTH-5` are verdicts, not clearances:
 * they are absent from `AUTHORITY_RANK` and short-circuit before any rank lookup of the
 * requirement, so no grant — not even `AUTH-3` — can ever auto-approve them.
 *
 *   required = AUTH-4 → `AWAITING_HUMAN_APPROVAL`: persist exactly one PENDING approval
 *                       (`approvals`, SCR-003) and pause. The approval authorizes one specific
 *                       (tenant_id, run_id, effect_key) execution and never raises a clearance.
 *   required = AUTH-5 → `DENIED`: prohibited. Never queued, never approvable, never dispatched;
 *                       an audit record with `execution_status = 'denied'` is written.
 */

import {
  AUTHORITY_RANK,
  type AssignableAuthority,
  type AuthorityLevel,
  type AuthorityVerdict,
} from '../contracts/types.js';

/**
 * Evaluates the authority gate for one drafted action.
 *
 * @param granted The clearance held by the requesting agent (`AUTH-0..AUTH-3`).
 * @param required The clearance the drafted step declares (`AUTH-0..AUTH-5`).
 * @returns The verdict plus the reason code recorded in the audit trail.
 */
export function evaluateAuthorityVerdict(
  granted: AssignableAuthority,
  required: AuthorityLevel,
): { verdict: AuthorityVerdict; reason: string } {
  if (!Object.hasOwn(AUTHORITY_RANK, granted)) {
    return { verdict: 'DENIED', reason: `INVALID_CLEARANCE: '${String(granted)}' is not assignable.` };
  }
  if (required === 'AUTH-5') {
    return { verdict: 'DENIED', reason: 'PROHIBITED_ACTION: AUTH-5 is a hard deny verdict (SRS §12, BR-008).' };
  }
  if (required === 'AUTH-4') {
    return { verdict: 'AWAITING_HUMAN_APPROVAL', reason: 'APPROVAL_REQUIRED: AUTH-4 requires a bound human decision (BR-007).' };
  }
  if (!Object.hasOwn(AUTHORITY_RANK, required)) {
    return { verdict: 'DENIED', reason: `INVALID_AUTHORITY_REQUIREMENT: '${String(required)}' is unknown.` };
  }
  if (AUTHORITY_RANK[granted] < AUTHORITY_RANK[required as AssignableAuthority]) {
    return { verdict: 'DENIED', reason: `INSUFFICIENT_AUTHORITY: requires ${required}, granted ${granted}.` };
  }
  return { verdict: 'AUTO_APPROVED', reason: `AUTHORIZED: ${granted} covers ${required}.` };
}
