/**
 * @file The skill-level authority admission gate (implement/05 §1.2, §2, §6.3).
 *
 * This module owns the *dispatch* order — agent binding, then the canonical verdict — and nothing
 * else: the verdict itself comes from the injected canonical gate, so the ranking rule is never
 * re-implemented here. The order is the safety property: the caller is bound to the row before any
 * clearance is considered, so an unauthorized agent receives `UNAUTHORIZED_AGENT` rather than a
 * verdict or a schema error.
 */

import type { AuthorityVerdict } from '@agentos/core-engine/contracts';

import {
  SkillError,
  type AuthorityDenyCode,
  type AuthorityEvaluator,
  type SkillErrorCode,
} from '../contracts/index.js';

/** The subset of this layer's refusals a canonical denial can map onto. */
type AuthorityRefusalCode = Extract<
  SkillErrorCode,
  | 'CLEARANCE_REQUIRED'
  | 'INVALID_CLEARANCE'
  | 'INVALID_AUTHORITY_REQUIREMENT'
  | 'PROHIBITED_ACTION'
  | 'INSUFFICIENT_AUTHORITY'
>;

/**
 * The canonical gate's refusal vocabulary mapped onto this layer's. The mapping is total: a denial
 * the gate can produce always has a skill-layer code, so a denial is never downgraded to a generic
 * failure or swallowed into a retry.
 */
const DENIAL_CODES: Readonly<Record<AuthorityDenyCode, AuthorityRefusalCode>> = Object.freeze({
  CLEARANCE_REQUIRED: 'CLEARANCE_REQUIRED',
  INVALID_CLEARANCE: 'INVALID_CLEARANCE',
  INVALID_AUTHORITY_REQUIREMENT: 'INVALID_AUTHORITY_REQUIREMENT',
  PROHIBITED_ACTION: 'PROHIBITED_ACTION',
  INSUFFICIENT_AUTHORITY: 'INSUFFICIENT_AUTHORITY',
});

/** Admission outcome of the authority gate. */
export interface AuthorityAdmission {
  /**
   * `AUTO_APPROVED` when the run's clearance covers the row, or `AWAITING_HUMAN_APPROVAL` when the
   * row routes to the human gate — in which case the caller still owes a bound approval.
   */
  readonly verdict: AuthorityVerdict;
}

/**
 * Admits one invocation to the authority gate.
 *
 * @param params The row, the server-resolved caller identity, the run's clearance and the injected
 *   canonical gate. The grant is typed `unknown` on purpose: a verdict-only label arriving as a
 *   grant must be refused, not trusted for being well-typed.
 * @returns The verdict, which is `AUTO_APPROVED` or `AWAITING_HUMAN_APPROVAL`.
 * @throws {SkillError} `UNAUTHORIZED_AGENT`, or the mapped denial code of the canonical gate.
 */
export function enforceAuthorityAdmission(params: {
  readonly skill_id: string;
  readonly allowed_agents: readonly string[];
  readonly required_authority: unknown;
  readonly caller_agent: string;
  readonly granted_authority: unknown;
  readonly evaluateAuthority: AuthorityEvaluator;
}): AuthorityAdmission {
  const { skill_id, allowed_agents, required_authority, caller_agent, granted_authority } = params;

  if (!allowed_agents.includes(caller_agent)) {
    throw new SkillError(
      'UNAUTHORIZED_AGENT',
      `agent ${caller_agent} is not in this row's allowed_agents; the binding is evaluated before any clearance comparison (BR-008)`,
      skill_id,
    );
  }

  const decision = params.evaluateAuthority(granted_authority, required_authority);

  if (decision.verdict === 'DENIED') {
    const code =
      decision.errorCode === null ? 'INVALID_CLEARANCE' : DENIAL_CODES[decision.errorCode];
    throw new SkillError(code, decision.reason, skill_id);
  }

  return { verdict: decision.verdict };
}
