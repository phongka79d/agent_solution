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
} from '../contracts/index.js';

/** Every label of the §12 authority vocabulary, in ascending order of restriction. */
export const AUTHORITY_LEVELS: readonly AuthorityLevel[] = Object.freeze([
  'AUTH-0',
  'AUTH-1',
  'AUTH-2',
  'AUTH-3',
  'AUTH-4',
  'AUTH-5',
]);

/**
 * Stable refusal codes of the authority gate (implement/08 §2.2, §8 BR-008 row). They are the
 * `errorCode` half of a denial; the verdict vocabulary itself stays `AuthorityVerdict`.
 */
export type AuthorityDenyCode =
  /** No clearance was granted at all; absence is not "no requirement". */
  | 'CLEARANCE_REQUIRED'
  /** A grant exists but is not one of the four assignable clearances (BR-008, fail closed). */
  | 'INVALID_CLEARANCE'
  /** The requirement is missing or outside the six-label vocabulary. */
  | 'INVALID_AUTHORITY_REQUIREMENT'
  /** `required = AUTH-5`: prohibited, never queued and never approvable. */
  | 'PROHIBITED_ACTION'
  /** A valid grant below a valid autonomous requirement. */
  | 'INSUFFICIENT_AUTHORITY';

/** Outcome of the authority gate for one (granted, required) pair. */
export interface AuthorityDecision {
  readonly verdict: AuthorityVerdict;
  /** The validated grant, or `null` when none assignable was presented. */
  readonly granted: AssignableAuthority | null;
  /** The validated requirement, or `null` when none from the vocabulary was presented. */
  readonly required: AuthorityLevel | null;
  /** `null` exactly when the verdict is `AUTO_APPROVED`. */
  readonly errorCode: AuthorityDenyCode | null;
  readonly reason: string;
  /**
   * `true` only when the numeric rank comparison actually ran — i.e. a valid grant met a valid
   * `AUTH-0..3` requirement. An `AUTH-4` route and every denial short-circuit before it.
   */
  readonly rankCompared: boolean;
}

/**
 * Reports whether a value is one of the six labels of the authority vocabulary.
 *
 * @param value - Candidate label.
 * @returns `true` for `AUTH-0`..`AUTH-5`.
 */
export function isAuthorityLevel(value: unknown): value is AuthorityLevel {
  return typeof value === 'string' && AUTHORITY_LEVELS.some((level) => level === value);
}

/**
 * Reports whether a value is one of the four *assignable* clearances.
 *
 * @param value - Candidate grant.
 * @returns `true` for `AUTH-0`..`AUTH-3`; `false` for `AUTH-4`, `AUTH-5`, an unknown label and
 *   every non-string value.
 */
export function isAssignableAuthority(value: unknown): value is AssignableAuthority {
  return typeof value === 'string' && Object.hasOwn(AUTHORITY_RANK, value);
}

/**
 * Total order over *requirements* only. The four autonomous levels keep their numeric clearance
 * rank; the two verdict-only labels sort above them (`AUTH-4` below `AUTH-5`) so that a declared
 * requirement can only ever be *raised* by a stricter one.
 *
 * This is deliberately NOT a clearance table: a value from it must never be compared against a
 * grant, and no grant can ever be produced from it.
 *
 * @param level - Requirement label.
 * @returns `0`..`3` for the autonomous levels, `4` for `AUTH-4`, `5` for `AUTH-5`.
 */
export function requirementOrder(level: AuthorityLevel): number {
  return isAssignableAuthority(level) ? AUTHORITY_RANK[level] : level === 'AUTH-4' ? 4 : 5;
}

/**
 * Picks the stricter of two requirements. Used to fold a proposal's self-declared requirement into
 * the registry's, where a declared value may only restrict the action further: an LLM or a customer
 * payload can never lower a requirement (BR-008, BR-009), and a self-declared `AUTH-5` is honoured
 * as a hard deny instead of being silently dropped.
 *
 * @param registryRequirement - Requirement read from the server registry.
 * @param declaredRequirement - Requirement the proposal declares for itself.
 * @returns The stricter of the two.
 */
