# Skill System and Runtime Specifications

Status: Production Engineering Specification
System Component: Skill Engine Runtime and Platform Skill Registry (Layer 1)
Document Version: 1.0.0
Target Directory: `implement/05-skill-system-specifications.md`

---

## 1. Skill Engine Runtime Architecture

The Skill Engine is the isolated execution runtime responsible for validating, arbitrating, and executing deterministic capabilities ("Skills") on behalf of cognitive agents (`MKT-*`, `SAL-*`, `CS-*`).

### 1.1. Core Invariants and Separation of Concerns
1. **Agent vs. Skill Decoupling**: Agents represent LLM-driven cognitive reasoning entities. Skills represent strictly typed, deterministic operational units. An agent never executes tools directly; it requests skill execution through the Revenue Orchestrator.
2. **Hard Authority Enforcement (BR-008, BR-009, SRS §12)**: LLMs cannot upgrade their own execution authority, and no skill may widen the authority of the run that invoked it. `AUTH-0`..`AUTH-3` are the only **assignable clearances** and the only values that take part in a numeric comparison (`AUTHORITY_RANK[granted] < AUTHORITY_RANK[required]` ⇒ `INSUFFICIENT_AUTHORITY`). `AUTH-4` is not a clearance but a **verdict** — the action is *prepared, not executed*: the orchestrator persists one PENDING approval and pauses for the SCR-003 human gate, and the skill executes only under the `approval_id` that authorizes this exact `(tenant_id, run_id, effect_key)`; an approval never raises an agent's clearance. `AUTH-5` is the **hard deny** verdict — never granted, never required, never queued, never approvable, denied immediately with zero side effects. The whole check is server-side and precedes tool execution (canonical verdict algorithm: §04 §3.2.1).
3. **Idempotency Guarantee (BR-005, NFR-003)**: Every skill whose adapter call can produce an external effect requires a deterministic `effect_key`, reserved durably (`effect_reservations`) before dispatch; an identical key replays the committed receipt instead of repeating the effect.
4. **Resilience & Circuit Protection (NFR-004)**: All skills are bounded by strict timeouts, circuit breakers, and exponential backoff retry loops. A retry is admissible **only when it cannot duplicate an external effect**: read-only skills may be retried under their declared policy, and an effect-bearing skill only after a reconciliation has proven the absence of the effect (§04 §4.4). A timed-out attempt whose effect outcome is unknown is therefore classified `UNKNOWN` and reconciled by `effect_key` — never retried blind.

```
                           [Orchestrator Request]
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │    Skill Dispatcher     │
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │     Authority Guard     │ ◄── Rank AUTH-0..3; AUTH-4 -> SCR-003; AUTH-5 deny; RLS
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │     Input Validator     │ ◄── JSON Schema / Type Guard
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │     Circuit Breaker     │ ◄── CLOSED / OPEN / HALF-OPEN
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │  Timeout / Abort Guard  │ ◄── Hard Deadline Ceiling
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │       Retry Loop        │ ◄── Exp. Backoff + Jitter
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │  Adapter / Tool Exec    │ ◄── API-001, API-002, Adapters
                        └────────────┬────────────┘
                                     │
                                     ▼
                        ┌─────────────────────────┐
                        │   Evidence / Audit Log  │ ◄── SHA-256 Chained Evidence
                        └─────────────────────────┘
```

---

## 2. Skill Runtime Engine Implementation (TypeScript)

Below is the concrete implementation of the Skill Runtime encompassing Dispatcher, Authority Guard, Circuit Breaker, Timeout Controller, and Retry Loop.

