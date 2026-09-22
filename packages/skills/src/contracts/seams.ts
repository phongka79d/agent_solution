/**
 * @file The canonical primitives the skill layer consumes but never re-implements
 * (implement/05 §1.2). The authority gate, the BR-005 effect-key derivation and the payload digest
 * each have exactly one implementation platform-wide, so a guard and the approval row it checks
 * can never disagree about an identity or a verdict.
 *
 * Declarations only: this module holds no implementation of any of the three.
 */

import type { AssignableAuthority, AuthorityLevel, AuthorityVerdict } from '@agentos/core-engine/contracts';

/** Canonical payload digest: RFC 8785 canonical JSON + SHA-256. */
export type PayloadDigestFn = (payload: unknown) => string;

/**
 * The five immutable identity fields of BR-005. `run_id`, a retry counter, a timestamp and a random
 * UUID are deliberately absent: they describe an *attempt*, not the inbound request, so binding them
 * would let a redelivery mint a second external effect.
 */
export interface EffectKeyIdentity {
  readonly tenant_id: string;
  readonly skill_id: string;
  readonly step_index: number;
  readonly action_revision: number;
  readonly request_id: string;
}

/** Canonical effect-key derivation (BR-005); one implementation platform-wide. */
export type EffectKeyFn = (identity: EffectKeyIdentity) => string;

/**
 * Refusal codes of the authority gate, re-declared structurally so this package can type the
 * mapping to its own vocabulary without importing the policy module. The values are the canonical
 * ones; the decision logic itself is never re-implemented here.
 */
export type AuthorityDenyCode =
  | 'CLEARANCE_REQUIRED'
  | 'INVALID_CLEARANCE'
  | 'INVALID_AUTHORITY_REQUIREMENT'
  | 'PROHIBITED_ACTION'
  | 'INSUFFICIENT_AUTHORITY';

/**
 * Outcome of the canonical authority gate, structurally identical to the core-engine decision, so
 * the canonical implementation satisfies this seam without an adapter.
 */
export interface SkillAuthorityDecision {
  readonly verdict: AuthorityVerdict;
  readonly granted: AssignableAuthority | null;
  readonly required: AuthorityLevel | null;
  /** `null` exactly when the verdict is `AUTO_APPROVED` or the gate is an approval route. */
  readonly errorCode: AuthorityDenyCode | null;
  readonly reason: string;
  /** `true` only when the numeric rank comparison actually ran. */
  readonly rankCompared: boolean;
}

/** The canonical authority gate, injected by the composition root. */
export type AuthorityEvaluator = (granted: unknown, required: unknown) => SkillAuthorityDecision;

/**
 * The three canonical primitives of §1.2. All three are required — a runtime that cannot reach
 * them fails to construct instead of silently skipping an authority, identity or digest check.
 */
export interface SkillEngineSeams {
  readonly digestPayload: PayloadDigestFn;
  readonly deriveEffectKey: EffectKeyFn;
  readonly evaluateAuthority: AuthorityEvaluator;
}