export function strictestRequirement(
  registryRequirement: AuthorityLevel,
  declaredRequirement: AuthorityLevel,
): AuthorityLevel {
  return requirementOrder(registryRequirement) >= requirementOrder(declaredRequirement)
    ? registryRequirement
    : declaredRequirement;
}

/**
 * Evaluates the authority gate (implement/04 §3.2.1, §08 §7.2). Order is the safety property:
 * grant validity, then `AUTH-5` deny, then the `AUTH-4` route, then the requirement's validity, and
 * only then the numeric rank comparison of two assignable clearances.
 *
 * @param granted - Clearance presented by the run; typed `unknown` on purpose, because the value
 *   reaches the gate from a registry row and a corrupt grant must be refused, not assumed.
 * @param required - Requirement resolved from the server registry (or from a stricter declared
 *   requirement); typed `unknown` for the same reason.
 * @returns The verdict plus the code and the comparison fact.
 */
export function evaluateAuthorityVerdict(granted: unknown, required: unknown): AuthorityDecision {
  if (!isAssignableAuthority(granted)) {
    const absent = granted === undefined || granted === null || granted === '';

    return {
      verdict: 'DENIED',
      granted: null,
      required: isAuthorityLevel(required) ? required : null,
      errorCode: absent ? 'CLEARANCE_REQUIRED' : 'INVALID_CLEARANCE',
      reason: absent
        ? 'CLEARANCE_REQUIRED: no assigned authority was presented, and an absent grant is not "no '
          + 'requirement" (BR-008, NFR-008).'
        : `INVALID_CLEARANCE: '${String(granted)}' is not one of the assignable clearances `
          + 'AUTH-0..AUTH-3; only an assignable grant takes part in a rank comparison (BR-008).',
      rankCompared: false,
    };
  }

  if (!isAuthorityLevel(required)) {
    return {
      verdict: 'DENIED',
      granted,
      required: null,
      errorCode: 'INVALID_AUTHORITY_REQUIREMENT',
      reason: required === undefined || required === null || required === ''
        ? 'INVALID_AUTHORITY_REQUIREMENT: the skill carries no required authority; a missing '
          + 'requirement cannot authorize dispatch (BR-008, NFR-008).'
        : `INVALID_AUTHORITY_REQUIREMENT: '${String(required)}' is outside the AUTH-0..AUTH-5 `
          + 'vocabulary (BR-008).',
      rankCompared: false,
    };
  }

  if (required === 'AUTH-5') {
    return {
      verdict: 'DENIED',
      granted,
      required,
      errorCode: 'PROHIBITED_ACTION',
      reason: 'PROHIBITED_ACTION: AUTH-5 is a terminal hard deny. It is never queued, never '
        + 'approvable and never reachable by accumulating rank (SRS §12, BR-008).',
      rankCompared: false,
    };
  }

  if (required === 'AUTH-4') {
    return {
      verdict: 'AWAITING_HUMAN_APPROVAL',
      granted,
      required,
      errorCode: null,
      reason: 'APPROVAL_REQUIRED: AUTH-4 is an approval route, not a rank; one prepared action '
        + 'awaits a bound human decision and is not executed autonomously (BR-007).',
      rankCompared: false,
    };
  }

  if (AUTHORITY_RANK[granted] < AUTHORITY_RANK[required]) {
    return {
      verdict: 'DENIED',
      granted,
      required,
      errorCode: 'INSUFFICIENT_AUTHORITY',
      reason: `INSUFFICIENT_AUTHORITY: the skill requires ${required} and the run is granted `
        + `${granted} (BR-008).`,
      rankCompared: true,
    };
  }

  return {
    verdict: 'AUTO_APPROVED',
    granted,
    required,
    errorCode: null,
    reason: `AUTHORIZED: ${granted} covers ${required}.`,
    rankCompared: true,
  };
}