```typescript
/**
 * @file skill-engine-runtime.ts
 * @description Production runtime harness for executing platform skills safely.
 */

import { EventEmitter } from 'events';

/**
 * Canonical authority vocabulary (SRS §12). All six labels exist; only the first four are
 * assignable clearances that take part in a numeric comparison. `AUTH-4` ("Approval Required")
 * and `AUTH-5` ("Prohibited") are verdicts, never clearance levels: they are never granted to an
 * agent, never required by a registry row (§03 Entity 20), and never raised by an approval.
 */
export type AuthorityLevel = 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5';

/** The only values an agent grant or a skill requirement may hold (never `AUTH-4` / `AUTH-5`). */
export type AssignableAuthority = 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3';

/**
 * The platform's only clearance ranking. `AUTH-4` and `AUTH-5` are deliberately ABSENT: they are
 * short-circuited by the guard below, so they can never be compared numerically.
 */
export const AUTHORITY_RANK: Readonly<Record<AssignableAuthority, number>> = Object.freeze({
  'AUTH-0': 0, // Observe
  'AUTH-1': 1, // Recommend
  'AUTH-2': 2, // Draft
  'AUTH-3': 3, // Bounded Execute
});

/**
 * Verdict produced by the skill-level authority guard, canonical with §04 §3.2.1
 * (`AuthorityVerdict`) and the 18-field Agent Run record.
 */
export type AuthorityVerdict = 'AUTO_APPROVED' | 'AWAITING_HUMAN_APPROVAL' | 'DENIED';

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
   * Statically bound requirement. `AUTH-0`..`AUTH-3` are rank-compared; `AUTH-4` is the approval
   * route; `AUTH-5` is never a valid requirement (it is the deny verdict, §03 Entity 20 CHECK) and
   * is handled defensively by the guard below as an immediate denial.
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
  /** Clearance granted to the *run*. Never `AUTH-4`/`AUTH-5` — those are verdicts (§04 §3.2.1). */
  readonly granted_authority: AssignableAuthority;
  /**
   * Deterministic effect key (§04 §3.2.3). Mandatory for a skill whose adapter call can produce an
   * external effect, and the only identity under which a timed-out attempt may be reconciled.
   */
  readonly effect_key: string;
  /**
   * Set only on an action resumed through the SCR-003 approvals gate, and only for a skill whose
   * `required_authority` is `AUTH-4`. The approval authorizes one specific
   * `(tenant_id, run_id, effect_key)` execution and never raises a clearance.
   */
  readonly approval_id?: string;
  readonly signal?: AbortSignal;
}

// ============================================================================
// CIRCUIT BREAKER PATTERN
// ============================================================================

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failureCount: number = 0;
  private lastStateChangedAt: number = Date.now();

  constructor(
    private readonly failureThreshold: number = 5,
    private readonly resetTimeoutMs: number = 30000
  ) {}

  public canExecute(): boolean {
    if (this.state === 'OPEN') {
      if (Date.now() - this.lastStateChangedAt > this.resetTimeoutMs) {
        this.state = 'HALF_OPEN';
        this.lastStateChangedAt = Date.now();
        return true;
      }
      return false;
    }
    return true;
  }

  public recordSuccess(): void {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  public recordFailure(): void {
    this.failureCount += 1;
    if (this.failureCount >= this.failureThreshold || this.state === 'HALF_OPEN') {
      this.state = 'OPEN';
      this.lastStateChangedAt = Date.now();
    }
  }

  public getState(): CircuitState {
    return this.state;
  }
}

// ============================================================================
// SKILL RUNTIME DISPATCHER
// ============================================================================

export class SkillRuntimeEngine {
  private readonly registry = new Map<string, ISkillContract>();
  private readonly circuitBreakers = new Map<string, CircuitBreaker>();

  public registerSkill(skill: ISkillContract): void {
    this.assertRegistrable(skill);
    this.registry.set(skill.skill_id, skill);
    this.circuitBreakers.set(skill.skill_id, new CircuitBreaker(5, 30000));
  }

  /**
   * Registration gate for the SRS §11 obligations that must exist before a skill can be invoked.
   * The same obligations are enforced on the persisted row (§03 Entity 20): `required_authority`
   * admits `AUTH-0`..`AUTH-4` but never `AUTH-5`, and `ck_skills_test_cases` rejects an empty
   * `test_cases` array. A skill that declares no required baseline case (§5) is not registrable.
   */
  private assertRegistrable(skill: ISkillContract): void {
    if (this.registry.has(skill.skill_id)) {
      throw new Error(`SKILL_ALREADY_REGISTERED: ${skill.skill_id}`);
    }
    if (skill.allowed_agents.length === 0) {
      throw new Error(`MISSING_ALLOWED_AGENTS: ${skill.skill_id} declares no authorized agent`);
    }
    if (skill.required_authority === 'AUTH-5') {
      throw new Error(
        `PROHIBITED_AUTHORITY_REQUIREMENT: ${skill.skill_id} may not require AUTH-5 (hard deny verdict, SRS §12)`
      );
    }
    const missing = BASELINE_TEST_CASE_IDS.filter(
      (testId) => !skill.test_cases.some((testCase) => testCase.test_id === testId)
    );
    if (skill.test_cases.length === 0 || missing.length > 0) {
      throw new Error(
        `MISSING_BASELINE_TEST_CASES: ${skill.skill_id} must declare the mandatory §5 baseline${missing.length > 0 ? ` (missing ${missing.join(', ')})` : ''}`
      );
    }
  }

  public async executeSkill<TIn, TOut>(
    skillId: string,
    rawInput: unknown,
    context: ExecutionContext
  ): Promise<TOut> {
    const skill = this.registry.get(skillId) as ISkillContract<TIn, TOut> | undefined;
    if (!skill) {
      throw new Error(`SKILL_NOT_FOUND: Skill ${skillId} is not registered`);
    }

    // 1. Authority Guard Check (server side). Returns the canonical verdict; a skill requiring
    // AUTH-4 is admitted only with a bound approval, and AUTH-5 is denied outright.
    this.enforceAuthorityGuard(skill, context);

    // 2. Input Validation
    const validatedInput = skill.validateInput(rawInput);

    // 3. Circuit Breaker Check
    const breaker = this.circuitBreakers.get(skillId)!;
    if (!breaker.canExecute()) {
      throw new Error(`CIRCUIT_BREAKER_OPEN: Skill ${skillId} downstream is unavailable`);
    }

    // 4. Execution with Timeout and Retry Loop
    return this.executeWithRetryAndTimeout(skill, validatedInput, context, breaker);
  }

  private enforceAuthorityGuard(skill: ISkillContract, context: ExecutionContext): AuthorityVerdict {
    // Gate 1 — agent binding. Checked before any clearance comparison.
    if (!skill.allowed_agents.includes(context.caller_agent)) {
      throw new Error(
        `UNAUTHORIZED_AGENT: Agent ${context.caller_agent} not permitted to invoke ${skill.skill_id}`
      );
    }

    const required = skill.required_authority;

    // Gate 2a — AUTH-5 is a verdict, not a level: hard deny, never queued, never approvable. A
    // registry row can never legitimately require it (§03 Entity 20 CHECK); deny defensively.
    if (required === 'AUTH-5') {
      throw new Error(
        `PROHIBITED_ACTION: ${skill.skill_id} requires AUTH-5, which is a hard deny verdict and is never executable (SRS §12, BR-008)`
      );
    }

    // Gate 2b — AUTH-4 is the approval route, NOT a rank. The skill executes only when the
    // orchestrator has already claimed the PENDING approval row and bound it to this exact
    // (tenant_id, run_id, effect_key) execution (§04 §4.2); a clearance is never raised by it.
    if (required === 'AUTH-4') {
      if (!context.approval_id) {
        throw new Error(
          `APPROVAL_REQUIRED: ${skill.skill_id} prepares an action but never executes it without a human approval bound to this run's effect_key; route through the SCR-003 gate (BR-007)`
        );
      }
      return 'AWAITING_HUMAN_APPROVAL';
    }

    // Gate 2c — rank comparison, reachable only for two assignable clearances (AUTH-0..AUTH-3).
    const granted = context.granted_authority;
    if (granted === undefined || AUTHORITY_RANK[granted] === undefined) {
      // Unknown or non-assignable granted value (including AUTH-4/AUTH-5 arriving as a "grant")
      // fails closed; authority is never assumed to be sufficient.
      throw new Error(
        `INVALID_CLEARANCE: '${String(granted)}' is not an assignable authority level`
      );
    }

    if (AUTHORITY_RANK[granted] < AUTHORITY_RANK[required as AssignableAuthority]) {
      throw new Error(
        `INSUFFICIENT_AUTHORITY: Skill requires ${required}, but context has ${granted}`
      );
    }

    return 'AUTO_APPROVED';
  }

  private async executeWithRetryAndTimeout<TIn, TOut>(
    skill: ISkillContract<TIn, TOut>,
    input: TIn,
    context: ExecutionContext,
    breaker: CircuitBreaker
  ): Promise<TOut> {
    const { retry_policy, timeout_ms } = skill;
    let attempt = 0;
    let delay = retry_policy.initial_interval_ms;

    while (attempt <= retry_policy.max_retries) {
      attempt += 1;
      const abortController = new AbortController();
      const timeoutId = setTimeout(() => abortController.abort(), timeout_ms);

      try {
        const enrichedContext: ExecutionContext = {
          ...context,
          signal: abortController.signal,
        };

        const result = await skill.execute(input, enrichedContext);
        clearTimeout(timeoutId);
        breaker.recordSuccess();
        return result;
      } catch (err: any) {
        clearTimeout(timeoutId);

        const isAborted = abortController.signal.aborted;
        const errorCode = isAborted ? 'TIMEOUT' : err.code || err.message || 'UNKNOWN_ERROR';
        const failureClass = this.classifyFailure(skill, errorCode, isAborted, attempt);

        if (failureClass === 'UNKNOWN') {
          // The attempt may have landed at the provider. The skill engine does not get to decide
          // that, and it never re-dispatches: it records the downstream failure and reports the
          // indeterminate outcome so the orchestrator parks the durable task and reconciles by
          // `effect_key` (§04 §4.4). The effect reservation stays RESERVED — never settled here.
          breaker.recordFailure();
          throw new Error(
            `EFFECT_UNKNOWN [${skill.skill_id}]: ${errorCode} on an attempt with an unconfirmed external outcome; reconcile by effect_key before any retry (§04 §4.4)`
          );
        }

        if (failureClass === 'FATAL' || attempt > retry_policy.max_retries) {
          breaker.recordFailure();
          throw new Error(
            `SKILL_EXECUTION_FAILED [${skill.skill_id}]: ${errorCode} after ${attempt} attempts`
          );
        }

        // Full Jitter Exponential Backoff. Reached only for a RETRYABLE class, i.e. an attempt
        // that provably produced no external effect (read-only skill, or provider-answered error).
        const jitter = Math.random() * delay;
        await new Promise((resolve) => setTimeout(resolve, delay + jitter));
        delay *= retry_policy.backoff_multiplier;
      }
    }

    throw new Error(`SKILL_EXECUTION_EXHAUSTED: ${skill.skill_id}`);
  }

  /**
   * Classifies one failed attempt (canonical vocabulary: §04 §3.2.4 `RetryClass`). The order of
   * the questions is the safety property:
   *
   *   1. Is the outcome unconfirmed? A fired deadline or an indeterminate transport failure means
   *      the request may have reached the provider. For a skill that declares
   *      `retry_on_timeout: false` — every skill whose adapter call can produce an external
   *      effect — the class is `UNKNOWN`: the orchestrator reconciles by `effect_key` and
   *      re-dispatches only on a provider-confirmed absence. Never a blind retry.
   *   2. A skill that declares `retry_on_timeout: true` has asserted that its attempts are
   *      effect-free (read-only/derived output), so a timeout is retryable in-loop while the
   *      declared budget lasts.
   *   3. Otherwise the provider answered: a listed non-retryable code or an exhausted budget is
   *      `FATAL`; any other transient code is `RETRYABLE` under the unchanged `effect_key`.
   */
  private classifyFailure(
    skill: ISkillContract,
    errorCode: string,
    isAborted: boolean,
    attempt: number
  ): RetryClass {
    const exhausted = attempt > skill.retry_policy.max_retries;
    const indeterminate =
      isAborted || INDETERMINATE_TRANSPORT_ERRORS.includes(errorCode);

    if (indeterminate) {
      if (!skill.retry_policy.retry_on_timeout) return 'UNKNOWN';
      return exhausted ? 'FATAL' : 'RETRYABLE';
    }

    if (skill.retry_policy.non_retryable_errors.includes(errorCode)) return 'FATAL';
    return exhausted ? 'FATAL' : 'RETRYABLE';
  }
}
```

---

## 3. Standard Skill Contract Structure (SRS §11 Aligned)

Every platform skill conforms strictly to the canonical structure defined in Section 11 of the SRS. The SRS expands `Input / Output` as a single minimum, so the eleven SRS minima are carried here as twelve numbered fields: fields 1–10 are unchanged, **field 11 is Test Cases & Acceptance Criteria** (the SRS `Test Cases` minimum, persisted as `skills.test_cases`, §03 Entity 20) and field 12 is the Audit Spec (the SRS `Audit` minimum, persisted as `skills.audit_spec`).

1. **Skill ID**: Canonical dot-notated identifier (`skill.<domain>.<action>`).
2. **Purpose**: Concrete operational scope, intent, and domain boundaries.
3. **Input Schema**: Strict JSON Schema defining input parameters and required fields (`additionalProperties: false`). Every parameter is either server-derived (e.g. `customer_id`, `session_id`, `effect_key`, resolved by §04 before the skill is called) or a bounded caller argument; a caller-supplied identity, clearance, or verification claim is never accepted as a binding input (BR-003, NFR-008).
4. **Output Schema**: Strict JSON Schema defining the returned execution payload.
5. **Allowed Agents**: Array of specialized agent IDs authorized to invoke this skill. Checked before any clearance comparison; an unlisted agent is `UNAUTHORIZED_AGENT` (§2).
6. **Required Authority**: Statically bound requirement, stored in `skills.required_authority` (§03 Entity 20) and enforced server-side (PEP) before tool execution:
   * `AUTH-0`..`AUTH-3` — an assignable clearance. `AUTHORITY_RANK[granted] < AUTHORITY_RANK[required]` is the only numeric comparison in the platform (§2, §04 §3.2.1).
   * `AUTH-4` — the **approval route**, never a clearance and never rank-compared: the action is *prepared, not executed*. The orchestrator persists one PENDING approval and pauses for the SCR-003 human gate; the skill then runs only under the `approval_id` bound to this run's `(tenant_id, run_id, effect_key)`. An approval authorizes exactly one execution and never raises an agent's clearance.
   * `AUTH-5` — never a valid requirement. It is the **hard deny** verdict: immediate denial, never queued, never approvable, zero side effects.
7. **Tool / Connector Dependencies**: Target adapter (API-001, API-002, API-003, or internal engine).
8. **Validation Rules**: Formal business validation constraints evaluated prior to invocation. Every rule fails closed — a rule that cannot be evaluated refuses the call rather than admitting it.
9. **Retry Policy**: `{max_retries, initial_interval_ms, backoff_multiplier, retry_on_timeout, non_retryable_errors}`. A retry is admissible only when it cannot duplicate an external effect: `retry_on_timeout: true` is declared only by skills whose attempts are effect-free (read-only/derived), while every skill whose adapter call can produce an external effect declares `false` and is reconciled by `effect_key` instead of retried (§2, §04 §4.4).
10. **Timeout**: Execution latency deadline in milliseconds — the runtime's hard `AbortController` ceiling.
11. **Test Cases & Acceptance Criteria**: The skill's `test_cases`: the mandatory five-case baseline `TC-SKILL-01`..`TC-SKILL-05` (§5) instantiated for this skill, plus at least one skill-specific case. A skill is not registrable with an empty or baseline-incomplete `test_cases` (§3.1, `ck_skills_test_cases`, §2 `assertRegistrable`).
12. **Audit Spec**: `{log_level, mask_pii_fields, evidence_card, record_latency}` — the audit and evidence obligation (SRS `Audit` minimum).

### 3.1. Per-Skill Test Contract (all 23 skills)

Every skill specified in §4 must provide, before registration, a non-empty `test_cases` array — one entry per case, in the `TestCaseSpec` shape (§2):

```json
{
  "test_id": "TC-SKILL-17-06",
  "category": "SECURITY",
  "scenario": "A caller asserts ownership of another customer's order, or supplies no verified identity binding.",
  "expected_outcome": "IDENTITY_UNVERIFIED / ORDER_OWNER_MISMATCH before any OrderConnector call; zero order FACTs released.",
  "required": true
}
```

1. **Baseline (mandatory, `required: true`)**: `TC-SKILL-01` Happy Path, `TC-SKILL-02` Authority, `TC-SKILL-03` Schema Invalidation, `TC-SKILL-04` Timeout classification, `TC-SKILL-05` Idempotency (§5). The five cases are instantiated per skill — the skill's own input schema, authority requirement, timeout, and effect class — so a read-only skill's `TC-SKILL-05` asserts that the repeat call produces no external effect and no divergent payload, while an effect-bearing skill's asserts a single provider effect.
2. **Skill-specific (mandatory, ≥ 1)**: cases identified as `TC-SKILL-<skill number>-<nn>` with `nn ≥ 06`, covering the skill's own boundary values, business-rule refusals, isolation guarantees, and dependency failures. Each skill's field 11 lists them.
3. **Enforcement**: `skills.test_cases` (§03 Entity 20) rejects an empty array, and `SkillRuntimeEngine.assertRegistrable` (§2) refuses a contract that omits any baseline id. Neither the registry nor the runtime can execute a skill with no test contract.
4. **Registry invariant (all 23 named skills)**: the platform registry MUST contain exactly the 23 skills of §4 — `skill.mkt.analyze_market_signal`, `skill.mkt.segment_audience`, `skill.mkt.check_consent`, `skill.mkt.generate_content`, `skill.mkt.audit_brand_compliance`, `skill.mkt.dispatch_campaign`, `skill.mkt.evaluate_attribution`, `skill.sales.search_product`, `skill.sales.check_stock`, `skill.sales.check_price`, `skill.sales.retrieve_customer`, `skill.sales.recommend_product`, `skill.sales.create_cart`, `skill.sales.create_order`, `skill.sales.send_message`, `skill.care.search_faq`, `skill.care.lookup_order`, `skill.care.track_shipping`, `skill.care.manage_case`, `skill.care.initiate_return`, `skill.care.escalate_to_human`, `skill.care.analyze_churn_risk`, `skill.care.issue_retention_offer` — and each MUST carry a non-empty `test_cases` array containing `TC-SKILL-01`..`TC-SKILL-05` plus at least one skill-specific case (`nn ≥ 06`). A registry that omits any of the 23, or that admits one of them with an empty or baseline-incomplete `test_cases`, is non-conformant: `assertRegistrable` (§2) refuses the contract and `ck_skills_test_cases` (§03 Entity 20) rejects the persisted row.

---

## 4. Complete Specifications for All 23 Platform Skills

---

### 4.1. Marketing Domain Skills (7 Skills)

#### Skill 1: `skill.mkt.analyze_market_signal`
- **1. Skill ID**: `skill.mkt.analyze_market_signal`
- **2. Purpose**: Analyzes external digital trends, competitor catalog movements, and search velocity to derive market signals.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "market_region", "category_id", "observation_window_days"],
  "properties": {
    "tenant_id": { "type": "string" },
    "market_region": { "type": "string", "enum": ["TW", "GLOBAL_US", "GLOBAL_EU", "VN"] },
    "category_id": { "type": "string" },
    "observation_window_days": { "type": "integer", "minimum": 1, "maximum": 90 }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["signals", "trend_velocity", "analyzed_at"],
  "properties": {
    "signals": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["signal_id", "keyword", "search_volume_growth", "price_pressure_index"],
        "properties": {
          "signal_id": { "type": "string" },
          "keyword": { "type": "string" },
          "search_volume_growth": { "type": "number" },
          "price_pressure_index": { "type": "number" }
        }
      }
    },
    "trend_velocity": { "type": "string", "enum": ["SLOW", "STABLE", "RAPID", "EXPLOSIVE"] },
    "analyzed_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["MKT-01", "MKT-02"]`
