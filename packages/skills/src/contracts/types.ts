/**
 * @file Skill System Contract (implement/05 §2): the eleven SRS-minimum fields every skill row
 * must carry, plus the execution context and retry policy the runtime hands to a skill.
 *
 * Declarations only: no registry rows and no runtime engine.
 */

import type { AssignableAuthority, AuthorityLevel } from '@agentos/core-engine/contracts';

export interface RetryPolicy {
  readonly max_retries: number;
  readonly initial_interval_ms: number;
  readonly backoff_multiplier: number;
  /**
   * Resilience consent for a **timed-out** attempt. `true` is admissible only for a skill whose
   * adapter call cannot have produced an external effect (read-only/derived output), where the
   * first attempt is provably effect-free and an in-loop retry is therefore safe. Every
   * effect-bearing skill declares `false`: a timeout leaves the outcome unknown, so the engine
   * reports `UNKNOWN` and the orchestrator reconciles by `effect_key` before anything is retried
   * (§04 §4.4). This is the field persisted as `skills.retry_policy.retry_on_timeout` (§03 Entity 20).
   */
  readonly retry_on_timeout: boolean;
  readonly non_retryable_errors: string[];
}

/**
 * Failure classification for one failed attempt, canonical with §04 §3.2.4 (`RetryClass`).
 * `UNKNOWN` is a reconciliation state, never a settlement: the effect reservation stays RESERVED
 * until the provider outcome is proven.
 */
export type RetryClass = 'RETRYABLE' | 'FATAL' | 'UNKNOWN';

/** The five mandatory baseline cases every registered skill carries (§3.1, §5). */
export const BASELINE_TEST_CASE_IDS: readonly string[] = Object.freeze([
  'TC-SKILL-01',
  'TC-SKILL-02',
  'TC-SKILL-03',
  'TC-SKILL-04',
  'TC-SKILL-05',
]);

/**
 * Failures whose outcome is unconfirmed even though the deadline did not fire: the request may
 * already have been transmitted and applied, so they are classified exactly like a timeout (§04
 * §3.2.4 `UNKNOWN`) instead of being retried on transport grounds.
 */
export const INDETERMINATE_TRANSPORT_ERRORS: readonly string[] = Object.freeze([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'PROVIDER_INDETERMINATE',
  'UNPARSABLE_PROVIDER_RESPONSE',
]);

export interface AuditSpec {
  readonly log_level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  readonly mask_pii_fields: string[];
  readonly evidence_card: string;
  readonly record_latency: boolean;
}

export type TestCaseCategory =
  | 'HAPPY_PATH'            // TC-SKILL-01
  | 'AUTHORITY'             // TC-SKILL-02
  | 'SCHEMA_INVALIDATION'   // TC-SKILL-03
  | 'TIMEOUT'               // TC-SKILL-04
  | 'IDEMPOTENCY'           // TC-SKILL-05
  | 'VALIDATION'            // skill-specific business rule
  | 'BOUNDARY'              // skill-specific boundary value
  | 'SECURITY'              // skill-specific isolation / injection / leakage
  | 'RESILIENCE';           // skill-specific dependency failure

/**
 * One registry test case (SRS §11 minima, field 11; persisted as `skills.test_cases`, §03 Entity
 * 20). The five baseline cases of §5 are instantiated once per skill, so a registered skill
 * always carries the baseline IDs plus at least one skill-specific case, and a registration with
 * an empty `test_cases` array is rejected by `ck_skills_test_cases`.
 */
export interface TestCaseSpec {
  /** Baseline `TC-SKILL-01`..`TC-SKILL-05`, or `TC-SKILL-<skill number>-<nn>` for a specific case. */
  readonly test_id: string;
  readonly category: TestCaseCategory;
  /** Input/condition under test, stated as the observable setup. */
  readonly scenario: string;
  /** Observable result, including the error code and the absence of side effects where relevant. */
  readonly expected_outcome: string;
  /** `true` for the cases a registration is rejected without (§3.1). */
  readonly required: boolean;
}

export interface ISkillContract<TInput = unknown, TOutput = unknown> {
  readonly skill_id: string;
  readonly purpose: string;
  readonly input_schema: Record<string, unknown>;
  readonly output_schema: Record<string, unknown>;
  readonly allowed_agents: string[];
  /**
   * Static requirement. AUTH-0..AUTH-3 are rank-compared; AUTH-4 is the approval route and
   * AUTH-5 is never a valid requirement because it is the terminal deny verdict.
   */
  readonly required_authority: AuthorityLevel;
  readonly tool_binding: string;
  readonly validation_rules: string[];
  readonly retry_policy: RetryPolicy;
  readonly timeout_ms: number;
  readonly audit_spec: AuditSpec;
  /** SRS §11 minima, field 11. Never empty for a registered skill (§3.1). */
  readonly test_cases: readonly TestCaseSpec[];
  validateInput(input: unknown): TInput;
  execute(input: TInput, context: ExecutionContext): Promise<TOutput>;
}

export interface ExecutionContext {
  readonly run_id: string;
  readonly tenant_id: string;
  readonly caller_agent: string;
  readonly correlation_id: string;
  /** Clearance granted to the run. Only AUTH-0..AUTH-3 are assignable grants. */
  readonly granted_authority: AssignableAuthority;
  /** Deterministic effect key used for idempotency and timeout reconciliation. */
  readonly effect_key: string;
  /** Bound only when an AUTH-4 approval authorizes this exact tenant/run/effect tuple. */
  readonly approval_id?: string;
  /**
   * Digest of the payload the approver authorized (canonical JSON + SHA-256, §08). The approval binds
   * `(tenant_id, run_id, effect_key, payload_digest)`, so a different digest is a different action.
   */
  readonly approval_payload_digest?: string;
  readonly signal?: AbortSignal;
}
