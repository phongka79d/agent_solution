/**
 * @file Skill System Contract (implement/05 §2, §3, §6.1, §6.5): the eleven SRS-minimum fields
 * every skill row carries, its effect-behaviour class, and the server-resolved execution context
 * the Revenue Orchestrator hands to one invocation.
 *
 * Dispatch envelopes and the canonical primitive seams live in `dispatch.ts` and `seams.ts`.
 * Declarations only: this module registers nothing, validates nothing and executes nothing.
 */

import type { AssignableAuthority, AuthorityLevel } from '@agentos/core-engine/contracts';

/**
 * Every label of the SRS §12 authority vocabulary, in ascending order of restriction.
 *
 * Serialization of the skill layer's authority requirement is owned here (implement/README §7), and
 * the lint DAG admits only the `contracts` subpath of the core engine, where no such predicate is
 * published. Re-declaring the six frozen labels is therefore the seam-respecting way to refuse an
 * unknown one. The verdict is never re-implemented: it arrives through the `evaluateAuthority` seam
 * and is consumed, not recomputed.
 */
export const AUTHORITY_LEVELS: readonly AuthorityLevel[] = Object.freeze([
  'AUTH-0',
  'AUTH-1',
  'AUTH-2',
  'AUTH-3',
  'AUTH-4',
  'AUTH-5',
]);

/**
 * Reports whether a value is a label of the `AUTH-0..AUTH-5` vocabulary.
 *
 * @param value The value to check; it is treated as `unknown` on purpose, so a corrupt contract
 *   field is refused rather than trusted for being well-typed.
 * @returns `true` only for one of the six frozen labels.
 */
export function isAuthorityLevel(value: unknown): value is AuthorityLevel {
  return typeof value === 'string' && AUTHORITY_LEVELS.some((level) => level === value);
}

export interface RetryPolicy {
  readonly max_retries: number;
  readonly initial_interval_ms: number;
  readonly backoff_multiplier: number;
  /**
   * Resilience consent for a **timed-out** attempt. `true` is admissible only for a skill whose
   * adapter call cannot have produced an external effect (read-only/derived output), where the
   * first attempt is provably effect-free and an in-loop retry is therefore safe. Every
   * effect-bearing skill declares `false`: a timeout leaves the outcome unknown, so the engine
   * reports `EFFECT_UNKNOWN` and the orchestrator reconciles by `effect_key` before anything is
   * retried (§04 §4.4).
   */
  readonly retry_on_timeout: boolean;
  readonly non_retryable_errors: readonly string[];
}

/**
 * Failure classification for one failed attempt, canonical with §04 §3.2.4 (`RetryClass`).
 * `UNKNOWN` is a reconciliation state, never a settlement: the effect reservation stays RESERVED
 * until the provider outcome is proven.
 */
export type RetryClass = 'RETRYABLE' | 'FATAL' | 'UNKNOWN';

/** The five mandatory baseline cases every registered skill carries (§5). */
export const BASELINE_TEST_CASE_IDS: readonly string[] = Object.freeze([
  'TC-SKILL-01',
  'TC-SKILL-02',
  'TC-SKILL-03',
  'TC-SKILL-04',
  'TC-SKILL-05',
]);

/**
 * The 13 canonical platform agents of §6.2. `allowed_agents` is drawn from this list only, so a
 * registry row can never authorize a caller that is not a server-registered agent (BR-008).
 * `HUMAN_HANDOFF` is a routing destination, not an agent, and is therefore absent.
 */