- **6. Required Authority**: `AUTH-1`
- **7. Tool Binding**: `API-002.EventIngestion`
- **8. Validation Rules**: `["observation_window_days must be between 1 and 90", "tenant_id must be authorized for specified market_region"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 1000, "backoff_multiplier": 2.0, "retry_on_timeout": true, "non_retryable_errors": ["INVALID_REGION", "CATEGORY_NOT_FOUND"]}`
- **10. Timeout**: `3000ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-01-06` (**BOUNDARY**) — `observation_window_days` = 0 or 91. Expected: `SCHEMA_VALIDATION_ERROR` before any `API-002.EventIngestion` call; no signal and no `trend_velocity` output.
  - `TC-SKILL-01-07` (**SECURITY**) — `market_region` outside the tenant's authorized regions, or a `tenant_id` from another tenant. Expected: `INVALID_REGION` (non-retryable) with zero rows; no cross-tenant signal is released (RLS, NFR-006).
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_MKT_SIGNAL_ANALYSIS", "record_latency": true}`

```typescript
export interface InputMktAnalyzeSignal {
  tenant_id: string;
  market_region: 'TW' | 'GLOBAL_US' | 'GLOBAL_EU' | 'VN';
  category_id: string;
  observation_window_days: number;
}
export interface OutputMktAnalyzeSignal {
  signals: Array<{ signal_id: string; keyword: string; search_volume_growth: number; price_pressure_index: number }>;
  trend_velocity: 'SLOW' | 'STABLE' | 'RAPID' | 'EXPLOSIVE';
  analyzed_at: string;
}
```

---

#### Skill 2: `skill.mkt.segment_audience`
- **1. Skill ID**: `skill.mkt.segment_audience`
- **2. Purpose**: Segments customer cohort by RFM profile, purchase recency, and brand affinity.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "rfm_criteria", "min_days_inactive"],
  "properties": {
    "tenant_id": { "type": "string" },
    "rfm_criteria": { "type": "string", "enum": ["CHAMPIONS", "LOYAL", "POTENTIAL_LOYALIST", "AT_RISK", "HIBERNATING"] },
    "min_days_inactive": { "type": "integer", "minimum": 0 },
    "max_segment_size": { "type": "integer", "default": 5000 }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["segment_id", "matched_customer_count", "customer_ids", "generated_at"],
  "properties": {
    "segment_id": { "type": "string" },
    "matched_customer_count": { "type": "integer" },
    "customer_ids": { "type": "array", "items": { "type": "string" } },
    "generated_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["MKT-02", "MKT-05"]`
- **6. Required Authority**: `AUTH-1`
- **7. Tool Binding**: `PostgreSQL.Customer360Store`
- **8. Validation Rules**: `["max_segment_size cannot exceed 50000", "min_days_inactive must be non-negative"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 1000, "backoff_multiplier": 1.5, "retry_on_timeout": true, "non_retryable_errors": ["QUERY_TIMEOUT", "INVALID_RFM"]}`
- **10. Timeout**: `2500ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-02-06` (**VALIDATION**) — `max_segment_size` = 50001. Expected: Validation failure before the cohort query; no `segment_id` and no `customer_ids` are returned.
  - `TC-SKILL-02-07` (**SECURITY**) — Cohort query whose matching customers belong to another tenant. Expected: RLS returns 0 rows; the audit record masks `customer_ids`; no customer identifier leaves the tenant boundary (NFR-006).
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_ids"], "evidence_card": "EV_MKT_AUDIENCE_SEGMENT", "record_latency": true}`

```typescript
export interface InputMktSegmentAudience {
  tenant_id: string;
  rfm_criteria: 'CHAMPIONS' | 'LOYAL' | 'POTENTIAL_LOYALIST' | 'AT_RISK' | 'HIBERNATING';
  min_days_inactive: number;
  max_segment_size?: number;
}
export interface OutputMktSegmentAudience {
  segment_id: string;
  matched_customer_count: number;
  customer_ids: string[];
  generated_at: string;
}
```

---

#### Skill 3: `skill.mkt.check_consent`
- **1. Skill ID**: `skill.mkt.check_consent`
- **2. Purpose**: Verifies opt-in consent and suppression status for marketing channels (BR-004).
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "customer_id", "channel"],
  "properties": {
    "tenant_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "channel": { "type": "string", "enum": ["LINE", "WHATSAPP", "SMS", "EMAIL", "ZALO", "TIKTOK", "MESSENGER", "INSTAGRAM"] }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["allowed", "consent_timestamp", "suppression_reason"],
  "properties": {
    "allowed": { "type": "boolean" },
    "consent_timestamp": { "type": ["string", "null"], "format": "date-time" },
    "suppression_reason": { "type": ["string", "null"] }
  }
}
```
- **5. Allowed Agents**: `["MKT-02", "MKT-05", "SAL-04"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `API-002.ConsentStore`
- **8. Validation Rules**: `["customer_id must be valid uuid/cuid", "channel must be configured in tenant settings"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 300, "backoff_multiplier": 2.0, "retry_on_timeout": true, "non_retryable_errors": ["CUSTOMER_NOT_FOUND"]}`
- **10. Timeout**: `1000ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-03-06` (**VALIDATION**) — Customer has an active marketing suppression, or no consent row at all. Expected: `allowed = false` with a `suppression_reason`; the downstream outreach skill is refused (BR-004).
  - `TC-SKILL-03-07` (**BOUNDARY**) — `customer_id` unknown to the tenant. Expected: `CUSTOMER_NOT_FOUND` (non-retryable); no consent FACT is released and no default-allow is returned.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_CONSENT_VERIFICATION", "record_latency": true}`

```typescript
export interface InputMktCheckConsent {
  tenant_id: string;
  customer_id: string;
  channel: 'LINE' | 'WHATSAPP' | 'SMS' | 'EMAIL' | 'ZALO' | 'TIKTOK' | 'MESSENGER' | 'INSTAGRAM';
}
export interface OutputMktCheckConsent {
  allowed: boolean;
  consent_timestamp: string | null;
  suppression_reason: string | null;
}
```

---

#### Skill 4: `skill.mkt.generate_content`
- **1. Skill ID**: `skill.mkt.generate_content`
- **2. Purpose**: Generates multi-channel copy tailored to audience segment and campaign goals.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "campaign_theme", "channel", "locale"],
  "properties": {
    "tenant_id": { "type": "string" },
    "campaign_theme": { "type": "string" },
    "channel": { "type": "string", "enum": ["LINE_FLEX", "WHATSAPP_TEMPLATE", "EMAIL_HTML", "SMS_TEXT", "ZALO_ZNS", "TIKTOK_CARD", "MESSENGER_GENERIC", "INSTAGRAM_DIRECT"] },
    "locale": { "type": "string", "enum": ["zh-TW", "en-US", "vi-VN", "ja-JP"] },
    "product_skus": { "type": "array", "items": { "type": "string" } }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["draft_id", "headline", "body_content", "cta_text", "channel_payload"],
  "properties": {
    "draft_id": { "type": "string" },
    "headline": { "type": "string" },
    "body_content": { "type": "string" },
    "cta_text": { "type": "string" },
    "channel_payload": {
      "type": "object",
      "required": ["channel_type"],
      "properties": {
        "channel_type": { "type": "string" },
        "line_flex_container": { "type": "object" },
        "whatsapp_template": {
          "type": "object",
          "properties": {
            "template_name": { "type": "string" },
            "parameters": { "type": "array", "items": { "type": "string" } }
          }
        },
        "zalo_zns_template": {
          "type": "object",
          "properties": {
            "template_id": { "type": "string" },
            "template_data": { "type": "object", "additionalProperties": { "type": "string" } }
          }
        },
        "meta_generic_card": {
          "type": "object",
          "properties": {
            "title": { "type": "string" },
            "subtitle": { "type": "string" },
            "image_url": { "type": "string" },
            "cta_button_url": { "type": "string" }
          }
        }
      }
    }
  }
}
```
- **5. Allowed Agents**: `["MKT-03"]`
- **6. Required Authority**: `AUTH-2`
- **7. Tool Binding**: `Core.LLMContentEngine`
- **8. Validation Rules**: `["campaign_theme must not exceed 250 characters", "locale must be supported"]`
- **9. Retry Policy**: `{"max_retries": 1, "initial_interval_ms": 1000, "backoff_multiplier": 1.0, "retry_on_timeout": true, "non_retryable_errors": ["PROMPT_INJECTION_DETECTED"]}`
- **10. Timeout**: `5000ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-04-06` (**SECURITY**) — `campaign_theme` carrying instruction-override / prompt-injection text. Expected: `PROMPT_INJECTION_DETECTED` (non-retryable, `FATAL`); no `draft_id` and nothing persisted.
  - `TC-SKILL-04-07` (**BOUNDARY**) — `campaign_theme` longer than 250 characters, or an unsupported `locale`. Expected: Validation failure before the LLM call; no draft is generated.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_MKT_CONTENT_DRAFT", "record_latency": true}`

```typescript
export interface ChannelSpecificPayload {
  channel_type: string;
  line_flex_container?: Record<string, unknown>;
  whatsapp_template?: { template_name: string; parameters: string[] };
  zalo_zns_template?: { template_id: string; template_data: Record<string, string> };
  meta_generic_card?: { title: string; subtitle: string; image_url?: string; cta_button_url?: string };
}

export interface InputMktGenerateContent {
  tenant_id: string;
  campaign_theme: string;
  channel: 'LINE_FLEX' | 'WHATSAPP_TEMPLATE' | 'EMAIL_HTML' | 'SMS_TEXT' | 'ZALO_ZNS' | 'TIKTOK_CARD' | 'MESSENGER_GENERIC' | 'INSTAGRAM_DIRECT';
  locale: 'zh-TW' | 'en-US' | 'vi-VN' | 'ja-JP';
  product_skus?: string[];
}
export interface OutputMktGenerateContent {
  draft_id: string;
  headline: string;
  body_content: string;
  cta_text: string;
  channel_payload: ChannelSpecificPayload;
}
```

---

#### Skill 5: `skill.mkt.audit_brand_compliance`
- **1. Skill ID**: `skill.mkt.audit_brand_compliance`
- **2. Purpose**: Evaluates draft copy against prohibited claims, brand tone guidelines, and regulatory constraints.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "draft_text", "channel"],
  "properties": {
    "tenant_id": { "type": "string" },
    "draft_text": { "type": "string" },
    "channel": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["compliant", "violations", "confidence_score"],
  "properties": {
    "compliant": { "type": "boolean" },
    "violations": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["rule_id", "severity", "snippet", "suggestion"],
        "properties": {
          "rule_id": { "type": "string" },
          "severity": { "type": "string", "enum": ["LOW", "MEDIUM", "HIGH", "BLOCKING"] },
          "snippet": { "type": "string" },
          "suggestion": { "type": "string" }
        }
      }
    },
    "confidence_score": { "type": "number", "minimum": 0, "maximum": 1 }
  }
}
```
- **5. Allowed Agents**: `["MKT-04"]`
- **6. Required Authority**: `AUTH-1`
- **7. Tool Binding**: `SecondBrain.BrandGuard`
- **8. Validation Rules**: `["draft_text length must be > 0 and < 10000 chars"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 500, "backoff_multiplier": 1.5, "retry_on_timeout": true, "non_retryable_errors": ["MALFORMED_INPUT"]}`
- **10. Timeout**: `2000ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-05-06` (**VALIDATION**) — Draft text containing a prohibited claim. Expected: `compliant = false` with the matching `BLOCKING` violation; the dispatch step refuses the draft.
  - `TC-SKILL-05-07` (**BOUNDARY**) — `draft_text` empty or >= 10000 characters. Expected: `MALFORMED_INPUT` (non-retryable); `compliant` is never defaulted to true.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_MKT_BRAND_AUDIT", "record_latency": true}`

