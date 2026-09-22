/**
 * @file Stable, fail-closed refusals of the skill layer (implement/05 §2, §6.3, §6.5, §8).
 *
 * Every code below is the terminal answer to a question the skill layer could not answer safely.
 * None of them is retryable by itself, none of them is a default, and none of them is ever
 * replaced by a fallback: an unanswerable question refuses the invocation instead of guessing
 * (NFR-008). Codes named by `implement/05` §6.5/§8 keep their exact spelling so a caller, an
 * audit record and a test expectation cannot drift apart.
 */

/** The skill-layer refusal vocabulary. */
export type SkillErrorCode =
  // --- registration (§2 `assertRegistrable`, §6.1) ------------------------------------------
  /** A row for this `skill_id` is already registered; the registry is keyed by immutable id. */
  | 'SKILL_ALREADY_REGISTERED'
  /** A row declares no authorized agent, so no caller could ever be admitted. */
  | 'MISSING_ALLOWED_AGENTS'
  /** A row requires `AUTH-5`, the terminal deny verdict, which is never a valid requirement. */
  | 'PROHIBITED_AUTHORITY_REQUIREMENT'
  /** A row omits one or more of the five mandatory `TC-SKILL-01..05` baseline cases. */
  | 'MISSING_BASELINE_TEST_CASES'
  /** A row declares a schema using keywords the deterministic validator cannot enforce. */
  | 'INVALID_SCHEMA'
  /** A row is malformed in a way not covered by a more specific code (missing id, timed out at 0). */
  | 'INVALID_SKILL_CONTRACT'

  // --- dispatch admission (§6.3, §8.1) --------------------------------------------------------
  /** The `skill_id` is absent from the registry: `UNKNOWN_SKILL`, never a declared fallback. */
  | 'SKILL_NOT_FOUND'
  /** The row exists but is not enabled for this gate/tenant (§7 enablement flag). */
  | 'SKILL_DISABLED'
  /** The invocation did not arrive from the Revenue Orchestrator, which owns all skill execution. */
  | 'UNBROKERED_INVOCATION'
  /** A server-resolved dispatch field (`run_id`, `tenant_id`, `correlation_id`, request identity). */
  | 'MISSING_DISPATCH_CONTEXT'
  /** The caller agent is not in the row's `allowed_agents` (BR-008), evaluated before rank. */
  | 'UNAUTHORIZED_AGENT'
  /** No grant was presented at all; absence is not "no requirement" (BR-008). */
  | 'CLEARANCE_REQUIRED'
  /** The presented grant is absent or outside the assignable `AUTH-0..AUTH-3` set (BR-008). */
  | 'INVALID_CLEARANCE'
  /** The row's `required_authority` is outside the `AUTH-0..AUTH-5` vocabulary (BR-008). */
  | 'INVALID_AUTHORITY_REQUIREMENT'
  /** A valid grant below a valid autonomous requirement (BR-008). */
  | 'INSUFFICIENT_AUTHORITY'
  /** `AUTH-5`: prohibited. Never queued, never approvable, no `approvals` row created. */
  | 'PROHIBITED_ACTION'
  /** `AUTH-4` without a bound one-time approval for this exact action (BR-007). */
  | 'APPROVAL_REQUIRED'
  /** `AUTH-4` routed to the human gate: the action is prepared, not executed. */
  | 'REQUIRE_HUMAN_APPROVAL'
  /** The approval covers a different payload digest; the action needs a new authorization. */
  | 'APPROVAL_PAYLOAD_MISMATCH'

  // --- payload and effect identity (§3, §6.3, §6.5) -------------------------------------------
  /** The input failed the row's `input_schema`; zero adapter calls are made. */
  | 'SCHEMA_VALIDATION_ERROR'
  /** The adapter response failed the row's `output_schema`; the result is not a success. */
  | 'OUTPUT_SCHEMA_VALIDATION_ERROR'
  /** An effect-bearing row was dispatched without the immutable identity an effect key needs. */
  | 'EFFECT_KEY_REQUIRED'
  /** A presented `effect_key` is not the canonical BR-005 derivation of this dispatch identity. */
  | 'EFFECT_KEY_NOT_DETERMINISTIC'

  // --- execution resilience (§6.5, §8) --------------------------------------------------------
  /** The guarded dependency is `OPEN`; the call is refused before any adapter call. */
  | 'CIRCUIT_BREAKER_OPEN'
  /** The attempt exceeded `timeout_ms`; classified by the row's `retry_policy`. */
  | 'TIMEOUT'
  /** An attempt with an unconfirmed external outcome: reconcile by `effect_key`, never re-send. */
  | 'EFFECT_UNKNOWN'
  /** A `FATAL` attempt, or an exhausted retry budget, on a confirmed-effect-free class. */
  | 'SKILL_EXECUTION_FAILED';

/**
 * A skill-layer refusal carrying its stable code.
 *
 * The code — not the message — is the contract: callers, audit records and tests branch on it, so
 * the message stays explanatory and may change without renegotiating behaviour.
 */
export class SkillError extends Error {
  /** Stable refusal code of the skill layer. */
  public readonly code: SkillErrorCode;

  /** The skill the refusal belongs to, when the refusal is bound to one row. */
  public readonly skill_id: string | undefined;

  /**
   * Builds a refusal.
   *
   * @param code Stable refusal code.
   * @param message Explanatory text; carries no contract.
   * @param skill_id The row the refusal belongs to, when known.
   */
  public constructor(code: SkillErrorCode, message: string, skill_id?: string) {
    super(skill_id === undefined ? `${code}: ${message}` : `${code} [${skill_id}]: ${message}`);
    this.name = 'SkillError';
    this.code = code;
    this.skill_id = skill_id;
  }
}

/**
 * Reports whether a value is a `SkillError` raised by this layer.
 *
 * @param error Value to inspect.
 * @returns `true` for a `SkillError`, including one re-created across a module boundary.
 */
export function isSkillError(error: unknown): error is SkillError {
  return error instanceof SkillError;
}