export const CANONICAL_AGENT_IDS: readonly string[] = Object.freeze([
  'MKT-01',
  'MKT-02',
  'MKT-03',
  'MKT-04',
  'MKT-05',
  'MKT-06',
  'SAL-01',
  'SAL-02',
  'SAL-03',
  'SAL-04',
  'SAL-05',
  'CS-01',
  'CS-02',
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
  readonly mask_pii_fields: readonly string[];
  readonly evidence_card: string;
  readonly record_latency: boolean;
}

export type TestCaseCategory =
  | 'HAPPY_PATH' // TC-SKILL-01
  | 'AUTHORITY' // TC-SKILL-02
  | 'SCHEMA_INVALIDATION' // TC-SKILL-03
  | 'TIMEOUT' // TC-SKILL-04
  | 'IDEMPOTENCY' // TC-SKILL-05
  | 'VALIDATION' // skill-specific business rule
  | 'BOUNDARY' // skill-specific boundary value
  | 'SECURITY' // skill-specific isolation / injection / leakage
  | 'RESILIENCE'; // skill-specific dependency failure

/**
 * One registry test case (SRS §11 minima, field 11). The five baseline cases of §5 are
 * instantiated once per skill, so a registered skill always carries the baseline IDs plus at
 * least one skill-specific case, and a registration with no baseline case is refused by
 * `MISSING_BASELINE_TEST_CASES` (§3.1, §6.1).
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

/**
 * Effect behaviour of a row (implement/05 §6.5). The class describes what the row can do to the
 * world, not what clearance it needs:
 *
 *   * `READ`     — no external effect and no durable platform mutation;
 *   * `INTERNAL` — writes platform-owned records only;
 *   * `EFFECT`   — produces an external side effect in a System of Record or a provider;
 *   * `APPROVAL` — an `AUTH-4` row whose effect exists only after the human decision.
 *
 * `EFFECT` and `APPROVAL` are the effect-bearing classes: they require a deterministic
 * `effect_key`, and a timeout never becomes a blind resend.
 */
export type SkillEffectClass = 'READ' | 'INTERNAL' | 'EFFECT' | 'APPROVAL';

export interface ISkillContract<TInput = unknown, TOutput = unknown> {
  readonly skill_id: string;
  readonly purpose: string;
  /** Effect behaviour of this row (§6.5); decides whether an `effect_key` is mandatory. */
  readonly effect_class: SkillEffectClass;
  /**
   * Circuit-breaker key of the dependency this row guards (§6.5). Two rows over the same provider
   * share one breaker; an `OPEN` breaker refuses with `CIRCUIT_BREAKER_OPEN` before any adapter call.
   */
  readonly guarded_dependency: string;
  readonly input_schema: Record<string, unknown>;
  readonly output_schema: Record<string, unknown>;
  readonly allowed_agents: readonly string[];
  /**
   * Static requirement. `AUTH-0`..`AUTH-3` are rank-compared; `AUTH-4` is the approval route and
   * `AUTH-5` is never a valid requirement because it is the terminal deny verdict.
   */
  readonly required_authority: AuthorityLevel;
  readonly tool_binding: string;
  readonly validation_rules: readonly string[];
  readonly retry_policy: RetryPolicy;
  readonly timeout_ms: number;
  readonly audit_spec: AuditSpec;
  /** SRS §11 minima, field 11. Never empty for a registered skill (§3.1). */
  readonly test_cases: readonly TestCaseSpec[];
  /**
   * Enablement flag stored with the row (§7). A row may be migrated and exercised offline before
   * its gate, but a disabled row refuses dispatch with `SKILL_DISABLED` instead of degrading to an
   * unguarded fallback or a cached value.
   */
  readonly enabled: boolean;
  validateInput(input: unknown): TInput;
  execute(input: TInput, context: ExecutionContext): Promise<TOutput>;
}

/**
 * Server-resolved execution context of one invocation. Every field is bound by the orchestrator —
 * never read back from a payload, a prompt or a model output — and `granted_authority` stays the
 * clearance the run was started with: no approval and no verdict ever raises it (BR-008).
 */
export interface ExecutionContext {
  readonly run_id: string;
  readonly tenant_id: string;
  readonly caller_agent: string;
  readonly correlation_id: string;
  /** Clearance granted to the run. Only `AUTH-0`..`AUTH-3` are assignable grants. */
  readonly granted_authority: AssignableAuthority;
  /**
   * Deterministic identity of this action, derived from the immutable inbound request — never from
   * `run_id`, a retry counter, a timestamp or a random UUID (BR-005). It is the key the durable
   * effect reservation is taken under, and the key a timed-out effect is reconciled by.
   */
  readonly effect_key: string;
  /** Bound only when an `AUTH-4` approval authorizes this exact tenant/run/effect tuple. */
  readonly approval_id?: string;
  /**
   * Digest of the payload the approver authorized (canonical JSON + SHA-256). The approval binds
   * `(tenant_id, run_id, effect_key, payload_digest)`, so a different digest is a different action.
   */
  readonly approval_payload_digest?: string;
  readonly signal?: AbortSignal;
}

/**
 * A registry row before the gate decides its enablement flag. The two callables are re-declared in
 * method form so a heterogeneous registry can hold rows of different input/output types: method
 * signatures stay bivariant, and the engine never relies on that variance for safety — it
 * normalizes every input through `validateInput` and validates every output against `output_schema`.
 */
export type PlatformSkillRow<TInput = unknown, TOutput = unknown> = Omit<
  ISkillContract<TInput, TOutput>,
  'enabled' | 'validateInput' | 'execute'
> & {
  validateInput(input: unknown): TInput;
  execute(input: TInput, context: ExecutionContext): Promise<TOutput>;
};