```typescript
export interface InputMktAuditBrand {
  tenant_id: string;
  draft_text: string;
  channel: string;
}
export interface OutputMktAuditBrand {
  compliant: boolean;
  violations: Array<{ rule_id: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'BLOCKING'; snippet: string; suggestion: string }>;
  confidence_score: number;
}
```

---

#### Skill 6: `skill.mkt.dispatch_campaign`
- **1. Skill ID**: `skill.mkt.dispatch_campaign`
- **2. Purpose**: Dispatches marketing broadcast to authorized segments (Enforces human approval AUTH-4).
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "campaign_id", "segment_id", "channel", "approved_content_id", "approval_signature"],
  "properties": {
    "tenant_id": { "type": "string" },
    "campaign_id": { "type": "string" },
    "segment_id": { "type": "string" },
    "channel": { "type": "string", "enum": ["LINE", "WHATSAPP", "EMAIL", "SMS", "ZALO", "TIKTOK", "MESSENGER", "INSTAGRAM"] },
    "approved_content_id": { "type": "string" },
    "approval_signature": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["dispatch_id", "recipient_count", "status", "dispatched_at"],
  "properties": {
    "dispatch_id": { "type": "string" },
    "recipient_count": { "type": "integer" },
    "status": { "type": "string", "enum": ["ENQUEUED", "PROCESSING", "COMPLETED", "FAILED"] },
    "dispatched_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["MKT-05"]`
- **6. Required Authority**: `AUTH-4` (approval route — prepared, not executed: the run pauses at the SCR-003 human gate and this skill may run only under the `approval_id` bound to its own `(tenant_id, run_id, effect_key)`; never rank-compared, never a clearance)
- **7. Tool Binding**: `API-003.CommunicationConnector`
- **8. Validation Rules**: `["approval_signature must be verified against the approvals gate (SCR-003): the approval must exist, be bound to this run's effect_key, and authorize exactly one dispatch (BR-007)", "an approval is never treated as a clearance grant and never raises the caller's authority", "channel quota must be available"]`
- **9. Retry Policy**: `{"max_retries": 0, "initial_interval_ms": 0, "backoff_multiplier": 1.0, "retry_on_timeout": false, "non_retryable_errors": ["AUTH_DENIED", "CAMPAIGN_ALREADY_SENT"]}`
- **10. Timeout**: `5000ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-06-06` (**AUTHORITY**) — Invocation with no bound `approval_id`, an unverifiable `approval_signature`, or an approval bound to a different `effect_key`. Expected: `APPROVAL_REQUIRED`: exactly one PENDING approval row exists for the run and zero recipients are contacted; no rank comparison takes place.
  - `TC-SKILL-06-07` (**IDEMPOTENCY**) — The same campaign/segment dispatch is submitted twice. Expected: `CAMPAIGN_ALREADY_SENT` (non-retryable, `max_retries: 0`); the recipient count is unchanged by the second call.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_CAMPAIGN_DISPATCH", "record_latency": true}`

```typescript
export interface InputMktDispatchCampaign {
  tenant_id: string;
  campaign_id: string;
  segment_id: string;
  channel: 'LINE' | 'WHATSAPP' | 'EMAIL' | 'SMS' | 'ZALO' | 'TIKTOK' | 'MESSENGER' | 'INSTAGRAM';
  approved_content_id: string;
  approval_signature: string;
}
export interface OutputMktDispatchCampaign {
  dispatch_id: string;
  recipient_count: number;
  status: 'ENQUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  dispatched_at: string;
}
```

---

#### Skill 7: `skill.mkt.evaluate_attribution`
- **1. Skill ID**: `skill.mkt.evaluate_attribution`
- **2. Purpose**: Calculates campaign conversion attribution, CAC, and ROAS.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "campaign_id", "attribution_model"],
  "properties": {
    "tenant_id": { "type": "string" },
    "campaign_id": { "type": "string" },
    "attribution_model": { "type": "string", "enum": ["FIRST_TOUCH", "LAST_TOUCH", "LINEAR", "DATA_DRIVEN"] }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["campaign_id", "attributed_revenue", "attributed_orders", "roas", "calculated_at"],
  "properties": {
    "campaign_id": { "type": "string" },
    "attributed_revenue": { "type": "number" },
    "attributed_orders": { "type": "integer" },
    "roas": { "type": "number" },
    "cac": { "type": "number" },
    "calculated_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["MKT-06"]`
- **6. Required Authority**: `AUTH-1`
- **7. Tool Binding**: `PostgreSQL.AnalyticsStore`
- **8. Validation Rules**: `["campaign_id must exist in campaigns table"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 1000, "backoff_multiplier": 1.5, "retry_on_timeout": true, "non_retryable_errors": ["CAMPAIGN_NOT_FOUND"]}`
- **10. Timeout**: `4000ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-07-06` (**VALIDATION**) — `campaign_id` unknown to the tenant. Expected: `CAMPAIGN_NOT_FOUND` (non-retryable); no attribution figures are returned.
  - `TC-SKILL-07-07` (**BOUNDARY**) — `attribution_model` outside the declared enum. Expected: `SCHEMA_VALIDATION_ERROR` before the analytics query; no partial metrics.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_MKT_ATTRIBUTION", "record_latency": true}`

```typescript
export interface InputMktEvaluateAttribution {
  tenant_id: string;
  campaign_id: string;
  attribution_model: 'FIRST_TOUCH' | 'LAST_TOUCH' | 'LINEAR' | 'DATA_DRIVEN';
}
export interface OutputMktEvaluateAttribution {
  campaign_id: string;
  attributed_revenue: number;
  attributed_orders: number;
  roas: number;
  cac?: number;
  calculated_at: string;
}
```

---

### 4.2. Sales Domain Skills (8 Skills)

#### Skill 8: `skill.sales.search_product`
- **1. Skill ID**: `skill.sales.search_product`
- **2. Purpose**: Performs catalog keyword, category, or semantic vector search for products.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "query"],
  "properties": {
    "tenant_id": { "type": "string" },
    "query": { "type": "string", "minLength": 1 },
    "category_id": { "type": "string" },
    "limit": { "type": "integer", "default": 5, "maximum": 20 }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["products", "total_found"],
  "properties": {
    "products": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["product_id", "sku", "name", "list_price", "currency", "in_stock"],
        "properties": {
          "product_id": { "type": "string" },
          "sku": { "type": "string" },
          "name": { "type": "string" },
          "list_price": { "type": "number" },
          "currency": { "type": "string" },
          "in_stock": { "type": "boolean" }
        }
      }
    },
    "total_found": { "type": "integer" }
  }
}
```
- **5. Allowed Agents**: `["SAL-01", "SAL-02"]`
- **6. Required Authority**: `AUTH-0`
- **7. Tool Binding**: `API-001.CatalogConnector`
- **8. Validation Rules**: `["query must not contain SQL or prompt injection tokens", "limit <= 20"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 300, "backoff_multiplier": 1.5, "retry_on_timeout": true, "non_retryable_errors": ["MALFORMED_QUERY"]}`
- **10. Timeout**: `1500ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-08-06` (**SECURITY**) — `query` containing SQL or prompt-injection tokens. Expected: `MALFORMED_QUERY` (non-retryable); the catalog adapter is never called.
  - `TC-SKILL-08-07` (**BOUNDARY**) — `limit` = 21, or `limit` omitted. Expected: `limit` 21 is rejected; an omitted `limit` defaults to 5 and never exceeds 20.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_CATALOG_SEARCH", "record_latency": true}`

```typescript
export interface InputSalesSearchProduct {
  tenant_id: string;
  query: string;
  category_id?: string;
  limit?: number;
}
export interface OutputSalesSearchProduct {
  products: Array<{ product_id: string; sku: string; name: string; list_price: number; currency: string; in_stock: boolean }>;
  total_found: number;
}
```

---

#### Skill 9: `skill.sales.check_stock`
- **1. Skill ID**: `skill.sales.check_stock`
- **2. Purpose**: Retrieves real-time available-to-promise inventory across warehouses.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "sku_id"],
  "properties": {
    "tenant_id": { "type": "string" },
    "sku_id": { "type": "string" },
    "warehouse_id": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["sku_id", "available_quantity", "in_stock", "checked_at"],
  "properties": {
    "sku_id": { "type": "string" },
    "available_quantity": { "type": "integer", "minimum": 0 },
    "in_stock": { "type": "boolean" },
    "lead_time_days": { "type": "integer" },
    "checked_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["SAL-01", "SAL-02", "CS-01"]`
- **6. Required Authority**: `AUTH-0` (Observe — inventory lookup is read-only; no external mutation)
- **7. Tool Binding**: `API-001.InventoryConnector`
- **8. Validation Rules**: `["sku_id must exist in active catalog", "fail closed if WMS offline"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 500, "backoff_multiplier": 1.5, "retry_on_timeout": true, "non_retryable_errors": ["SKU_NOT_FOUND"]}`
- **10. Timeout**: `3000ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-09-06` (**RESILIENCE**) — WMS/inventory adapter unreachable. Expected: Fail closed with no `in_stock` claim; a stale cached quantity is never served as a FACT (`fail closed if WMS offline`).
  - `TC-SKILL-09-07` (**BOUNDARY**) — `sku_id` absent from the active catalog. Expected: `SKU_NOT_FOUND` (non-retryable); no availability of 0 is fabricated.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_INVENTORY_CHECK", "record_latency": true}`

```typescript
export interface InputSalesCheckStock {
  tenant_id: string;
  sku_id: string;
  warehouse_id?: string;
}
export interface OutputSalesCheckStock {
  sku_id: string;
  available_quantity: number;
  in_stock: boolean;
  lead_time_days?: number;
  checked_at: string;
}
```

---

#### Skill 10: `skill.sales.check_price`
- **1. Skill ID**: `skill.sales.check_price`
- **2. Purpose**: Evaluates official list price, eligible tier discounts, and enforces mathematical floor price $P_{floor}$ (BR-001, BR-002).
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "sku_id", "customer_id"],
  "properties": {
    "tenant_id": { "type": "string" },
    "sku_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "requested_discount_percent": { "type": "number", "minimum": 0, "maximum": 50 }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["sku_id", "list_price", "final_price", "p_floor", "discount_allowed", "currency", "quote_token", "quote_expires_at"],
  "properties": {
    "sku_id": { "type": "string" },
    "list_price": { "type": "number" },
    "final_price": { "type": "number" },
    "p_floor": { "type": "number" },
    "discount_allowed": { "type": "boolean" },
    "currency": { "type": "string" },
    "quote_token": { "type": "string" },
    "quote_expires_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["SAL-02", "SAL-04"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `API-001.PricingEngine`
- **8. Validation Rules**: `["final_price >= p_floor invariant must hold 100%", "customer tier must be validated", "quote_token must be HMAC-SHA256 signed with secret"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 400, "backoff_multiplier": 1.5, "retry_on_timeout": true, "non_retryable_errors": ["INVALID_SKU"]}`
- **10. Timeout**: `2000ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-10-06` (**VALIDATION**) — `requested_discount_percent` that would push `final_price` below `p_floor`. Expected: `final_price >= p_floor` holds in every response: the floor-breach attempt yields `discount_allowed = false`, never a discounted price (BR-001, BR-002).
  - `TC-SKILL-10-07` (**SECURITY**) — `quote_token` tampered with, or signed under another tenant's secret. Expected: Signature verification fails and the quote is refused; the order step never accepts the token.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_PRICE_CALCULATION", "record_latency": true}`

```typescript
export interface InputSalesCheckPrice {
  tenant_id: string;
  sku_id: string;
  customer_id: string;
  requested_discount_percent?: number;
}
export interface OutputSalesCheckPrice {
  sku_id: string;
  list_price: number;
  final_price: number;
  p_floor: number;
  discount_allowed: boolean;
  currency: string;
  quote_token: string;
  quote_expires_at: string;
}
```

---

#### Skill 11: `skill.sales.retrieve_customer`
- **1. Skill ID**: `skill.sales.retrieve_customer`
- **2. Purpose**: Hydrates Customer 360 profile, order history, and preferences (AUTH-0 read-only).
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "customer_identifier"],
  "properties": {
    "tenant_id": { "type": "string" },
    "customer_identifier": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["customer_id", "total_orders", "lifetime_value", "verified", "rfm_segment"],
  "properties": {
    "customer_id": { "type": "string" },
    "total_orders": { "type": "integer" },
    "lifetime_value": { "type": "number" },
    "verified": { "type": "boolean" },
    "rfm_segment": { "type": "string" },
    "last_order_date": { "type": ["string", "null"] }
  }
}
```
- **5. Allowed Agents**: `["SAL-01", "SAL-02", "SAL-03", "SAL-04", "SAL-05"]`
- **6. Required Authority**: `AUTH-0`
- **7. Tool Binding**: `PostgreSQL.Customer360Store`
- **8. Validation Rules**: `["tenant isolation boundary verified by RLS"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 300, "backoff_multiplier": 1.5, "retry_on_timeout": true, "non_retryable_errors": ["NOT_FOUND"]}`
- **10. Timeout**: `1500ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-11-06` (**AUTHORITY**) — Run whose identity resolved to `UNRESOLVED`, or whose bound `customer_id` differs from the requested profile. Expected: The call is refused and zero profile rows are released; an anonymous session never receives a Customer 360 FACT (BR-004, NFR-006).
  - `TC-SKILL-11-07` (**SECURITY**) — Read attempted across tenants. Expected: 0 rows by RLS; the response does not disclose whether the other tenant's customer exists.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id", "customer_identifier"], "evidence_card": "EV_CUSTOMER_HYDRATION", "record_latency": true}`

```typescript
export interface InputSalesRetrieveCustomer {
  tenant_id: string;
  customer_identifier: string;
}
export interface OutputSalesRetrieveCustomer {
  customer_id: string;
  total_orders: number;
  lifetime_value: number;
  verified: boolean;
  rfm_segment: string;
  last_order_date: string | null;
}
```

---

#### Skill 12: `skill.sales.recommend_product`
- **1. Skill ID**: `skill.sales.recommend_product`
- **2. Purpose**: Generates cross-sell/upsell/substitute/bundle suggestions conforming strictly to the 7-field contract of FR-SAL-003.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "customer_id", "current_cart_skus"],
  "properties": {
    "tenant_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "current_cart_skus": { "type": "array", "items": { "type": "string" } },
    "recommendation_type": { "type": "string", "enum": ["CROSS_SELL", "UPSELL", "SUBSTITUTE", "BUNDLE", "REPLENISHMENT"], "default": "CROSS_SELL" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**: (Conforms to FR-SAL-003 MUST 7 fields)
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["customer", "product", "reason", "evidence", "eligibility", "confidence", "expected_outcome"],
  "properties": {
    "customer": { "type": "string" },
    "product": {
      "type": "object",
      "required": ["sku", "name", "price"],
      "properties": {
        "sku": { "type": "string" },
        "name": { "type": "string" },
        "price": { "type": "number" }
      }
    },
    "reason": { "type": "string" },
    "evidence": {
      "type": "object",
      "required": ["verified_timeline_event_ids", "verified_model"],
      "properties": {
        "verified_timeline_event_ids": { "type": "array", "items": { "type": "string" } },
        "verified_model": { "type": "string" },
        "historical_spend": { "type": "number" },
        "category_affinity": { "type": "string" }
      }
    },
    "eligibility": {
      "type": "object",
      "required": ["stock_available", "consent_verified", "suppression_cleared"],
      "properties": {
        "stock_available": { "type": "boolean" },
        "consent_verified": { "type": "boolean" },
        "suppression_cleared": { "type": "boolean" }
      }
    },
    "confidence": { "type": "number", "minimum": 0.0, "maximum": 1.0 },
    "expected_outcome": {
      "type": "object",
      "required": ["conversion_probability", "expected_revenue", "currency"],
      "properties": {
        "conversion_probability": { "type": "number" },
        "expected_revenue": { "type": "number" },
        "currency": { "type": "string" }
      }
    }
  }
}
```
- **5. Allowed Agents**: `["SAL-02", "SAL-03"]`
- **6. Required Authority**: `AUTH-1`
- **7. Tool Binding**: `Core.RecommendationEngine`
- **8. Validation Rules**: `["confidence score >= 0.65 threshold required to yield recommendation", "stock eligibility must be verified", "evidence must contain at least 1 verified timeline event ID from Customer 360 (FR-C360-002)"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 500, "backoff_multiplier": 1.5, "retry_on_timeout": true, "non_retryable_errors": ["EMPTY_CATALOG"]}`
- **10. Timeout**: `2500ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-12-06` (**VALIDATION**) — Best candidate scores below the 0.65 confidence threshold. Expected: No recommendation is returned (explicit refusal), not a low-confidence product.
  - `TC-SKILL-12-07` (**VALIDATION**) — Evidence lacks a verified Customer 360 timeline event id, or `consent_verified`/`suppression_cleared` is false. Expected: The recommendation is rejected before presentation (FR-C360-002).
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer"], "evidence_card": "EV_SALES_RECOMMENDATION", "record_latency": true}`

```typescript
export interface RecommendationEvidence {
  verified_timeline_event_ids: string[];
  verified_model: string;
  historical_spend?: number;
  category_affinity?: string;
}

export interface RecommendationEligibility {
  stock_available: boolean;
  consent_verified: boolean;
  suppression_cleared: boolean;
}

export interface InputSalesRecommendProduct {
  tenant_id: string;
  customer_id: string;
  current_cart_skus: string[];
  recommendation_type?: 'CROSS_SELL' | 'UPSELL' | 'SUBSTITUTE' | 'BUNDLE' | 'REPLENISHMENT';
}
export interface OutputSalesRecommendProduct {
  customer: string;
  product: { sku: string; name: string; price: number };
  reason: string;
  evidence: RecommendationEvidence;
  eligibility: RecommendationEligibility;
  confidence: number;
  expected_outcome: { conversion_probability: number; expected_revenue: number; currency: string };
}
```

---

#### Skill 13: `skill.sales.create_cart`
- **1. Skill ID**: `skill.sales.create_cart`
- **2. Purpose**: Creates or modifies an active shopping cart for the current session.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "session_id", "items", "idempotency_key"],
  "properties": {
    "tenant_id": { "type": "string" },
    "session_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["sku_id", "quantity"],
        "properties": {
          "sku_id": { "type": "string" },
          "quantity": { "type": "integer", "minimum": 1 }
        }
      }
    },
    "idempotency_key": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["cart_id", "item_count", "subtotal", "currency", "updated_at"],
  "properties": {
    "cart_id": { "type": "string" },
    "item_count": { "type": "integer" },
    "subtotal": { "type": "number" },
    "currency": { "type": "string" },
    "updated_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["SAL-02", "SAL-04"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `API-002.CommerceCartAPI`
- **8. Validation Rules**: `["items array must not be empty", "all SKUs must have available inventory"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 400, "backoff_multiplier": 1.5, "retry_on_timeout": false, "non_retryable_errors": ["OUT_OF_STOCK", "IDEMPOTENCY_CONFLICT"]}`
- **10. Timeout**: `2000ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-13-06` (**IDEMPOTENCY**) — Identical `idempotency_key` replayed after a successful mutation. Expected: The original `cart_id` and subtotal are returned; no duplicated line items and no second cart.
  - `TC-SKILL-13-07` (**VALIDATION**) — Any item without available inventory. Expected: `OUT_OF_STOCK` (non-retryable); the cart is left unchanged (all-or-nothing).
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_CART_MUTATION", "record_latency": true}`

```typescript
export interface InputSalesCreateCart {
  tenant_id: string;
  session_id: string;
  customer_id?: string;
  items: Array<{ sku_id: string; quantity: number }>;
  idempotency_key: string;
}
export interface OutputSalesCreateCart {
  cart_id: string;
  item_count: number;
  subtotal: number;
  currency: string;
  updated_at: string;
}
```

---

#### Skill 14: `skill.sales.create_order`
- **1. Skill ID**: `skill.sales.create_order`
- **2. Purpose**: Creates a draft or pending order in ERP with server-verified prices and cryptographic effect key.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "cart_id", "customer_id", "shipping_address", "payment_method", "effect_key"],
  "properties": {
    "tenant_id": { "type": "string" },
    "cart_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "shipping_address": { "type": "object" },
    "payment_method": { "type": "string", "enum": ["CREDIT_CARD", "CVS_COD", "LINE_PAY", "JKOPAY", "STRIPE", "PAYPAL"] },
    "effect_key": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["order_id", "order_number", "total_amount", "currency", "status", "created_at"],
  "properties": {
    "order_id": { "type": "string" },
    "order_number": { "type": "string" },
    "total_amount": { "type": "number" },
    "currency": { "type": "string" },
    "status": { "type": "string", "enum": ["DRAFT", "PENDING_PAYMENT", "CONFIRMED"] },
    "payment_url": { "type": "string" },
    "created_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["SAL-02", "SAL-04", "SAL-05"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `API-001.OrderConnector`
- **8. Validation Rules**: `["effect_key must be unique within 72h Redis cache", "total_amount must match pricing engine quote", "payment_method must be supported in tenant country"]`
- **9. Retry Policy**: `{"max_retries": 1, "initial_interval_ms": 1000, "backoff_multiplier": 1.0, "retry_on_timeout": false, "non_retryable_errors": ["ORDER_ALREADY_EXISTS", "PAYMENT_REJECTED"]}`
- **10. Timeout**: `4000ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-14-06` (**IDEMPOTENCY**) — Identical `effect_key` replayed after ERP accepted the order. Expected: The stored `order_id`/`order_number` is returned; exactly one order exists in ERP (BR-005, BR-006).
  - `TC-SKILL-14-07` (**VALIDATION**) — `total_amount` differing from the pricing-engine quote, or an unsupported `payment_method`. Expected: The order is refused before ERP dispatch; no draft or pending order is created.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id", "shipping_address"], "evidence_card": "EV_ORDER_CREATION", "record_latency": true}`

```typescript
export interface InputSalesCreateOrder {
  tenant_id: string;
  cart_id: string;
  customer_id: string;
  shipping_address: Record<string, unknown>;
  payment_method: 'CREDIT_CARD' | 'CVS_COD' | 'LINE_PAY' | 'JKOPAY' | 'STRIPE' | 'PAYPAL';
  effect_key: string;
}
export interface OutputSalesCreateOrder {
  order_id: string;
  order_number: string;
  total_amount: number;
  currency: string;
  status: 'DRAFT' | 'PENDING_PAYMENT' | 'CONFIRMED';
  payment_url?: string;
  created_at: string;
}
```

---

#### Skill 15: `skill.sales.send_message`
- **1. Skill ID**: `skill.sales.send_message`
- **2. Purpose**: Dispatches personalized consultation or cart recovery message via target channel.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "recipient_id", "channel", "message_content", "effect_key"],
  "properties": {
    "tenant_id": { "type": "string" },
    "recipient_id": { "type": "string" },
    "channel": { "type": "string", "enum": ["LINE", "WHATSAPP", "WEB_CHAT", "SMS", "ZALO", "TIKTOK", "MESSENGER", "INSTAGRAM"] },
    "message_content": {
      "type": "object",
      "required": ["text"],
      "properties": {
        "text": { "type": "string" },
        "quick_replies": { "type": "array", "items": { "type": "string" } },
        "template_id": { "type": "string" },
        "template_params": { "type": "object", "additionalProperties": { "type": "string" } },
        "card": {
          "type": "object",
          "properties": {
            "title": { "type": "string" },
            "description": { "type": "string" },
            "image_url": { "type": "string" },
            "action_url": { "type": "string" }
          }
        }
      }
    },
    "effect_key": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["message_id", "provider_reference", "delivered_at"],
  "properties": {
    "message_id": { "type": "string" },
    "provider_reference": { "type": "string" },
    "delivered_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["SAL-02", "SAL-04", "SAL-05"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `API-003.CommunicationConnector`
- **8. Validation Rules**: `["recipient must have active consent", "session mutex lock must not be held by human"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 500, "backoff_multiplier": 2.0, "retry_on_timeout": false, "non_retryable_errors": ["BLOCKED_BY_USER", "SESSION_EXPIRED"]}`
- **10. Timeout**: `3000ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-15-06` (**VALIDATION**) — Recipient without active consent, or a session whose mutex is held by a human. Expected: The message is refused before dispatch (`BLOCKED_BY_USER`/`SESSION_EXPIRED`); nothing is sent (BR-004).
  - `TC-SKILL-15-07` (**IDEMPOTENCY**) — Identical `effect_key` replayed after a successful send. Expected: The stored `message_id` is returned; exactly one provider send occurs.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["recipient_id"], "evidence_card": "EV_OUTBOUND_MESSAGE", "record_latency": true}`

```typescript
export interface OutboundMessagePayload {
  text: string;
  quick_replies?: string[];
  template_id?: string;
  template_params?: Record<string, string>;
  card?: { title: string; description: string; image_url?: string; action_url?: string };
}

export interface InputSalesSendMessage {
  tenant_id: string;
  recipient_id: string;
  channel: 'LINE' | 'WHATSAPP' | 'WEB_CHAT' | 'SMS' | 'ZALO' | 'TIKTOK' | 'MESSENGER' | 'INSTAGRAM';
  message_content: OutboundMessagePayload;
  effect_key: string;
}
export interface OutputSalesSendMessage {
  message_id: string;
  provider_reference: string;
  delivered_at: string;
}
```

---

### 4.3. Customer Care & Retention Domain Skills (8 Skills)

#### Skill 16: `skill.care.search_faq`
- **1. Skill ID**: `skill.care.search_faq`
- **2. Purpose**: Queries approved Second Brain knowledge base (`/customer-care/faq.md`) for verified resolutions.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "query_text"],
  "properties": {
    "tenant_id": { "type": "string" },
    "query_text": { "type": "string", "minLength": 1 },
    "top_k": { "type": "integer", "default": 3, "maximum": 5 }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["answers", "match_confidence"],
  "properties": {
    "answers": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["faq_id", "question", "approved_answer", "source_file"],
        "properties": {
          "faq_id": { "type": "string" },
          "question": { "type": "string" },
          "approved_answer": { "type": "string" },
          "source_file": { "type": "string" }
        }
      }
    },
    "match_confidence": { "type": "number", "minimum": 0, "maximum": 1 }
  }
}
```
- **5. Allowed Agents**: `["CS-01"]`
- **6. Required Authority**: `AUTH-0` (Observe — FAQ retrieval is read-only; sending the answer is a separate AUTH-3 action)
- **7. Tool Binding**: `SecondBrain.FAQEngine`
- **8. Validation Rules**: `["answers must be sourced exclusively from approved Second Brain documents"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 300, "backoff_multiplier": 1.5, "retry_on_timeout": true, "non_retryable_errors": ["CORPUS_UNAVAILABLE"]}`
- **10. Timeout**: `1500ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-16-06` (**VALIDATION**) — Query with no approved corpus match. Expected: Empty `answers`; the engine never synthesizes an unapproved answer (BR-003).
  - `TC-SKILL-16-07` (**RESILIENCE**) — Second Brain corpus unavailable. Expected: `CORPUS_UNAVAILABLE` (non-retryable); no answer is invented and no partial citation is presented.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_FAQ_QUERY", "record_latency": true}`

```typescript
export interface InputCareSearchFAQ {
  tenant_id: string;
  query_text: string;
  top_k?: number;
}
export interface OutputCareSearchFAQ {
  answers: Array<{ faq_id: string; question: string; approved_answer: string; source_file: string }>;
  match_confidence: number;
}
```

---

#### Skill 17: `skill.care.lookup_order`
- **1. Skill ID**: `skill.care.lookup_order`
- **2. Purpose**: Looks up order history, fulfillment status, and items for customer support inquiries.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "order_identifier", "customer_id", "verification_reference", "verification_status"],
  "properties": {
    "tenant_id": { "type": "string" },
    "order_identifier": { "type": "string" },
    "customer_id": { "type": "string", "description": "Server-resolved from the authenticated customer session (§04); never caller-asserted (BR-003, NFR-008)" },
    "verification_reference": { "type": "string", "description": "Reference to the server-side identity-verification record for this session; resolved by the server, never trusted from the caller" },
    "verification_status": { "type": "string", "enum": ["VERIFIED"], "description": "Server-verified status; absent or non-VERIFIED fails closed" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["order_id", "status", "line_items", "total_price", "currency", "order_date"],
  "properties": {
    "order_id": { "type": "string" },
    "status": { "type": "string", "enum": ["PENDING", "PROCESSING", "SHIPPED", "DELIVERED", "CANCELLED", "RETURNED"] },
    "line_items": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["sku_id", "product_name", "quantity", "unit_price", "currency"],
        "properties": {
          "sku_id": { "type": "string" },
          "product_name": { "type": "string" },
          "quantity": { "type": "integer" },
          "unit_price": { "type": "number" },
          "currency": { "type": "string" }
        }
      }
    },
    "total_price": { "type": "number" },
    "currency": { "type": "string" },
    "tracking_number": { "type": ["string", "null"] },
    "order_date": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["CS-01"]`
- **6. Required Authority**: `AUTH-0` (Observe — order lookup is read-only after verified identity; sending the answer is a separate AUTH-3 action)
- **7. Tool Binding**: `API-001.OrderConnector`
- **8. Validation Rules**: `["customer_id must be server-resolved from the authenticated session and must match the order owner; a caller-supplied identity or verification claim is never accepted as a binding input (BR-003, NFR-008)", "verification_reference must resolve server-side to a verification record for this tenant/customer and verification_status must be VERIFIED; a missing, unresolvable, or non-VERIFIED reference fails closed with IDENTITY_UNVERIFIED and releases no order FACT"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 400, "backoff_multiplier": 1.5, "retry_on_timeout": true, "non_retryable_errors": ["ORDER_NOT_FOUND"]}`
- **10. Timeout**: `2000ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-17-06` (**SECURITY**) — Caller asserts ownership of another customer's order, supplies a caller-asserted phone/email/identifier as proof, or presents a `verification_reference`/`verification_status` that does not resolve server-side to VERIFIED for the session's server-resolved `customer_id`. Expected: `IDENTITY_UNVERIFIED` / `ORDER_OWNER_MISMATCH` before any `API-001.OrderConnector` call; zero order FACTs are released (BR-003, NFR-006). An unverified or caller-asserted identity never authorizes a lookup.
  - `TC-SKILL-17-07` (**BOUNDARY**) — `order_identifier` unknown to the tenant, or owned by a different customer. Expected: `ORDER_NOT_FOUND`; the response never distinguishes "does not exist" from "not yours".
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_ORDER_LOOKUP", "record_latency": true}`

```typescript
export interface OrderLineItemRecord {
  sku_id: string;
  product_name: string;
  quantity: number;
  unit_price: number;
  currency: string;
}

export interface InputCareLookupOrder {
  tenant_id: string;
  order_identifier: string;
  /** Server-resolved from the authenticated session; never caller-asserted. */
  customer_id: string;
  /** Resolved server-side to the identity-verification record; never trusted from the caller. */
  verification_reference: string;
  verification_status: 'VERIFIED';
}
export interface OutputCareLookupOrder {
  order_id: string;
  status: 'PENDING' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'RETURNED';
  line_items: OrderLineItemRecord[];
  total_price: number;
  currency: string;
  tracking_number: string | null;
  order_date: string;
}
```

---

#### Skill 18: `skill.care.track_shipping`
- **1. Skill ID**: `skill.care.track_shipping`
- **2. Purpose**: Tracks live carrier status (Black Cat, HCT, 7-Eleven / FamilyMart CVS logistics via ADPT-TW-001).
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "tracking_number", "carrier"],
  "properties": {
    "tenant_id": { "type": "string" },
    "tracking_number": { "type": "string" },
    "carrier": { "type": "string", "enum": ["BLACK_CAT", "HCT", "SEVEN_ELEVEN_CVS", "FAMILY_MART_CVS", "FEDEX", "DHL"] }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tracking_number", "carrier", "shipping_status", "events"],
  "properties": {
    "tracking_number": { "type": "string" },
    "carrier": { "type": "string" },
    "shipping_status": { "type": "string", "enum": ["PICKED_UP", "IN_TRANSIT", "AT_CVS_STORE", "DELIVERED", "RETURNED"] },
    "events": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["status_text", "location", "timestamp"],
        "properties": {
          "status_text": { "type": "string" },
          "location": { "type": "string" },
          "timestamp": { "type": "string", "format": "date-time" }
        }
      }
    }
  }
}
```
- **5. Allowed Agents**: `["CS-01"]`
- **6. Required Authority**: `AUTH-0` (Observe — tracking lookup is read-only)
- **7. Tool Binding**: `LogisticsConnector` (abstract interface; `ADPT-TW-001` is an optional concrete implementation under [UNCONFIRMED][ASM-001])
- **8. Validation Rules**: `["tracking_number must match carrier checksum rules"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 500, "backoff_multiplier": 1.5, "retry_on_timeout": true, "non_retryable_errors": ["CARRIER_TRACKING_NOT_FOUND"]}`
- **10. Timeout**: `2500ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-18-06` (**VALIDATION**) — `tracking_number` that fails the carrier checksum, or an unsupported `carrier`. Expected: Validation failure before the carrier call; no shipping status is returned.
  - `TC-SKILL-18-07` (**RESILIENCE**) — Carrier reports the number as unknown. Expected: `CARRIER_TRACKING_NOT_FOUND` (non-retryable); no scan events are fabricated.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_SHIPPING_TRACK", "record_latency": true}`

```typescript
export interface InputCareTrackShipping {
  tenant_id: string;
  tracking_number: string;
  carrier: 'BLACK_CAT' | 'HCT' | 'SEVEN_ELEVEN_CVS' | 'FAMILY_MART_CVS' | 'FEDEX' | 'DHL';
}
export interface OutputCareTrackShipping {
  tracking_number: string;
  carrier: string;
  shipping_status: 'PICKED_UP' | 'IN_TRANSIT' | 'AT_CVS_STORE' | 'DELIVERED' | 'RETURNED';
  events: Array<{ status_text: string; location: string; timestamp: string }>;
}
```

---

#### Skill 19: `skill.care.manage_case`
- **1. Skill ID**: `skill.care.manage_case`
- **2. Purpose**: Creates, transitions, and persists Customer Support support cases following the SRS §8 canonical 7-state FSM (`NEW` -> `CLASSIFIED` -> `ASSIGNED` -> `IN_PROGRESS` -> `WAITING_CUSTOMER` -> `RESOLVED` -> `CLOSED`), shared verbatim with §03 Entity 18 and the SCR-002 case UI.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "customer_id", "intent", "priority", "conversation_id", "action_type"],
  "properties": {
    "tenant_id": { "type": "string" },
    "case_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "intent": { "type": "string" },
    "priority": { "type": "string", "enum": ["P1", "P2", "P3", "P4"] },
    "conversation_id": { "type": "string" },
    "related_order_id": { "type": ["string", "null"] },
    "evidence_refs": { "type": "array", "items": { "type": "string" } },
    "action_type": { "type": "string", "enum": ["CREATE", "TRANSITION_STATE", "ASSIGN", "RESOLVE", "REOPEN", "CLOSE"] },
    "target_status": { "type": "string", "enum": ["NEW", "CLASSIFIED", "ASSIGNED", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"] },
    "assigned_owner": { "type": ["string", "null"] },
    "notes": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": [
    "case_id",
    "customer_id",
    "intent",
    "priority",
    "status",
    "conversation_id",
    "related_order_id",
    "evidence_refs",
    "assigned_owner",
    "sla_target_hours",
    "updated_at"
  ],
  "properties": {
    "case_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "intent": { "type": "string" },
    "priority": { "type": "string", "enum": ["P1", "P2", "P3", "P4"] },
    "status": {
      "type": "string",
      "enum": ["NEW", "CLASSIFIED", "ASSIGNED", "IN_PROGRESS", "WAITING_CUSTOMER", "RESOLVED", "CLOSED"]
    },
    "conversation_id": { "type": "string" },
    "related_order_id": { "type": ["string", "null"] },
    "evidence_refs": { "type": "array", "items": { "type": "string" } },
    "assigned_owner": { "type": ["string", "null"] },
    "sla_target_hours": { "type": "integer" },
    "updated_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["CS-01"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `PostgreSQL.CaseManagementStore`
- **8. Validation Rules**: `["if action_type is TRANSITION_STATE/ASSIGN/RESOLVE, case_id is mandatory", "status transitions must strictly follow the SRS §8 7-state FSM matrix; an illegal transition is INVALID_FSM_TRANSITION and leaves the case untouched", "REOPEN is an action, not a state: it transitions RESOLVED | CLOSED -> IN_PROGRESS while preserving case_number, SLA history, and evidence; no REOPENED state exists (§03 Entity 18)", "priority must be one of P1..P4 (P1 urgent ... P4 low), the single vocabulary shared by DB, skill, and UI", "a timeout is never retried blind: this skill declares retry_on_timeout: false, so an unconfirmed outcome is reconciled by re-reading the case for (tenant_id, case_id) before any retry"]`
- **9. Retry Policy**: `{"max_retries": 3, "initial_interval_ms": 300, "backoff_multiplier": 1.5, "retry_on_timeout": false, "non_retryable_errors": ["CASE_NOT_FOUND", "INVALID_FSM_TRANSITION"]}`
- **10. Timeout**: `2000ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-19-06` (**VALIDATION**) — Illegal FSM transition, e.g. `NEW` -> `RESOLVED`. Expected: `INVALID_FSM_TRANSITION` (non-retryable); the case keeps its previous state and no partial write occurs.
  - `TC-SKILL-19-07` (**VALIDATION**) — `REOPEN` on a `RESOLVED`/`CLOSED` case. Expected: The case returns to `IN_PROGRESS` preserving `case_number`, SLA history, and evidence; no `REOPENED` state is ever stored (SRS §8, §03 Entity 18).
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_SUPPORT_CASE", "record_latency": true}`

```typescript
export interface InputCareManageCase {
  tenant_id: string;
  case_id?: string;
  customer_id: string;
  intent: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  conversation_id: string;
  related_order_id?: string | null;
  evidence_refs?: string[];
  action_type: 'CREATE' | 'TRANSITION_STATE' | 'ASSIGN' | 'RESOLVE' | 'REOPEN' | 'CLOSE';
  target_status?: 'NEW' | 'CLASSIFIED' | 'ASSIGNED' | 'IN_PROGRESS' | 'WAITING_CUSTOMER' | 'RESOLVED' | 'CLOSED';
  assigned_owner?: string | null;
  notes?: string;
}

export interface OutputCareManageCase {
  case_id: string;
  customer_id: string;
  intent: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  status: 'NEW' | 'CLASSIFIED' | 'ASSIGNED' | 'IN_PROGRESS' | 'WAITING_CUSTOMER' | 'RESOLVED' | 'CLOSED';
  conversation_id: string;
  related_order_id: string | null;
  evidence_refs: string[];
  assigned_owner: string | null;
  sla_target_hours: number;
  updated_at: string;
}
```

---

#### Skill 20: `skill.care.initiate_return`
- **1. Skill ID**: `skill.care.initiate_return`
- **2. Purpose**: Generates reverse logistics return authorization (RMA) requiring human approval (AUTH-4) for refunds.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "order_id", "sku_id", "return_reason", "evidence_images", "effect_key"],
  "properties": {
    "tenant_id": { "type": "string" },
    "order_id": { "type": "string" },
    "sku_id": { "type": "string" },
    "return_reason": { "type": "string" },
    "evidence_images": { "type": "array", "items": { "type": "string" } },
    "effect_key": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["rma_number", "status", "return_shipping_label_url", "initiated_at"],
  "properties": {
    "rma_number": { "type": "string" },
    "status": { "type": "string", "enum": ["AWAITING_APPROVAL", "APPROVED", "REJECTED"] },
    "return_shipping_label_url": { "type": ["string", "null"] },
    "initiated_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["CS-01"]`
- **6. Required Authority**: `AUTH-4` (approval route — prepared, not executed: the refund/reverse-logistics action pauses at the SCR-003 human gate and this skill may run only under the `approval_id` bound to its own `(tenant_id, run_id, effect_key)`; never rank-compared, never a clearance)
- **7. Tool Binding**: `ReverseLogisticsConnector` (abstract interface; `ADPT-TW-001` is an optional concrete implementation under [UNCONFIRMED][ASM-001])
- **8. Validation Rules**: `["order must be within return window (e.g. 7 days for TW)", "must be approved in SCR-003: the approval row must be bound to this run's effect_key and authorize exactly one RMA (BR-007)", "an approval is never treated as a clearance grant"]`
- **9. Retry Policy**: `{"max_retries": 1, "initial_interval_ms": 1000, "backoff_multiplier": 1.0, "retry_on_timeout": false, "non_retryable_errors": ["RETURN_WINDOW_EXPIRED"]}`
- **10. Timeout**: `3500ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-20-06` (**AUTHORITY**) — No SCR-003 approval bound to this run's `effect_key`. Expected: `APPROVAL_REQUIRED`; no RMA number and no shipping label are produced.
  - `TC-SKILL-20-07` (**TIMEOUT**) — Provider accepts the RMA but the response is lost past `timeout_ms`. Expected: `EFFECT_UNKNOWN` (never a re-dispatched request): the reservation stays RESERVED, reconciliation by `effect_key` finds the existing RMA, and no second return authorization exists for that key.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["evidence_images"], "evidence_card": "EV_RMA_INITIATION", "record_latency": true}`

```typescript
export interface InputCareInitiateReturn {
  tenant_id: string;
  order_id: string;
  sku_id: string;
  return_reason: string;
  evidence_images: string[];
  effect_key: string;
}
export interface OutputCareInitiateReturn {
  rma_number: string;
  status: 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED';
  return_shipping_label_url: string | null;
  initiated_at: string;
}
```

---

#### Skill 21: `skill.care.escalate_to_human`
- **1. Skill ID**: `skill.care.escalate_to_human`
- **2. Purpose**: Triggers human handoff (`SCR-005`), releasing bot control and transferring context to human inbox.
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "session_id", "conversation_id", "escalation_reason"],
  "properties": {
    "tenant_id": { "type": "string" },
    "session_id": { "type": "string" },
    "conversation_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "escalation_reason": { "type": "string" },
    "summary_context": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["handoff_id", "queue_position", "status", "escalated_at"],
  "properties": {
    "handoff_id": { "type": "string" },
    "queue_position": { "type": "integer" },
    "status": { "type": "string", "enum": ["ENQUEUED", "ASSIGNED"] },
    "escalated_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["CS-01", "CS-02"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `Orchestrator.HandoffBus`
- **8. Validation Rules**: `["locks bot session mutex immediately", "session state set to awaiting_human"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 300, "backoff_multiplier": 1.5, "retry_on_timeout": false, "non_retryable_errors": ["QUEUE_DOWN"]}`
- **10. Timeout**: `1000ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-21-06` (**VALIDATION**) — Escalation requested while a human already holds the session mutex. Expected: Exactly one handoff is produced and the bot session is released once (no double release, no conflicting takeover state, SCR-005).
  - `TC-SKILL-21-07` (**RESILIENCE**) — Handoff queue unavailable. Expected: `QUEUE_DOWN`, and the session is never left half-released: the mutex release and the handoff commit together or not at all.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_HUMAN_HANDOFF", "record_latency": true}`

```typescript
export interface InputCareEscalateHuman {
  tenant_id: string;
  session_id: string;
  conversation_id: string;
  customer_id?: string;
  escalation_reason: string;
  summary_context?: string;
}
export interface OutputCareEscalateHuman {
  handoff_id: string;
  queue_position: number;
  status: 'ENQUEUED' | 'ASSIGNED';
  escalated_at: string;
}
```

---

#### Skill 22: `skill.care.analyze_churn_risk`
- **1. Skill ID**: `skill.care.analyze_churn_risk`
- **2. Purpose**: Evaluates customer sentiment and inactivity frequency to score churn risk (Tagged strictly as HYPOTHESIS).
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "customer_id"],
  "properties": {
    "tenant_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "recent_message_snippets": { "type": "array", "items": { "type": "string" } }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["customer_id", "churn_probability", "risk_tier", "primary_risk_factors", "classification"],
  "properties": {
    "customer_id": { "type": "string" },
    "churn_probability": { "type": "number", "minimum": 0, "maximum": 1 },
    "risk_tier": { "type": "string", "enum": ["LOW", "MODERATE", "HIGH", "CRITICAL"] },
    "primary_risk_factors": { "type": "array", "items": { "type": "string" } },
    "classification": { "type": "string", "const": "HYPOTHESIS" }
  }
}
```
- **5. Allowed Agents**: `["CS-02"]`
- **6. Required Authority**: `AUTH-1`
- **7. Tool Binding**: `Customer360.AnalyticsLayer`
- **8. Validation Rules**: `["result MUST be tagged with classification: HYPOTHESIS", "cannot overwrite FACT"]`
- **9. Retry Policy**: `{"max_retries": 2, "initial_interval_ms": 500, "backoff_multiplier": 1.5, "retry_on_timeout": true, "non_retryable_errors": ["MODEL_OFFLINE"]}`
- **10. Timeout**: `2500ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-22-06` (**VALIDATION**) — Any result produced by the analytics layer. Expected: `classification = HYPOTHESIS` in every response, with no write to a FACT store (FR-C360-003).
  - `TC-SKILL-22-07` (**RESILIENCE**) — Scoring model offline. Expected: `MODEL_OFFLINE` (non-retryable); no default risk tier and no `LOW` churn probability are returned.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_CHURN_ANALYSIS", "record_latency": true}`

```typescript
export interface InputCareAnalyzeChurnRisk {
  tenant_id: string;
  customer_id: string;
  recent_message_snippets?: string[];
}
export interface OutputCareAnalyzeChurnRisk {
  customer_id: string;
  churn_probability: number;
  risk_tier: 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
  primary_risk_factors: string[];
  classification: 'HYPOTHESIS';
}
```

---

#### Skill 23: `skill.care.issue_retention_offer`
- **1. Skill ID**: `skill.care.issue_retention_offer`
- **2. Purpose**: Generates automated retention voucher within authorized tenant budget, or issues 14-day price protection compensation (ECN-004).
- **3. Input Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["tenant_id", "customer_id", "offer_scenario", "effect_key"],
  "properties": {
    "tenant_id": { "type": "string" },
    "customer_id": { "type": "string" },
    "offer_scenario": { "type": "string", "enum": ["CART_RETENTION_VOUCHER", "PRICE_PROTECTION_14D_ECN_004"] },
    "target_cart_id": { "type": "string" },
    "max_discount_value": { "type": "number", "minimum": 1 },
    "price_protection_details": {
      "type": "object",
      "required": ["original_order_id", "eligible_sku", "historical_price", "new_price"],
      "properties": {
        "original_order_id": { "type": "string" },
        "eligible_sku": { "type": "string" },
        "historical_price": { "type": "number" },
        "new_price": { "type": "number" }
      }
    },
    "effect_key": { "type": "string" }
  },
  "additionalProperties": false
}
```
- **4. Output Schema**:
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "required": ["offer_id", "offer_scenario", "voucher_code", "compensation_amount", "currency", "expires_at", "effect_key"],
  "properties": {
    "offer_id": { "type": "string" },
    "offer_scenario": { "type": "string", "enum": ["CART_RETENTION_VOUCHER", "PRICE_PROTECTION_14D_ECN_004"] },
    "voucher_code": { "type": "string" },
    "compensation_amount": { "type": "number" },
    "price_protection_payout": {
      "type": "object",
      "properties": {
        "original_order_id": { "type": "string" },
        "eligible_sku": { "type": "string" },
        "price_difference": { "type": "number" },
        "payout_method": { "type": "string", "enum": ["STORE_CREDIT", "REFUND_TO_CARD", "COMPENSATION_VOUCHER"] }
      }
    },
    "currency": { "type": "string" },
    "expires_at": { "type": "string", "format": "date-time" },
    "effect_key": { "type": "string" }
  }
}
```
- **5. Allowed Agents**: `["CS-02"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `PromotionEngine.FloorPriceGuard`
- **8. Validation Rules**: `["voucher must not reduce cart subtotal below P_floor (BR-001, BR-002)", "customer cannot receive > 1 retention offer per 30 days", "for PRICE_PROTECTION_14D_ECN_004 original_order_id must be within 14 days and historical_price > new_price"]`
- **9. Retry Policy**: `{"max_retries": 1, "initial_interval_ms": 1000, "backoff_multiplier": 1.0, "retry_on_timeout": false, "non_retryable_errors": ["RETENTION_QUOTA_EXCEEDED", "P_FLOOR_BREACH", "ORDER_OUTSIDE_14D_WINDOW"]}`
- **10. Timeout**: `3000ms`
- **11. Test Cases & Acceptance Criteria**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-23-06` (**VALIDATION**) — Voucher that would take the cart subtotal below `P_floor`, or a second offer inside the 30-day quota. Expected: `P_FLOOR_BREACH` / `RETENTION_QUOTA_EXCEEDED` (non-retryable); no voucher is issued (BR-001, BR-002).
  - `TC-SKILL-23-07` (**IDEMPOTENCY**) — Identical `effect_key` replayed after the offer was issued. Expected: The same `offer_id`/`voucher_code` is returned and the 30-day quota is consumed exactly once.
- **12. Audit Spec**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_RETENTION_VOUCHER", "record_latency": true}`

```typescript
export interface PriceProtectionDetails {
  original_order_id: string;
  eligible_sku: string;
  historical_price: number;
  new_price: number;
}

export interface InputCareIssueRetentionOffer {
  tenant_id: string;
  customer_id: string;
  offer_scenario: 'CART_RETENTION_VOUCHER' | 'PRICE_PROTECTION_14D_ECN_004';
  target_cart_id?: string;
  max_discount_value?: number;
  price_protection_details?: PriceProtectionDetails;
  effect_key: string;
}

export interface OutputCareIssueRetentionOffer {
  offer_id: string;
  offer_scenario: 'CART_RETENTION_VOUCHER' | 'PRICE_PROTECTION_14D_ECN_004';
  voucher_code: string;
  compensation_amount: number;
  price_protection_payout?: {
    original_order_id: string;
    eligible_sku: string;
    price_difference: number;
    payout_method: 'STORE_CREDIT' | 'REFUND_TO_CARD' | 'COMPENSATION_VOUCHER';
  };
  currency: string;
  expires_at: string;
  effect_key: string;
}
```

---

## 5. Automated Test Suite Matrix for Skills

Every skill must pass the 5-point test matrix:

| Test ID | Test Category | Scenario Description | Expected Outcome |
|---|---|---|---|
| `TC-SKILL-01` | Happy Path | Valid input payload and authorized agent. | Successful execution within SLA; valid output schema. |
| `TC-SKILL-02` | Authority Violation | Agent lacks required clearance (e.g. `AUTH-1` agent calls an `AUTH-3` skill), an `AUTH-4` skill is invoked without a bound approval, or any run presents `AUTH-5`. | `INSUFFICIENT_AUTHORITY` for a rank shortfall among `AUTH-0`..`AUTH-3`; `APPROVAL_REQUIRED` for an unapproved `AUTH-4` action (never rank-compared); `PROHIBITED_ACTION` for `AUTH-5`; zero side effects in every case. |
| `TC-SKILL-03` | Schema Invalidation | Input missing mandatory fields or containing illegal extra properties. | Throws `SCHEMA_VALIDATION_ERROR` prior to tool dispatch. |
| `TC-SKILL-04` | Timeout Escalation | Downstream adapter hangs past `timeout_ms`. | AbortController aborts. A read-only skill (`retry_on_timeout: true`) classifies `TIMEOUT` and may retry in-loop only within its declared budget; an effect-bearing skill (`retry_on_timeout: false`) classifies `EFFECT_UNKNOWN`, is never retried blind, and reconciles by `effect_key` before any re-dispatch; circuit failure recorded. |
| `TC-SKILL-05` | Idempotency Verification| Submitting request twice with identical `effect_key`. | Second request receives cached result without duplicate side effects. |
