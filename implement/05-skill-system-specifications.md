# Skill System and Runtime Specifications

> **BLUEPRINT STATUS — target design; NOT IMPLEMENTED, DEPLOYED, MEASURED, or runtime evidence.**
> This document owns the future 23-skill registry and runtime contract `[SRS-MUST][SRS §11, §12, §16, §19 / NFR-001, NFR-002, NFR-003, NFR-004, NFR-008]`.
> Every TypeScript, JSON, SQL, and schema block is a **target snippet** carrying `[NOT-RUNTIME-EVIDENCE]` meaning, not a present runtime artifact.
> Status vocabulary, authority order, and the P_floor ownership conflict are defined once in [`implement/README.md`](./README.md) §5, §7, and §8.1; this document links to them instead of restating competing values.

Status: Target Blueprint Specification (Gate P0) — not an implemented system
System Component: Skill Engine Runtime and Platform Skill Registry (Layer 1)
Document Version: 1.1.0
Target Directory: `implement/05-skill-system-specifications.md`
Canonical ownership (README §7): skill contract, registry invariants, all 23 skills, skill authority serialization, and per-skill error/retry/test contracts.
Linked, not owned here: [`03-database-and-memory-schema.md`](./03-database-and-memory-schema.md) (storage, memory layers, Service Case FSM) · [`04-core-engine-and-orchestrator.md`](./04-core-engine-and-orchestrator.md) (durable workflow, verdict execution, effect reservations) · [`06-api-and-connectors-spec.md`](./06-api-and-connectors-spec.md) (routes, DTOs, error envelope) · [`08-security-governance-nfr.md`](./08-security-governance-nfr.md) (PEP order, BR-001..010 codes, audit) · [`09-sprint-roadmap-and-pilots.md`](./09-sprint-roadmap-and-pilots.md) (gates P0–P5, pilots) · [`README.md`](./README.md) §5/§7/§8.1 (status vocabulary, ownership, P_floor conflict).

---

## 1. Skill Engine Runtime Architecture

The Skill Engine is the isolated execution runtime responsible for validating, arbitrating, and executing deterministic capabilities ("Skills") on behalf of cognitive agents (`MKT-*`, `SAL-*`, `CS-*`).

### 1.1. Core Invariants and Separation of Concerns
1. **Agent vs. Skill Decoupling**: Agents represent LLM-driven cognitive reasoning entities. Skills represent strictly typed, deterministic operational units. An agent never executes tools directly; it requests skill execution through the Revenue Orchestrator.
2. **Hard Authority Enforcement (BR-008, BR-009, SRS §12)**: LLMs cannot upgrade their own execution authority, and no skill may widen the authority of the run that invoked it. `AUTH-0`..`AUTH-3` are the only **assignable clearances** and the only values that take part in a numeric comparison (`AUTHORITY_RANK[granted] < AUTHORITY_RANK[required]` ⇒ `INSUFFICIENT_AUTHORITY`). `AUTH-4` is not a clearance but a **verdict** — the action is *prepared, not executed*: the orchestrator persists one PENDING approval and pauses for the SCR-003 human gate, and the skill executes only under the `approval_id` that authorizes this exact `(tenant_id, run_id, effect_key, payload_digest)`; an approval never raises an agent's clearance. `AUTH-5` is the **hard deny** verdict — never granted, never required, never queued, never approvable, denied immediately with zero side effects. The whole check is server-side and precedes tool execution (canonical verdict algorithm: §04 §3.2.1).
3. **Idempotency Contract (BR-005, NFR-003)**: Every skill whose adapter call can produce an external effect requires a deterministic `effect_key`, reserved durably (`effect_reservations`) before dispatch; an identical key replays the committed receipt instead of repeating the effect.
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

### 1.2. Authority, approval binding, and pricing floor (normative)

The skill runtime applies the PEP verdict order below; `04` owns stage execution and `08` owns the PEP verdict vocabulary. The order is the safety property:

1. **Agent binding** — the caller must appear in the row's `allowed_agents`; otherwise `UNAUTHORIZED_AGENT`. Evaluated before any clearance comparison.
2. **Granted-clearance validity** — the run's granted value must be a real assignable clearance; anything else (including `AUTH-4`/`AUTH-5` arriving as a "grant") is `INVALID_CLEARANCE` and fails closed **before any verdict path**, so a corrupt grant can never reach the approval queue and be laundered into authority.
3. **`AUTH-5` hard deny** — evaluated **before approval queueing**: `PROHIBITED_ACTION`, no `approvals` row is created, no queue position is consumed, nothing is approvable later, and the denial is audited. `AUTH-5` is a verdict, never a grant and never a `required_authority` value.
4. **`AUTH-4` approval route** — the action is *prepared, not executed*: the orchestrator persists exactly one PENDING approval, the run sits in `awaiting_human`, and the skill runs only under the one-time `approval_id` that authorizes this exact action.
5. **Rank comparison** — only `AUTH-0..AUTH-3` are rank-comparable: `INSUFFICIENT_AUTHORITY` on shortfall (BR-008; `ERR_AUTHORITY_BOUNDARY_EXCEEDED` when an agent attempts to exceed its grant).

**Storage rule:** `agents.assigned_authority` may hold only `AUTH-0..AUTH-3`. Only `skills.required_authority` on a registry row may hold `AUTH-4` (routing metadata). No loader, seed, fixture, or LLM output may copy a `required_authority` value into a grant: an approval or a higher requirement never raises `granted_authority`.

**Approval binding:** an approval authorizes one action, keyed by `(tenant_id, run_id, effect_key, payload_digest)`. `approvals` (§03 Entity 24) carries `run_id`, `effect_key`, and `action_id` and stores the decided payload; `actions.action_payload` plus `IEffectGuard(tenant_id, effect_key, payload_digest)` (§04) and the RFC 8785 canonical-JSON + SHA-256 rule (§04; §08 owns the audit hash contract) are the digest authority this layer consumes — the runtime injects that one implementation (§2) and never re-implements it. `payload_digest` is computed over the **normalized validated payload** (defaults applied, unknown keys stripped) that is persisted as the approval/action payload, so validator behaviour can never make an approved digest unmatchable. A payload whose digest differs from the recorded one is not covered: `APPROVAL_PAYLOAD_MISMATCH`, no dispatch. A `MODIFIED` decision (the approver changed the payload) produces a different digest, so the dispatch is refused until the action is re-authorized; a second claim of the same row is `APPROVAL_NOT_CLAIMABLE`; stale or expired approvals are refused; an approval never widens the run's authority.

**Approval cannot waive the prerequisites.** Consent (BR-004), authoritative-source requirements (BR-003), floor safety (BR-001/BR-002), evidence attachment (BR-010), human-takeover state (NFR-007), and the `AUTH-5` prohibition are evaluated independently of any approval and refuse regardless of who approved. An approval only unblocks the `AUTH-4` pause for a proposal that already satisfies them.

**Pricing floor (`[OWNER-DECISION-REQUIRED]`, README §8.1):** every price-bearing skill — `skill.sales.check_price` (quote), `skill.sales.create_cart` when a discount or offer applies, `skill.sales.create_order` (order total), `skill.mkt.dispatch_campaign` when the approved payload carries a price/discount/offer, and `skill.care.issue_retention_offer` (voucher, compensation, price protection) — fails closed unless a floor decision exists that is **owner-approved and provenance-bearing**. Missing, unapproved, expired, or unattributable provenance is `P_FLOOR_UNAVAILABLE`, and no price-bearing action dispatches; no numeric default may be invented and the ERP/SoR price remains the price of record (BR-001, BR-002, BR-003, NFR-008). Ownership, formula/mode, rounding, currency handling, and staleness remain unresolved between the ERP/policy-service proposal and the platform-derived proposal until the Solution Architect and Business/Finance record the decision — the local candidate calculations elsewhere in this pack are illustrative, not canonical, and this skill layer implements whichever model that decision names.

**Memory boundary (SRS §16):** a skill reads and writes only the current task context and the tenant-scoped entities its contract names (§03 owns the five layers). Skills never promote conversation text or `HYPOTHESIS` output into long-term FACT or Organizational Knowledge: `skill.care.analyze_churn_risk` returns `classification: HYPOTHESIS` (FR-C360-003), and Learning Memory writes remain an orchestrator/`03` responsibility, not a skill side effect.

### 1.3. Provisional numeric and provider parameters

Only the SRS-fixed vocabulary (the eleven skill minima, the six authority labels, the seven Service Case states, and the SRS baseline channel set) is a requirement. Every other number, threshold, and provider name in this document is a target parameter that takes effect only when the named owner records it:

| Parameter | Where it appears | Label | Owner / action |
|---|---|---|---|
| Per-skill `timeout_ms`, retry budget, backoff multiplier, jitter | §4 rows fields 9–10, §6.5 | `[PROVISIONAL][ASM-002]` | Business baseline; official SLA locked after the NFR-009 benchmark |
| Circuit-breaker threshold (5 failures) and reset window (30 s) | §2 snippet, §6.5 | `[PROVISIONAL][ASM-002]` | Ops; tuned per guarded dependency |
| Effect-key reservation retention (`72h` Redis cache, §03) | `skill.sales.create_order` validation | `[PROVISIONAL][ASM-002]` | Ops; must cover the reconciliation window |
| Recommendation confidence threshold `0.65` | skill 12 validation rules | `[PROVISIONAL][ASM-002]` | Business; refusal below threshold is mandatory, the numeric value is tenant policy |
| Segment default `5000` / cap `50000` and audience limits | skill 2 validation rules | `[UNCONFIRMED][ASM-003]` | Business/Finance discount-promotion policy |
| `requested_discount_percent` ceiling `50` | skill 10 input schema | `[UNCONFIRMED][ASM-003]` | Business/Finance discount threshold |
| Retention quota (one offer per 30 days) | skill 23 validation rules | `[UNCONFIRMED][ASM-004]` | Finance/Operations compensation policy |
| Return window (`e.g. 7 days for TW`) | skill 20 validation rules | `[UNCONFIRMED][ASM-004]` | Finance/Operations plus tenant policy |
| Price protection `PRICE_PROTECTION_14D_ECN_004` and `mkt`/`care` economic extensions | skill 23, §6.2 | `[OPTIONAL-EXTENSION][UNCONFIRMED][ASM-004]` | Finance/Operations; beyond the SRS baseline, tenant-owned |
| SLA target hours `P1..P4` | skill 19 output `sla_target_hours` | `[UNCONFIRMED][ASM-002]` | Business/CS owner |
| Provider and channel identifiers (LINE, WhatsApp, Instagram, Black Cat, HCT, 7-Eleven, FamilyMart, ECPay, Stripe, Zalo…) | §4 tool bindings and channel enums | `[UNCONFIRMED][ASM-001]` | Product/IT connector audit; the SRS baseline set is Facebook, TikTok, Zalo, Email, SMS, Web/App Chat |
| `market_region` enum (`TW`, `GLOBAL_US`, `GLOBAL_EU`, `VN`) and locale enum | skill 1 input schema | `[PROVISIONAL][ASM-002]` | Deployment scope |

---

## 2. Skill Runtime Engine Implementation (TypeScript)

Below is the target Skill Runtime contract `[BLUEPRINT]` — Dispatcher, Authority Guard, Circuit Breaker, Timeout Controller, and Retry Loop — as a specification for a future implementation, not a deployed harness. Every block in this section is `[NOT-RUNTIME-EVIDENCE]`. Circuit thresholds and timeouts shown here are `[PROVISIONAL][ASM-002]` (§1.3).

```typescript
/**
 * @file skill-engine-runtime.ts
 * @description Target runtime harness for executing platform skills safely ([BLUEPRINT], not deployed).
 */

/**
 * Canonical payload digest seam. One implementation of canonical-JSON + SHA-256 lives in the
 * core-engine contracts (`packages/core-engine/src/contracts`, canonicalized per §08); the runtime
 * consumes it so the authority guard and the approval record can never disagree about a digest.
 */
export type PayloadDigestFn = (payload: unknown) => string;

/**
 * Canonical authority vocabulary (SRS §12). All six labels exist. Only AUTH-0..AUTH-3 are
 * assignable agent clearances and participate in numeric comparison. AUTH-4 is an approval-
 * routing verdict and MAY appear as a registry row's required_authority; AUTH-5 is a hard-deny
 * verdict and MUST NOT appear as an assignable grant or valid registry requirement.
 */
export type AuthorityLevel = 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5';

/** The only values an agent grant may hold; required_authority separately admits AUTH-4 routing. */
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

  /** Digest seam injected from the core-engine contracts so guard and approval row agree (§1.2). */
  constructor(private readonly digestPayload: PayloadDigestFn) {}

  public registerSkill(skill: ISkillContract): void {
    this.assertRegistrable(skill);
    this.registry.set(skill.skill_id, skill);
    // Threshold 5 / reset 30_000 ms are [PROVISIONAL][ASM-002] per-dependency tuning (§1.3).
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

    // 1. Authority Guard Check (server side): agent binding, granted-clearance validity, AUTH-5 hard
    // deny, AUTH-4 route, then rank. Evaluated before schema validation so an unauthorized caller
    // receives a verdict rather than a schema error; every gate here is pre-side-effect.
    const verdict = this.enforceAuthorityGuard(skill, context);

    // 2. Input Validation and normalization. The normalized payload — defaults applied, unknown keys
    // stripped — is the payload the digest is taken over and the one persisted as the action payload,
    // so validator behaviour can never make an approved digest unmatchable.
    const validatedInput = skill.validateInput(rawInput);

    // 3. AUTH-4 approval binding on the normalized payload: the approval must cover exactly this
    // digest (RFC 8785 canonical JSON + SHA-256; `approvals` §03 Entity 24, `IEffectGuard` §04).
    if (verdict === 'AWAITING_HUMAN_APPROVAL') {
      this.assertApprovalCoversPayload(skill, validatedInput, context);
    }

    // 4. Circuit Breaker Check
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

    // Gate 2 — the granted clearance must be a real assignable value before ANY verdict path. A
    // corrupt or non-assignable grant (including AUTH-4/AUTH-5 arriving as a "grant") fails closed
    // here, so it can never reach the approval queue and be laundered into authority.
    const granted = context.granted_authority;
    if (granted === undefined || AUTHORITY_RANK[granted] === undefined) {
      throw new Error(
        `INVALID_CLEARANCE: '${String(granted)}' is not an assignable authority level`
      );
    }

    // Gate 3a — AUTH-5 is a verdict, not a level: hard deny, never queued, never approvable. A
    // registry row can never legitimately require it (§03 Entity 20 CHECK); deny defensively.
    if (required === 'AUTH-5') {
      throw new Error(
        `PROHIBITED_ACTION: ${skill.skill_id} requires AUTH-5, which is a hard deny verdict and is never executable (SRS §12, BR-008)`
      );
    }

    // Gate 3b — AUTH-4 is the approval route, NOT a rank. The skill executes only when the
    // orchestrator has already claimed the PENDING approval row and bound it to this exact
    // (tenant_id, run_id, effect_key) execution (§04 §4.2); a clearance is never raised by it.
    if (required === 'AUTH-4') {
      if (!context.approval_id) {
        throw new Error(
          `APPROVAL_REQUIRED: ${skill.skill_id} prepares an action but never executes it without a human approval bound to this run's effect_key; route through the SCR-003 gate (BR-007)`
        );
      }
      // The digest binding is verified after normalization, in `assertApprovalCoversPayload`; here the
      // verdict is only "prepared — await the human decision".
      return 'AWAITING_HUMAN_APPROVAL';
    }

    // Gate 4 — rank comparison, reachable only for two assignable clearances (AUTH-0..AUTH-3).
    if (AUTHORITY_RANK[granted] < AUTHORITY_RANK[required as AssignableAuthority]) {
      throw new Error(
        `INSUFFICIENT_AUTHORITY: Skill requires ${required}, but context has ${granted}`
      );
    }

    return 'AUTO_APPROVED';
  }

  /**
   * AUTH-4 binding check, evaluated on the normalized payload after validation. `approvals`
   * (§03 Entity 24) records the decided payload and `actions.action_payload` is the payload that will
   * be executed; the runtime recomputes the canonical digest and refuses unless it equals the digest
   * the approval authorized for this `(tenant_id, run_id, effect_key)`. An approver MODIFY therefore
   * changes the digest and the dispatch stays blocked until the action is re-authorized.
   */
  private assertApprovalCoversPayload(
    skill: ISkillContract,
    validatedInput: unknown,
    context: ExecutionContext
  ): void {
    if (!context.approval_id) {
      throw new Error(
        `APPROVAL_REQUIRED: ${skill.skill_id} prepares an action but never executes it without a human approval bound to this run's effect_key; route through the SCR-003 gate (BR-007)`
      );
    }
    if (context.approval_payload_digest !== this.digestPayload(validatedInput)) {
      throw new Error(
        `APPROVAL_PAYLOAD_MISMATCH: ${skill.skill_id} approval ${context.approval_id} covers a different payload digest; a modified payload requires a new authorization before dispatch`
      );
    }
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

Every platform skill conforms to the **eleven SRS minima**, in this exact order: **Skill ID; Purpose; Input/Output; Allowed Agent; Required Authority; Tool/Connector; Validation; Retry Policy; Timeout; Audit; Test Cases**. The target storage mapping splits Input and Output into `input_schema` and `output_schema`, and Audit/Test Cases into `audit_spec` and `test_cases`; this does not create a different SRS contract.

1. **Skill ID**: Canonical dot-notated identifier (`skill.<domain>.<action>`).
2. **Purpose**: Concrete operational scope, intent, and domain boundaries.
3. **Input / Output**: Strict JSON schemas stored as `input_schema` and `output_schema`.
4. **Allowed Agent**: Array of canonical agent IDs; an unlisted agent is refused.
5. **Required Authority**: `AUTH-0..AUTH-3` are assignable grants; `AUTH-4` is approval routing; `AUTH-5` is hard deny and invalid as a requirement.
6. **Tool / Connector**: Target API-001, API-002, API-003, or internal engine binding.
7. **Validation**: Fail-closed business and schema checks before invocation.
8. **Retry Policy**: Bounded retry/reconciliation behavior; no blind effect retry.
9. **Timeout**: Hard execution deadline.
10. **Audit**: Target `audit_spec` mapping for evidence and audit fields.
11. **Test Cases**: Target `test_cases` mapping for mandatory and skill-specific cases.
The per-skill blocks in §4 render **twelve ascending storage labels**. They never re-order the SRS minima: Audit (SRS field 10) is always rendered before Test Cases (SRS field 11).

| Row label | SRS §11 minimum | Storage field | Note |
|---|---|---|---|
| `1. Skill ID` | 1 Skill ID | `skill_id` | Canonical `skill.<domain>.<action>`, unique |
| `2. Purpose` | 2 Purpose | `purpose` | Non-empty operational scope |
| `3. Input Schema` | 3 Input/Output (first half) | `input_schema` | JSON Schema, `additionalProperties: false` |
| `4. Output Schema` | 3 Input/Output (second half) | `output_schema` | JSON Schema with required fields |
| `5. Allowed Agents` | 4 Allowed Agent | `allowed_agents` | Drawn only from the 13 canonical agents |
| `6. Required Authority` | 5 Required Authority | `required_authority` | `AUTH-0..AUTH-3` rank; `AUTH-4` route; `AUTH-5` invalid |
| `7. Tool Binding` | 6 Tool/Connector | `tool_binding` | API-001/002/003 or a named internal engine |
| `8. Validation Rules` | 7 Validation | `validation_rules` | Evaluated in the fail-closed order of §6.3 |
| `9. Retry Policy` | 8 Retry Policy | `retry_policy` | Budget, backoff, `retry_on_timeout`, non-retryable codes |
| `10. Timeout` | 9 Timeout | `timeout_ms` | Hard deadline; `[PROVISIONAL][ASM-002]` |
| `11. Audit Spec` | 10 Audit | `audit_spec` | Level, masked fields, evidence card, latency flag |
| `12. Test Cases & Acceptance Criteria` | 11 Test Cases | `test_cases` | Baseline `TC-SKILL-01..05` plus ≥ 1 specific case |

A row that stores fewer than these eleven minima, or renders Audit after Test Cases, is a storage-mapping defect rather than an SRS-compliant contract. The registry invariants in §6.1 are checked against this table and against the stored row.

### 3.1. Per-Skill Test Contract (all 23 skills)

Every skill specified in §4 must provide a non-empty `test_cases` array — one entry per case, in the `TestCaseSpec` shape (§2):


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
2. **Skill-specific (mandatory, ≥ 1)**: cases identified as `TC-SKILL-<skill number>-<nn>` with `nn ≥ 06`, covering the skill's own boundary values, business-rule refusals, isolation guarantees, and dependency failures. Each skill's field 11 (SRS §11 field 11; row label 12) lists them; §6.6 gives their per-skill observable outcomes.
3. **Enforcement**: `skills.test_cases` (§03 Entity 20) rejects an empty array, and `SkillRuntimeEngine.assertRegistrable` (§2) refuses a contract that omits any baseline id. Neither the registry nor the runtime can execute a skill with no test contract.
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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_MKT_SIGNAL_ANALYSIS", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-01-06` (**BOUNDARY**) — `observation_window_days` = 0 or 91. Expected: `SCHEMA_VALIDATION_ERROR` before any `API-002.EventIngestion` call; no signal and no `trend_velocity` output.
  - `TC-SKILL-01-07` (**SECURITY**) — `market_region` outside the tenant's authorized regions, or a `tenant_id` from another tenant. Expected: `INVALID_REGION` (non-retryable) with zero rows; no cross-tenant signal is released (RLS, NFR-006).

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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": ["customer_ids"], "evidence_card": "EV_MKT_AUDIENCE_SEGMENT", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-02-06` (**VALIDATION**) — `max_segment_size` = 50001. Expected: Validation failure before the cohort query; no `segment_id` and no `customer_ids` are returned.
  - `TC-SKILL-02-07` (**SECURITY**) — Cohort query whose matching customers belong to another tenant. Expected: RLS returns 0 rows; the audit record masks `customer_ids`; no customer identifier leaves the tenant boundary (NFR-006).

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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_CONSENT_VERIFICATION", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-03-06` (**VALIDATION**) — Customer has an active marketing suppression, or no consent row at all. Expected: `allowed = false` with a `suppression_reason`; the downstream outreach skill is refused (BR-004).
  - `TC-SKILL-03-07` (**BOUNDARY**) — `customer_id` unknown to the tenant. Expected: `CUSTOMER_NOT_FOUND` (non-retryable); no consent FACT is released and no default-allow is returned.

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
- **9. Retry Policy**: `{"max_retries": 1, "initial_interval_ms": 1000, "backoff_multiplier": 1.0, "retry_on_timeout": true, "non_retryable_errors": ["PROMPT_INJECTION_BLOCKED"]}`
- **10. Timeout**: `5000ms`
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_MKT_CONTENT_DRAFT", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-04-06` (**SECURITY**) — `campaign_theme` carrying instruction-override / prompt-injection text. Expected: `PROMPT_INJECTION_BLOCKED` (non-retryable, `FATAL`); no `draft_id` and nothing persisted.
  - `TC-SKILL-04-07` (**BOUNDARY**) — `campaign_theme` longer than 250 characters, or an unsupported `locale`. Expected: Validation failure before the LLM call; no draft is generated.

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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_MKT_BRAND_AUDIT", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-05-06` (**VALIDATION**) — Draft text containing a prohibited claim. Expected: `compliant = false` with the matching `BLOCKING` violation; the dispatch step refuses the draft.
  - `TC-SKILL-05-07` (**BOUNDARY**) — `draft_text` empty or >= 10000 characters. Expected: `MALFORMED_INPUT` (non-retryable); `compliant` is never defaulted to true.

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
  "required": ["tenant_id", "campaign_id", "segment_id", "channel", "approved_content_id"],
  "properties": {
    "tenant_id": { "type": "string" },
    "campaign_id": { "type": "string" },
    "segment_id": { "type": "string" },
    "channel": { "type": "string", "enum": ["LINE", "WHATSAPP", "EMAIL", "SMS", "ZALO", "TIKTOK", "MESSENGER", "INSTAGRAM"] },
    "approved_content_id": { "type": "string" },
    "offer_id": { "type": "string" },
    "discount_amount": { "type": "number", "minimum": 0 },
    "discount_percent": { "type": "number", "minimum": 0, "maximum": 100 },
    "proposed_price": { "type": "number", "exclusiveMinimum": 0 },
    "price_source": { "type": "string" },
    "floor_source": { "type": "string" },
    "promotion_provenance": { "type": "string" },
    "promotion_source": { "type": "string" },
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
- **8. Validation Rules**: `["approval_id and approval_payload_digest must be verified against the canonical approvals gate (SCR-003): the approval must exist, be bound to this run's effect_key, and authorize exactly one dispatch (BR-007)", "an approval is never treated as a clearance grant and never raises the caller's authority", "channel quota must be available"]`
- **9. Retry Policy**: `{"max_retries": 0, "initial_interval_ms": 0, "backoff_multiplier": 1.0, "retry_on_timeout": false, "non_retryable_errors": ["AUTH_DENIED", "CAMPAIGN_ALREADY_SENT"]}`
- **10. Timeout**: `5000ms`
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_CAMPAIGN_DISPATCH", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-06-06` (**AUTHORITY**) — Invocation with no bound `approval_id`, or an approval bound to a different `effect_key`. Expected: `APPROVAL_REQUIRED`: exactly one PENDING approval row exists for the run and zero recipients are contacted; no rank comparison takes place.
  - `TC-SKILL-06-07` (**IDEMPOTENCY**) — The same campaign/segment dispatch is submitted twice. Expected: `CAMPAIGN_ALREADY_SENT` (non-retryable, `max_retries: 0`); the recipient count is unchanged by the second call.

```typescript
export interface InputMktDispatchCampaign {
  tenant_id: string;
  campaign_id: string;
  segment_id: string;
  channel: 'LINE' | 'WHATSAPP' | 'EMAIL' | 'SMS' | 'ZALO' | 'TIKTOK' | 'MESSENGER' | 'INSTAGRAM';
  approved_content_id: string;
  proposed_price?: number;
  price_source?: string;
  floor_source?: string;
  promotion_provenance?: string;
  promotion_source?: string;
  /** Shared orchestrator effect binding on effect-bearing dispatches. */
  effect_key?: string;
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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_MKT_ATTRIBUTION", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-07-06` (**VALIDATION**) — `campaign_id` unknown to the tenant. Expected: `CAMPAIGN_NOT_FOUND` (non-retryable); no attribution figures are returned.
  - `TC-SKILL-07-07` (**BOUNDARY**) — `attribution_model` outside the declared enum. Expected: `SCHEMA_VALIDATION_ERROR` before the analytics query; no partial metrics.

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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_CATALOG_SEARCH", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-08-06` (**SECURITY**) — `query` containing SQL or prompt-injection tokens. Expected: `MALFORMED_QUERY` (non-retryable); the catalog adapter is never called.
  - `TC-SKILL-08-07` (**BOUNDARY**) — `limit` = 21, or `limit` omitted. Expected: `limit` 21 is rejected; an omitted `limit` defaults to 5 and never exceeds 20.

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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_INVENTORY_CHECK", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-09-06` (**RESILIENCE**) — WMS/inventory adapter unreachable. Expected: Fail closed with no `in_stock` claim; a stale cached quantity is never served as a FACT (`fail closed if WMS offline`).
  - `TC-SKILL-09-07` (**BOUNDARY**) — `sku_id` absent from the active catalog. Expected: `SKU_NOT_FOUND` (non-retryable); no availability of 0 is fabricated.

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
    "requested_discount_percent": { "type": "number", "minimum": 0, "maximum": 100 }
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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_PRICE_CALCULATION", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-10-06` (**VALIDATION**) — `requested_discount_percent` that would push `final_price` below `p_floor`. Expected: `final_price >= p_floor` holds in every response: the floor-breach attempt yields `discount_allowed = false`, never a discounted price (BR-001, BR-002).
  - `TC-SKILL-10-07` (**SECURITY**) — `quote_token` tampered with, or signed under another tenant's secret. Expected: Signature verification fails and the quote is refused; the order step never accepts the token.

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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id", "customer_identifier"], "evidence_card": "EV_CUSTOMER_HYDRATION", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-11-06` (**AUTHORITY**) — Run whose identity resolved to `UNRESOLVED`, or whose bound `customer_id` differs from the requested profile. Expected: The call is refused and zero profile rows are released; an anonymous session never receives a Customer 360 FACT (BR-004, NFR-006).
  - `TC-SKILL-11-07` (**SECURITY**) — Read attempted across tenants. Expected: 0 rows by RLS; the response does not disclose whether the other tenant's customer exists.

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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": ["customer"], "evidence_card": "EV_SALES_RECOMMENDATION", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-12-06` (**VALIDATION**) — Best candidate scores below the 0.65 confidence threshold. Expected: No recommendation is returned (explicit refusal), not a low-confidence product.
  - `TC-SKILL-12-07` (**VALIDATION**) — Evidence lacks a verified Customer 360 timeline event id, or `consent_verified`/`suppression_cleared` is false. Expected: The recommendation is rejected before presentation (FR-C360-002).

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
    "idempotency_key": { "type": "string" },
    "offer_id": { "type": "string" },
    "discount_amount": { "type": "number", "minimum": 0 },
    "discount_percent": { "type": "number", "minimum": 0, "maximum": 100 }
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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_CART_MUTATION", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-13-06` (**IDEMPOTENCY**) — Identical `idempotency_key` replayed after a successful mutation. Expected: The original `cart_id` and subtotal are returned; no duplicated line items and no second cart.
  - `TC-SKILL-13-07` (**VALIDATION**) — Any item without available inventory. Expected: `OUT_OF_STOCK` (non-retryable); the cart is left unchanged (all-or-nothing).

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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id", "shipping_address"], "evidence_card": "EV_ORDER_CREATION", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-14-06` (**IDEMPOTENCY**) — Identical `effect_key` replayed after ERP accepted the order. Expected: The stored `order_id`/`order_number` is returned; exactly one order exists in ERP (BR-005, BR-006).
  - `TC-SKILL-14-07` (**VALIDATION**) — `total_amount` differing from the pricing-engine quote, or an unsupported `payment_method`. Expected: The order is refused before ERP dispatch; no draft or pending order is created.

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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": ["recipient_id"], "evidence_card": "EV_OUTBOUND_MESSAGE", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-15-06` (**VALIDATION**) — Recipient without active consent, or a session whose mutex is held by a human. Expected: The message is refused before dispatch (`BLOCKED_BY_USER`/`SESSION_EXPIRED`); nothing is sent (BR-004).
  - `TC-SKILL-15-07` (**IDEMPOTENCY**) — Identical `effect_key` replayed after a successful send. Expected: The stored `message_id` is returned; exactly one provider send occurs.

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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_FAQ_QUERY", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-16-06` (**VALIDATION**) — Query with no approved corpus match. Expected: Empty `answers`; the engine never synthesizes an unapproved answer (BR-003).
  - `TC-SKILL-16-07` (**RESILIENCE**) — Second Brain corpus unavailable. Expected: `CORPUS_UNAVAILABLE` (non-retryable); no answer is invented and no partial citation is presented.

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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_ORDER_LOOKUP", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-17-06` (**SECURITY**) — Caller asserts ownership of another customer's order, supplies a caller-asserted phone/email/identifier as proof, or presents a `verification_reference`/`verification_status` that does not resolve server-side to VERIFIED for the session's server-resolved `customer_id`. Expected: `IDENTITY_UNVERIFIED` / `ORDER_OWNER_MISMATCH` before any `API-001.OrderConnector` call; zero order FACTs are released (BR-003, NFR-006). An unverified or caller-asserted identity never authorizes a lookup.
  - `TC-SKILL-17-07` (**BOUNDARY**) — `order_identifier` unknown to the tenant, or owned by a different customer. Expected: `ORDER_NOT_FOUND`; the response never distinguishes "does not exist" from "not yours".

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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": [], "evidence_card": "EV_SHIPPING_TRACK", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-18-06` (**VALIDATION**) — `tracking_number` that fails the carrier checksum, or an unsupported `carrier`. Expected: Validation failure before the carrier call; no shipping status is returned.
  - `TC-SKILL-18-07` (**RESILIENCE**) — Carrier reports the number as unknown. Expected: `CARRIER_TRACKING_NOT_FOUND` (non-retryable); no scan events are fabricated.

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
    "expected_case_version": { "type": "integer", "minimum": 1 },
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
  "oneOf": [
    { "properties": { "action_type": { "const": "CREATE" } } },
    {
      "properties": { "action_type": { "enum": ["TRANSITION_STATE", "ASSIGN", "RESOLVE", "REOPEN", "CLOSE"] } },
      "required": ["case_id", "expected_case_version"]
    }
  ],
  "additionalProperties": false
}
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
    "case_version",
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
    "case_version": { "type": "integer", "minimum": 1 },
    "updated_at": { "type": "string", "format": "date-time" }
  }
}
```
- **5. Allowed Agents**: `["CS-01"]`
- **6. Required Authority**: `AUTH-3`
- **7. Tool Binding**: `PostgreSQL.CaseManagementStore`
- **8. Validation Rules**: ["every non-CREATE action requires case_id and expected_case_version; a stale version fails with CASE_VERSION_CONFLICT without mutation", "status transitions must strictly follow the SRS §8 7-state FSM matrix; an illegal transition is INVALID_FSM_TRANSITION and leaves the case untouched", "REOPEN is an action, not a state: it transitions RESOLVED | CLOSED -> IN_PROGRESS while preserving case_number, SLA history, and evidence; no REOPENED state exists (§03 Entity 18)", "priority must be one of P1..P4 (P1 urgent ... P4 low), the single vocabulary shared by DB, skill, and UI", "case creation and priority changes require an authoritative tenant-specific SLA target; missing ASM-002 policy refuses instead of inventing a default", "case mutation and immutable event receipt commit in one transaction; matching effect-key replay returns the exact receipt and a different fingerprint is rejected", "after timeout, lookup (tenant_id,effect_key); if no receipt and case_id is supplied, re-read tenant-scoped (tenant_id,case_id) before any retry; a timed-out CREATE without a receipt has no case to read and fails closed with CASE_EFFECT_NOT_COMMITTED; retry_on_timeout remains false and no automatic retry occurs"]
- **9. Retry Policy**: {"max_retries": 3, "initial_interval_ms": 300, "backoff_multiplier": 1.5, "retry_on_timeout": false, "non_retryable_errors": ["CASE_NOT_FOUND", "INVALID_FSM_TRANSITION", "CASE_VERSION_CONFLICT", "CASE_BINDING_MISMATCH", "CASE_SLA_POLICY_UNAVAILABLE", "CASE_EFFECT_NOT_COMMITTED", "CASE_RECONCILIATION_FAILED"]}
- **10. Timeout**: `2000ms`
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_SUPPORT_CASE", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-19-06` (**VALIDATION**) — Illegal FSM transition, e.g. `NEW` -> `RESOLVED`. Expected: `INVALID_FSM_TRANSITION` (non-retryable); the case keeps its previous state and no partial write occurs.
  - `TC-SKILL-19-07` (**VALIDATION**) — `REOPEN` on a `RESOLVED`/`CLOSED` case. Expected: The case returns to `IN_PROGRESS` preserving `case_number`, SLA history, and evidence; no `REOPENED` state is ever stored (SRS §8, §03 Entity 18).
  - `TC-SKILL-19-08` (**CONCURRENCY / VERSIONING**) — Non-CREATE action (`TRANSITION_STATE`, `ASSIGN`, `RESOLVE`, `REOPEN`, `CLOSE`) submitted with a stale `expected_case_version` (e.g. expected 2, stored 3). Expected: `CASE_VERSION_CONFLICT` (non-retryable); case update and receipt insert are rejected, leaving the stored case untouched.
  - `TC-SKILL-19-09` (**POLICY**) — Case creation or priority mutation submitted without configured tenant SLA hours (`sla_target_hours` missing). Expected: `CASE_SLA_POLICY_UNAVAILABLE` (non-retryable); no default target is invented and no case row is inserted.
  - `TC-SKILL-19-10` (**IDEMPOTENCY**) — Replaying an identical `effect_key`: (a) with matching `request_fingerprint`, returns the committed `ManagedServiceCase` receipt from `service_case_events` without repeating binding checks or writes; (b) with a conflicting `request_fingerprint`, throws `IDEMPOTENCY_CONFLICT` before reading or updating case state.
  - `TC-SKILL-19-11` (**RECONCILIATION / TIMEOUT**) — Ambiguous timeout handling: repository checks durable receipt `(tenant_id, effect_key)`; if absent and `case_id` is known, re-reads `(tenant_id, case_id)` returning `NOT_COMMITTED` with `current_case_version` without mutating; a timed-out `CREATE` without receipt has no case to re-read and fails closed with `CASE_EFFECT_NOT_COMMITTED` (`retry_on_timeout: false`).
  - `TC-SKILL-19-12` (**GOVERNANCE**) — `RESOLVE` action attempted with empty `evidence_refs` and no linked evidence. Expected: `CASE_EVIDENCE_REQUIRED` (non-retryable); the case remains in `IN_PROGRESS` and no event receipt is committed.

```typescript
export interface InputCareManageCase {
  tenant_id: string;
  case_id?: string;
  expected_case_version?: number;
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
  case_version: number;
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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": ["evidence_images"], "evidence_card": "EV_RMA_INITIATION", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-20-06` (**AUTHORITY**) — No SCR-003 approval bound to this run's `effect_key`. Expected: `APPROVAL_REQUIRED`; no RMA number and no shipping label are produced.
  - `TC-SKILL-20-07` (**TIMEOUT**) — Provider accepts the RMA but the response is lost past `timeout_ms`. Expected: `EFFECT_UNKNOWN` (never a re-dispatched request): the reservation stays RESERVED, reconciliation by `effect_key` finds the existing RMA, and no second return authorization exists for that key.

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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_HUMAN_HANDOFF", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-21-06` (**VALIDATION**) — Escalation requested while a human already holds the session mutex. Expected: Exactly one handoff is produced and the bot session is released once (no double release, no conflicting takeover state, SCR-005).
  - `TC-SKILL-21-07` (**RESILIENCE**) — Handoff queue unavailable. Expected: `QUEUE_DOWN`, and the session is never left half-released: the mutex release and the handoff commit together or not at all.

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
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_CHURN_ANALYSIS", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-22-06` (**VALIDATION**) — Any result produced by the analytics layer. Expected: `classification = HYPOTHESIS` in every response, with no write to a FACT store (FR-C360-003).
  - `TC-SKILL-22-07` (**RESILIENCE**) — Scoring model offline. Expected: `MODEL_OFFLINE` (non-retryable); no default risk tier and no `LOW` churn probability are returned.

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
- **9. Retry Policy**: `{"max_retries": 1, "initial_interval_ms": 1000, "backoff_multiplier": 1.0, "retry_on_timeout": false, "non_retryable_errors": ["RETENTION_QUOTA_EXCEEDED", "ERR_FLOOR_PRICE_VIOLATION", "ORDER_OUTSIDE_14D_WINDOW"]}`
- **10. Timeout**: `3000ms`
- **11. Audit Spec (SRS §11 field 10)**: `{"log_level": "INFO", "mask_pii_fields": ["customer_id"], "evidence_card": "EV_RETENTION_VOUCHER", "record_latency": true}`
- **12. Test Cases & Acceptance Criteria (SRS §11 field 11)**: `test_cases` = `TC-SKILL-01`..`TC-SKILL-05` (§5, baseline) instantiated for this skill, plus:
  - `TC-SKILL-23-06` (**VALIDATION**) — Voucher that would take the cart subtotal below `P_floor`, or a second offer inside the 30-day quota. Expected: `ERR_FLOOR_PRICE_VIOLATION` / `RETENTION_QUOTA_EXCEEDED` (non-retryable); no voucher is issued (BR-001, BR-002).
  - `TC-SKILL-23-07` (**IDEMPOTENCY**) — Identical `effect_key` replayed after the offer was issued. Expected: The same `offer_id`/`voucher_code` is returned and the 30-day quota is consumed exactly once.

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

Every skill carries the five baseline cases below, instantiated with its own input schema, authority requirement, timeout, effect class, and evidence card. The class-level definitions live here and the per-skill observable outcomes are tabulated in §6.6. These are specification intent (`[NOT-RUNTIME-EVIDENCE]`) until executed against a runtime.

| Test ID | Test Category | Scenario Description | Expected Outcome |
|---|---|---|---|
| `TC-SKILL-01` | Happy Path | Valid input payload and authorized agent. | Execution completes inside the declared `timeout_ms`; the output validates against the row's `output_schema`; an effect-bearing skill produces exactly one provider effect and a read-only skill produces none; exactly one evidence record exists with `correlation_id`, latency, and output digest. |
| `TC-SKILL-02` | Authority Violation | Agent lacks required clearance (e.g. `AUTH-1` agent calls an `AUTH-3` skill), an `AUTH-4` skill is invoked without a bound approval, or any run presents `AUTH-5`. | `INSUFFICIENT_AUTHORITY` for a rank shortfall among `AUTH-0`..`AUTH-3`; `APPROVAL_REQUIRED` for an unapproved `AUTH-4` action (never rank-compared); `PROHIBITED_ACTION` for `AUTH-5` with no `approvals` row created; zero side effects in every case. |
| `TC-SKILL-03` | Schema Invalidation | Input missing mandatory fields or containing illegal extra properties. | Throws `SCHEMA_VALIDATION_ERROR` prior to tool dispatch, with zero adapter calls recorded at the connector test sink. |
| `TC-SKILL-04` | Timeout Escalation | Downstream adapter hangs past `timeout_ms`. | AbortController aborts. A read-only skill (`retry_on_timeout: true`) may retry in-loop only within its declared budget; an effect-bearing skill (`retry_on_timeout: false`) is never retried blind, and an unreconciled provider effect remains `EFFECT_UNKNOWN`. Reconciliation checks the durable receipt by `effect_key` before settlement. For `skill.care.manage_case`, no receipt triggers a tenant-scoped case reread when `case_id` is supplied, then non-retryable `CASE_EFFECT_NOT_COMMITTED`; a timed-out CREATE with no receipt has no case to read and fails closed with the same error. Reconciliation failure returns `CASE_RECONCILIATION_FAILED`; no automatic retry occurs; the circuit records one failure. |
| `TC-SKILL-05` | Idempotency Verification| Submitting request twice with identical `effect_key`. | The second request receives the stored result; for an effect-bearing skill exactly one provider record exists for the key, and for a read-only skill the repeat produces no external effect and no divergent payload. |

**Case hygiene.** A case earns a place only if a plausible defect would fail it. Positivity-only assertions — "a candidate exists", "the response is non-empty", "no exception was thrown", "the low-confidence product was returned anyway" — are not acceptance cases and are not evidence; every expectation above names an observable error code, an effect count, or a persisted record. This document registers no positivity-only case.

## 6. Registry Contract, Domain Matrices, and Approval Encoding `[SRS-MUST][SRS §11, §12, §16 / owner: 05]`

The 23 named rows in §4 are the complete platform registry: seven Marketing skills owned by `MKT-01..06`, eight Sales skills owned by `SAL-01..05`, and eight Care/Retention skills owned by `CS-01..02` — 23 skills over the 13 canonical agents. No duplicate ID, empty schema, missing validation/retry/timeout/audit/test-case field, or undeclared connector is registrable.

This section is the canonical owner for skill fields and per-skill error/retry/test contracts (README §7). It does not restate the wire routes (`06`), the durable run/approval state machine (`04`), the storage DDL (`03`), or the PEP verdict vocabulary (`08`).

### 6.1 SRS field mapping and invariants

Field mapping is defined once, in the §3 table (row label → SRS §11 minimum → storage field). The stored target representation splits Input and Output into `input_schema` and `output_schema` and Audit/Test Cases into `audit_spec` and `test_cases`; that is a storage mapping, not a different SRS contract, and it never re-orders the minima.

Registry invariants: exactly 23 unique named skills; all 11 SRS minima non-empty; `allowed_agents` drawn from the 13 canonical agents (§6.2); agent grants only `AUTH-0..AUTH-3`; `required_authority` may be `AUTH-0..AUTH-4`; `AUTH-4` means approval routing, never a grant; `AUTH-5` appears only in prohibited/negative behavior and is never a grant or valid requirement; every row declares the connector/engine binding named in its §4 row (the production connector list remains `[UNCONFIRMED][ASM-001]`); connector unavailability returns a declared error and a safe failure — never a silent substitution or a cached value.

### 6.2 Domain ownership, agent-to-skill matrix, and handoff rules

Every one of the 13 canonical agents is listed below with the exact skills its `allowed_agents` membership permits, its read vs effect boundary, and its handoff route. Agents never invoke one another: each handoff is an orchestrator `RoutingDecision` that carries `(tenant_id, run_id, customer reference, evidence references)` and re-enters the eleven-stage lifecycle at `CONTEXT` (FR-ORC-001, FR-ORC-002).

| Canonical agent | SRS role anchor | Read / analysis skills | Effect or approval skills | Handoff route (out) | SRS trace |
|---|---|---|---|---|---|
| `MKT-01` | §6 MKT-01 Marketing Strategist | `skill.mkt.analyze_market_signal` | — (AUTH-1 propose only) | brief via orchestrator → `MKT-02`, `MKT-03`, `MKT-05` | OBJ-001, §6, §11, §21 PILOT-01; NFR-001, BR-008, NFR-005 |
| `MKT-02` | §6 MKT-02 Audience Intelligence | `skill.mkt.analyze_market_signal`, `skill.mkt.segment_audience`, `skill.mkt.check_consent` | `skill.mkt.segment_audience` (tenant-internal segment write) | audience + consent evidence → `MKT-05` | OBJ-001/004, §6, BR-004, NFR-006 |
| `MKT-03` | §6 MKT-03 Content Agent | — | `skill.mkt.generate_content` (draft only, AUTH-2) | draft → `MKT-04` brand review → `MKT-05` | OBJ-001, §6, §10 brand/voice; BR-009, NFR-001; PILOT-01 |
| `MKT-04` | §6 MKT-04 Brand Guardian | `skill.mkt.audit_brand_compliance` | — | violations + verdict attached to the draft → `SCR-003` route via orchestrator | OBJ-001, §6, BR-002, BR-009 |
| `MKT-05` | §6 MKT-05 Campaign Agent | `skill.mkt.segment_audience`, `skill.mkt.check_consent` | `skill.mkt.dispatch_campaign` (AUTH-4 approval route) | approved dispatch → API-003 → `MKT-06` measurement | OBJ-001, §6, BR-004, BR-007, NFR-002; P3 |
| `MKT-06` | §6 MKT-06 Marketing Analyst | `skill.mkt.evaluate_attribution` | — | attribution + outcome → orchestrator `OUTCOME`/`LEARNING` | OBJ-001, §6, §17, §20 KPI; NFR-002, NFR-005 |
| `SAL-01` | §7 SAL-01 Lead Qualification | `skill.sales.search_product`, `skill.sales.check_stock`, `skill.sales.retrieve_customer` | — | qualified lead with reason + evidence → `SAL-02` / `SAL-03` | OBJ-002, FR-SAL-001; BR-008, NFR-006; PILOT-02 |
| `SAL-02` | §7 SAL-02 AI Sales Advisor | `search_product`, `check_stock`, `check_price`, `retrieve_customer`, `recommend_product` | `create_cart`, `create_order`, `send_message` (AUTH-3 bounded execute) | conversation state → `SAL-04` when the cart is abandoned | OBJ-002, FR-SAL-002, BR-001/002/003; P2 |
| `SAL-03` | §7 SAL-03 Recommendation Agent | `skill.sales.retrieve_customer`, `skill.sales.recommend_product` | — (a recommendation is a proposal, AUTH-1) | 7-field recommendation → `SAL-02` presentation / `SAL-04` recovery | OBJ-002, FR-SAL-003, FR-C360-002; NFR-001, NFR-006; PILOT-02 |
| `SAL-04` | §7 SAL-04 Cart Recovery Agent | `skill.mkt.check_consent`, `skill.sales.check_price`, `skill.sales.retrieve_customer` | `create_cart`, `create_order`, `send_message` | suppression + floor evidence → API-003 send → conversion → `MKT-06` attribution | OBJ-002, §7, BR-004, NFR-008; PILOT-02 |
| `SAL-05` | §7 SAL-05 Reorder / Replenishment | `skill.sales.retrieve_customer` | `skill.sales.create_order`, `skill.sales.send_message` | purchase-cycle signal → orchestrator; suppression/stock check before any send | OBJ-002, §7, BR-004, NFR-008; PILOT-02 |
| `CS-01` | §8 CS-01 Omnichannel Care Agent | `skill.sales.check_stock`, `skill.care.search_faq`, `skill.care.lookup_order`, `skill.care.track_shipping` | `skill.care.manage_case`, `skill.care.initiate_return` (AUTH-4), `skill.care.escalate_to_human` | case/return/escalation → `SCR-005` takeover; unresolved retention risk → `CS-02` | OBJ-003, FR-CS-001, FR-CS-002, BR-003; PILOT-03, P1 |
| `CS-02` | §8 CS-02 Retention / Customer Success | `skill.care.analyze_churn_risk` (AUTH-1, HYPOTHESIS output) | `skill.care.escalate_to_human`, `skill.care.issue_retention_offer` | churn hypothesis + offer route → approval where required → outcome to orchestrator | OBJ-004, FR-CS-003, FR-C360-003, BR-001/002; PILOT-04 |

Cross-domain note: `skill.mkt.check_consent` is a Marketing-owned consent read that `SAL-04` may invoke; that cross-domain read is deliberate and does not create an agent-to-agent call. Optional economic extensions referenced by `skill.care.issue_retention_offer` (`ECN-004` price protection and related retention economics) remain `[OPTIONAL-EXTENSION][UNCONFIRMED][ASM-003/004]`, tenant-owned, and never enabled by an illustrative default.

### 6.3 Runtime pipeline, approval serialization, and testcase safeguards

Target dispatch order (normative, canonical with the §2 engine loop): **registry lookup → tenant/identity binding → allowed-agent binding → granted-clearance validity → authority/verdict evaluation (`AUTH-5` deny, then `AUTH-4` route) → schema validation and normalization → approval-digest binding check → BR/policy evaluation → circuit-breaker admission → idempotency reservation → adapter call → response validation → evidence/audit → retry classification**. Every step above the adapter call is pre-side-effect: a failure in any of them prevents the effect, and the engine evaluates the binding and verdict gates before the schema check so an unauthorized caller receives a verdict rather than a schema error — neither ordering leaks target-schema detail across a tenant boundary. The AUTH-4 digest comparison runs after validation, on the normalized payload (§1.2), so it can never be defeated by validator defaults.

Serialization rules:

- `agents.assigned_authority` serializes only `AUTH-0..AUTH-3`; a stored record holding `AUTH-4` or `AUTH-5` is invalid and is never loaded as a grant.
- `skills.required_authority` serializes `AUTH-0..AUTH-4`: `AUTH-0..AUTH-3` are rank requirements; `AUTH-4` is routing metadata that produces exactly one PENDING `approvals` row bound to `(tenant_id, run_id, effect_key, payload_digest)` and resumes only through the one-time `approval_id` (§1.2).
- `AUTH-5` is never serialized as a valid grant or requirement; defensive input produces `PROHIBITED_ACTION` **before** any approval row is created, so an `AUTH-5` action can never be queued, approved later, or retried into existence.
- An approval, a verdict, or a `MODIFY` decision never raises `granted_authority` and never relaxes a rank requirement: there is no clearance-upgrade path from approval to authority.

Testcase safeguards (unchanged by this document). The existing testcase sources and their generated specifications already encode the same separation, and this pass neither edits nor overrides them:

- `testcases/sources/governance.py` loads a synthetic `skill_authority_registry` whose rows carry `AUTH-0..AUTH-4` as *required authority* (including `skill.sales.create_order`, `skill.mkt.dispatch_campaign`, and `skill.care.initiate_return` at `AUTH-4`) plus a non-registry negative control `skill.governance.raw_dataset_export` at `AUTH-5`; its agent records carry only `AUTH-0..AUTH-3`.
- `testcases/sources/platform.py` asserts that assigned authority is one of `AUTH-0..AUTH-3`, that `AUTH-4` is an approval queue and `AUTH-5` a deny verdict (neither assignable), that granting either to an agent record is rejected, and that routing reads the granted authority without escalating it run to run.
- `testcases/unit/authority.md` (generated, `NOT_RUN` throughout) carries `UNIT-AUTH-GRANT-REGISTRY` and `UNIT-AUTH-VERDICT-PRECEDENCE`: only `AUTH-0..AUTH-3` can be assigned to an agent, and `AUTH-5` deny / `AUTH-4` route are evaluated before rank comparison.

`skill.governance.raw_dataset_export` is a synthetic negative fixture, **not** a 24th platform skill. The registry this document defines is exactly the 23 rows of §4. `skills.required_authority` is the canonical storage field for approval-gated `AUTH-4` routing metadata; the only unresolved questions are the owner decision for price-floor policy and other explicitly listed ASM parameters, not the authority encoding or its safeguard semantics.

### 6.4 Per-skill acceptance template

Every skill row MUST expose: purpose; strict input JSON; strict output JSON; allowed agents; required authority/verdict route; connector binding; validation order; error codes; retryability and circuit breaker; timeout; audit/evidence fields; and at least five observable cases — **HAPPY**, **DENY**, **TIMEOUT**, **SCHEMA**, **IDEMPOTENCY**. §4 holds the canonical 23 instances; §6.5 tabulates their error/retry/breaker/audit contracts and §6.6 their per-skill scenario outcomes. This section defines the completeness contract, never a second registry.

### 6.5 Per-skill runtime contract matrix (error codes, retryability, circuit breaker, audit)

One row per registered skill. `Class` describes **effect behaviour**, not clearance: `READ` produces no external effect and no durable platform mutation, `INTERNAL` writes platform-owned records, `EFFECT` produces an external side effect in a SoR or provider, and `APPROVAL` is an `AUTH-4` row whose effect exists only after the human decision (`skill.mkt.check_consent` is a read declared at `AUTH-3` because it gates outbound dispatch). `Validation order` is this skill's fail-closed sequence (§6.3), and `Guarded dependency` is the circuit-breaker key: threshold/reset are `[PROVISIONAL][ASM-002]` (§1.3) and an `OPEN` breaker returns `CIRCUIT_BREAKER_OPEN` before any adapter call. Every row emits its evidence card plus the 18-field Agent Run audit record (SRS §17) with the listed `mask_pii_fields` pseudonymized.

| Skill ID | Class | Guarded dependency (breaker key) | Validation order (fail-closed) | FATAL error codes | Retryable / budget / `retry_on_timeout` | Idempotency key | Evidence card / masked fields |
|---|---|---|---|---|---|---|---|
| `skill.mkt.analyze_market_signal` | READ | `API-002.EventIngestion` | schema → tenant/region binding → `AUTH-1` rank → window bounds → adapter | `SCHEMA_VALIDATION_ERROR`, `INVALID_REGION`, `CATEGORY_NOT_FOUND`, `UNAUTHORIZED_AGENT`, `INSUFFICIENT_AUTHORITY` | transport 5xx / `TIMEOUT`; ≤2; `true` | request digest (no effect) | `EV_MKT_SIGNAL_ANALYSIS` / `[]` |
| `skill.mkt.segment_audience` | INTERNAL | `PostgreSQL.Customer360Store` | schema → tenant binding → size cap → RFM enum → cohort query | `QUERY_TIMEOUT`, `INVALID_RFM`, `SCHEMA_VALIDATION_ERROR`, `INSUFFICIENT_AUTHORITY` | query error; ≤2; `true` | cohort-criteria digest | `EV_MKT_AUDIENCE_SEGMENT` / `customer_ids` |
| `skill.mkt.check_consent` | READ | `API-002.ConsentStore` | schema → tenant/customer binding → channel configured → consent row | `CUSTOMER_NOT_FOUND`, `SCHEMA_VALIDATION_ERROR`, `INSUFFICIENT_AUTHORITY` | store error; ≤3; `true` | (channel, consent_type) digest | `EV_CONSENT_VERIFICATION` / `customer_id` |
| `skill.mkt.generate_content` | INTERNAL | `Core.LLMContentEngine` | schema → channel/locale supported → length bound → injection screen → engine | `PROMPT_INJECTION_BLOCKED`, `SCHEMA_VALIDATION_ERROR`, `UNAUTHORIZED_AGENT` | engine 5xx; ≤1; `true` | brief digest → one draft | `EV_MKT_CONTENT_DRAFT` / `[]` |
| `skill.mkt.audit_brand_compliance` | READ | `SecondBrain.BrandGuard` | schema → text-length bound → prohibited-claim rules → tone rules | `MALFORMED_INPUT`, `SCHEMA_VALIDATION_ERROR` | guard error; ≤2; `true` | draft-text digest | `EV_MKT_BRAND_AUDIT` / `[]` |
| `skill.mkt.dispatch_campaign` | APPROVAL (conditionally price-bearing) | `API-003.CommunicationConnector` | schema → approval binding → floor provenance only when payload carries price/discount/offer → quota → recipient consent | `REQUIRE_HUMAN_APPROVAL`, `APPROVAL_PAYLOAD_MISMATCH`, `P_FLOOR_UNAVAILABLE`, `ERR_FLOOR_PRICE_VIOLATION`, `CAMPAIGN_ALREADY_SENT`, `CONSENT_REQUIRED` | none; 0; `false` | campaign + segment + revision `effect_key` | `EV_CAMPAIGN_DISPATCH` / `[]` |
| `skill.mkt.evaluate_attribution` | READ | `PostgreSQL.AnalyticsStore` | schema → tenant binding → campaign exists → model enum → query | `CAMPAIGN_NOT_FOUND`, `SCHEMA_VALIDATION_ERROR` | query error; ≤2; `true` | window + model digest | `EV_MKT_ATTRIBUTION` / `[]` |
| `skill.sales.search_product` | READ | `API-001.CatalogConnector` | schema → tenant binding → injection screen → limit bound → adapter | `MALFORMED_QUERY`, `SCHEMA_VALIDATION_ERROR`, `UNAUTHORIZED_AGENT` | connector 5xx; ≤3; `true` | query + category + limit digest | `EV_CATALOG_SEARCH` / `[]` |
| `skill.sales.check_stock` | READ | `API-001.InventoryConnector` | schema → tenant binding → SKU active → WMS reachability | `SKU_NOT_FOUND`, `AUTHORITATIVE_SOURCE_UNAVAILABLE`, `SCHEMA_VALIDATION_ERROR` | WMS error; ≤3; `true` | (sku, warehouse) digest | `EV_INVENTORY_CHECK` / `[]` |
| `skill.sales.check_price` | READ (price-bearing) | `API-001.PricingEngine` | schema → tenant/customer binding → floor provenance → tier → discount bound → `final_price ≥ p_floor` → quote signing | `INVALID_SKU`, `P_FLOOR_UNAVAILABLE`, `ERR_FLOOR_PRICE_VIOLATION`, `AUTHORITATIVE_SOURCE_UNAVAILABLE`, `INSUFFICIENT_AUTHORITY`, `SCHEMA_VALIDATION_ERROR` | pricing 5xx; ≤3; `true` | (sku, customer, tier, floor decision) digest | `EV_PRICE_CALCULATION` / `customer_id` |
| `skill.sales.retrieve_customer` | READ | `PostgreSQL.Customer360Store` | schema → session identity binding → customer match → RLS scope | `NOT_FOUND`, `SCHEMA_VALIDATION_ERROR`, `UNAUTHORIZED_AGENT` | store error; ≤3; `true` | (tenant, customer) digest | `EV_CUSTOMER_HYDRATION` / `customer_id`, `customer_identifier` |
| `skill.sales.recommend_product` | READ | `Core.RecommendationEngine` | schema → tenant/customer binding → eligibility (stock/consent/suppression) → ≥1 verified timeline id → confidence threshold | `EMPTY_CATALOG`, `SCHEMA_VALIDATION_ERROR` | engine error; ≤2; `true` | (customer, cart, type) digest | `EV_SALES_RECOMMENDATION` / `customer` |
| `skill.sales.create_cart` | EFFECT (conditionally price-bearing) | `API-002.CommerceCartAPI` | schema → session binding → items non-empty → inventory → floor provenance only when discount/offer is present → mutation | `OUT_OF_STOCK`, `P_FLOOR_UNAVAILABLE`, `ERR_FLOOR_PRICE_VIOLATION`, `IDEMPOTENCY_CONFLICT`, `SCHEMA_VALIDATION_ERROR` | transport; ≤2; `false` | `idempotency_key` | `EV_CART_MUTATION` / `customer_id` |
| `skill.sales.create_order` | EFFECT | `API-001.OrderConnector` | schema → identity binding → quote match → payment method supported → `effect_key` reservation → ERP | `ORDER_ALREADY_EXISTS`, `PAYMENT_REJECTED`, `SCHEMA_VALIDATION_ERROR` | transport; ≤1; `false` | `effect_key` | `EV_ORDER_CREATION` / `customer_id`, `shipping_address` |
| `skill.sales.send_message` | EFFECT | `API-003.CommunicationConnector` | schema → consent at send time → suppression → session mutex free → `effect_key` reservation → provider | `BLOCKED_BY_USER`, `SESSION_EXPIRED`, `SCHEMA_VALIDATION_ERROR` | transport; ≤2; `false` | `effect_key` | `EV_OUTBOUND_MESSAGE` / `recipient_id` |
| `skill.care.search_faq` | READ | `SecondBrain.FAQEngine` | schema → corpus availability → approved-source filter → retrieval | `CORPUS_UNAVAILABLE`, `SCHEMA_VALIDATION_ERROR` | engine error; ≤3; `true` | query + top_k digest | `EV_FAQ_QUERY` / `[]` |
| `skill.care.lookup_order` | READ | `API-001.OrderConnector` | schema → server-resolved identity + verification record → order-owner match → adapter | `ORDER_NOT_FOUND`, `IDENTITY_UNVERIFIED`, `ORDER_OWNER_MISMATCH`, `SCHEMA_VALIDATION_ERROR` | connector error; ≤3; `true` | (tenant, order, customer) digest | `EV_ORDER_LOOKUP` / `customer_id` |
| `skill.care.track_shipping` | READ | `LogisticsConnector` (`ADPT-TW-001` optional) | schema → carrier supported → checksum → carrier call | `CARRIER_TRACKING_NOT_FOUND`, `SCHEMA_VALIDATION_ERROR` | carrier error; ≤3; `true` | (carrier, tracking number) digest | `EV_SHIPPING_TRACK` / `[]` |
| `skill.care.manage_case` | INTERNAL | `PostgreSQL.CaseManagementStore` | schema → tenant/customer binding → action requires `case_id` → FSM legality → optimistic version → write | `CASE_NOT_FOUND`, `INVALID_FSM_TRANSITION`, `SCHEMA_VALIDATION_ERROR` | transport; ≤3; `false` (re-read by `(tenant_id, case_id)` first) | case version + action digest | `EV_SUPPORT_CASE` / `customer_id` |
| `skill.care.initiate_return` | APPROVAL | `ReverseLogisticsConnector` (`ADPT-TW-001` optional) | schema → approval existence + `effect_key` + digest binding → return window → RMA dispatch | `RETURN_WINDOW_EXPIRED`, `APPROVAL_REQUIRED`, `APPROVAL_PAYLOAD_MISMATCH`, `PROHIBITED_ACTION` | provider error; ≤1; `false` | `effect_key` | `EV_RMA_INITIATION` / `evidence_images` |
| `skill.care.escalate_to_human` | INTERNAL | `Orchestrator.HandoffBus` | schema → session/conversation binding → mutex state → atomic handoff + release | `QUEUE_DOWN`, `SCHEMA_VALIDATION_ERROR` | queue error; ≤2; `false` | conversation handoff digest | `EV_HUMAN_HANDOFF` / `customer_id` |
| `skill.care.analyze_churn_risk` | READ (HYPOTHESIS) | `Customer360.AnalyticsLayer` | schema → tenant/customer binding → model availability → hypothesis tagging | `MODEL_OFFLINE`, `SCHEMA_VALIDATION_ERROR` | model error; ≤2; `true` | (customer, inputs) digest | `EV_CHURN_ANALYSIS` / `customer_id` |
| `skill.care.issue_retention_offer` | EFFECT (price-bearing) | `PromotionEngine.FloorPriceGuard` | schema → tenant/customer binding → floor provenance → quota window → scenario window → voucher issue | `RETENTION_QUOTA_EXCEEDED`, `ERR_FLOOR_PRICE_VIOLATION`, `P_FLOOR_UNAVAILABLE`, `ORDER_OUTSIDE_14D_WINDOW`, `SCHEMA_VALIDATION_ERROR` | engine error; ≤1; `false` | `effect_key` | `EV_RETENTION_VOUCHER` / `customer_id` |

Retry budgets/timeouts above are the §4 row values and stay `[PROVISIONAL][ASM-002]`; the discount, audience, quota, and window bounds they reference are the `[UNCONFIRMED][ASM-003/004]` parameters of §1.3/§6.7.

**Code vocabulary (mapped once, not re-spelled per row).** Floor missing or unprovenanced = `P_FLOOR_UNAVAILABLE` (BR-001); effective price below floor = `ERR_FLOOR_PRICE_VIOLATION` (BR-002; [04 action guard](./04-core-engine-and-orchestrator.md), [08 rule vocabulary](./08-security-governance-nfr.md)); SoR absent or stale = `AUTHORITATIVE_SOURCE_UNAVAILABLE` (BR-003); consent = `CONSENT_REQUIRED` as the §08 rule code with `allowed = false` at the skill boundary; authority verdicts remain `AUTO_APPROVED`, `AWAITING_HUMAN_APPROVAL`, or `DENIED` (AUTH-0..3 grants, AUTH-4 route, AUTH-5 hard deny).

### 6.6 Inherited baseline scenarios — per-skill observable outcomes

Each row instantiates the five baseline cases of §5 with this skill's own schema, authority requirement, timeout, effect class, evidence card, and idempotency key. Cells state what an observer must see; they are `[NOT-RUNTIME-EVIDENCE]` until executed against a runtime, and none may be satisfied by a positivity-only assertion (§5).

| Skill ID | `TC-SKILL-01` HAPPY | `TC-SKILL-02` DENY | `TC-SKILL-03` SCHEMA | `TC-SKILL-04` TIMEOUT | `TC-SKILL-05` IDEMPOTENCY |
|---|---|---|---|---|---|
| `skill.mkt.analyze_market_signal` | `MKT-01`/`MKT-02` at `AUTH-1` → one `API-002.EventIngestion` read, schema-valid output, `EV_MKT_SIGNAL_ANALYSIS` with latency | Unlisted agent → `UNAUTHORIZED_AGENT`; `AUTH-0` run → `INSUFFICIENT_AUTHORITY`; 0 adapter calls | `observation_window_days` out of range → `SCHEMA_VALIDATION_ERROR`; 0 calls | Read-only: `TIMEOUT` retried within ≤2; exhaustion → `SKILL_EXECUTION_FAILED`, one breaker failure | Repeat read yields the same signals; no duplicate signal row, no divergent payload |
| `skill.mkt.segment_audience` | One tenant-scoped segment; `matched_customer_count` equals the returned `customer_ids` | `AUTH-0` → `INSUFFICIENT_AUTHORITY`; cross-tenant cohort → 0 rows | `max_segment_size` 50001 or bad RFM → validation failure pre-query | `QUERY_TIMEOUT` after ≤2; no partial segment persisted | Same criteria → same cohort digest; re-running adds no duplicate rows, `REPLAY` where a stored segment exists |
| `skill.mkt.check_consent` | Consented `(channel, consent_type)` → `allowed=true` + timestamp | Opt-out, expired, or wildcard row → `allowed=false` + `suppression_reason`; downstream send refused (`CONSENT_REQUIRED`) | Unknown channel → `SCHEMA_VALIDATION_ERROR` before the store read | Store error ≤3; exhaustion fails closed — never default-allow | Read-only: same verdict, no consent row mutated |
| `skill.mkt.generate_content` | `MKT-03` at `AUTH-2` → one draft with channel payload; nothing dispatched | Unlisted agent → `UNAUTHORIZED_AGENT`; `AUTH-1` → `INSUFFICIENT_AUTHORITY`; no draft | 250+ char theme or unsupported locale → validation failure before the LLM call | Engine timeout retried once; no partial draft persisted | Replay of the stored draft id returns the stored payload; no second billed generation |
| `skill.mkt.audit_brand_compliance` | Approved copy → `compliant=true`, empty violations | Prohibited claim → `compliant=false` with a `BLOCKING` violation; dispatch refuses the draft | Empty or ≥10000-char text → `MALFORMED_INPUT` before the guard | Guard error ≤2; exhaustion never reports "compliant" | Identical text → identical verdict; nothing written |
| `skill.mkt.dispatch_campaign` | Bound `approval_id` + matching digest → dispatch accepted, status `ENQUEUED`, `EV_CAMPAIGN_DISPATCH` | No approval → `REQUIRE_HUMAN_APPROVAL`/`APPROVAL_REQUIRED`; digest mismatch → `APPROVAL_PAYLOAD_MISMATCH`; `AUTH-5` attempt → `PROHIBITED_ACTION` with no queued row; 0 recipients contacted | Missing `approved_content_id` → `SCHEMA_VALIDATION_ERROR`; 0 recipients | `EFFECT_UNKNOWN` (never re-dispatched); the approval is consumed once; reconcile by `effect_key` | Second submission of the same campaign/segment → `CAMPAIGN_ALREADY_SENT`; recipient count unchanged |
| `skill.mkt.evaluate_attribution` | Existing tenant campaign → ROAS/CAC figures | `AUTH-0` → `INSUFFICIENT_AUTHORITY`; other-tenant campaign → `CAMPAIGN_NOT_FOUND` with 0 rows | Unknown `attribution_model` → `SCHEMA_VALIDATION_ERROR` pre-query | Query error ≤2; exhaustion returns no partial metrics | Read-only: identical figures; no duplicated metric row |
| `skill.sales.search_product` | ≤20 catalog matches with list price and stock flag from API-001 | Unlisted agent → `UNAUTHORIZED_AGENT`; cross-tenant catalog → 0 rows | `limit=21` or injection tokens → `MALFORMED_QUERY` pre-adapter | Read-only ≤3; exhaustion → `SKILL_EXECUTION_FAILED`; no cached price presented as live | Repeat returns the same result set for the same catalog version; no side effect |
| `skill.sales.check_stock` | `available_quantity` + `in_stock` from the WMS | SKU absent → `SKU_NOT_FOUND`; never a fabricated availability of 0 | Missing `sku_id` → `SCHEMA_VALIDATION_ERROR` | WMS down → `AUTHORITATIVE_SOURCE_UNAVAILABLE` after ≤3; stale cache never served as FACT | Repeat read returns one latest snapshot; no reservation created |
| `skill.sales.check_price` | Owner-approved floor decision present → `final_price ≥ p_floor`, signed quote token | Floor missing/unapproved → `P_FLOOR_UNAVAILABLE` (no quote); floor breach → `discount_allowed=false` / `ERR_FLOOR_PRICE_VIOLATION`; `AUTH-2` → `INSUFFICIENT_AUTHORITY`; above the tenant's approved autonomous discount ceiling → AUTH-4 route, never a floor bypass | Percentage outside [0,100] or missing SKU/customer → `SCHEMA_VALIDATION_ERROR`; [0,100] is a percentage domain, not an approved policy limit | `AUTHORITATIVE_SOURCE_UNAVAILABLE` after ≤3; exhaustion issues no quote rather than a cached price | Same payload/key returns original signed result while valid; expiration requires source/policy revalidation, not a second purchase effect |
| `skill.sales.retrieve_customer` | Verified session → profile for the bound customer only | Identity `UNRESOLVED` or mismatched `customer_id` → refused, 0 rows; cross-tenant → 0 rows | Missing `customer_identifier` → `SCHEMA_VALIDATION_ERROR` | Store error ≤3; exhaustion refuses rather than returning a partial profile | Read-only: identical result; no profile mutation |
| `skill.sales.recommend_product` | All 7 FR-SAL-003 fields, ≥1 verified timeline id, stock/consent eligible | Score below threshold → explicit refusal, not a product; missing consent/eligibility → rejected before presentation | Missing `current_cart_skus` or bad `recommendation_type` → `SCHEMA_VALIDATION_ERROR` | Engine error ≤2; exhaustion returns no recommendation (never a low-confidence substitute) | Same cart/context → same candidate-set digest; nothing persisted as FACT |
| `skill.sales.create_cart` | One cart mutation; `cart_id`, item count, subtotal returned; `EV_CART_MUTATION` | `AUTH-2` → `INSUFFICIENT_AUTHORITY`; human-held session → refused; 0 mutations | Empty items or missing `idempotency_key` → `SCHEMA_VALIDATION_ERROR` / `EFFECT_KEY_REQUIRED` | `EFFECT_UNKNOWN`, no blind retry; reconcile by `idempotency_key` before re-dispatch | Same key + same payload → `REPLAY` with the original `cart_id`; changed payload → `IDEMPOTENCY_CONFLICT`; no duplicate line items |
| `skill.sales.create_order` | One ERP order; `order_number` returned | Total ≠ pricing quote, unsupported payment method, or unlisted agent → refused before dispatch; 0 ERP calls | Missing `effect_key`/address → `SCHEMA_VALIDATION_ERROR` / `EFFECT_KEY_REQUIRED` | `EFFECT_UNKNOWN`; reservation stays `RESERVED`; reconcile finds the order or proves absence before retry | Same key + same payload → `REPLAY` with the stored order; exactly one order in ERP; changed payload → `IDEMPOTENCY_CONFLICT` |
| `skill.sales.send_message` | One provider send; `message_id` + `provider_reference` | Missing/withdrawn consent → `CONSENT_REQUIRED` (`allowed=false`); human holds the mutex → refused; 0 sends | Missing channel/content or `effect_key` → `SCHEMA_VALIDATION_ERROR` / `EFFECT_KEY_REQUIRED` | `EFFECT_UNKNOWN`; no second send before reconciliation | Same key + same payload → `REPLAY` with the stored `message_id`; one provider send; changed payload → `IDEMPOTENCY_CONFLICT` |
| `skill.care.search_faq` | Approved answers with `source_file` citations | No approved match → empty `answers`; nothing synthesized | Empty `query_text` or `top_k > 5` → `SCHEMA_VALIDATION_ERROR` | `CORPUS_UNAVAILABLE` after ≤3; no partial citation presented | Read-only: identical result; no corpus write |
| `skill.care.lookup_order` | Verified identity → order, line items, tracking | Caller-asserted identity or non-VERIFIED reference → `IDENTITY_UNVERIFIED`/`ORDER_OWNER_MISMATCH`; 0 order FACTs | Missing `verification_status` → `SCHEMA_VALIDATION_ERROR` | Connector error ≤3 → `AUTHORITATIVE_SOURCE_UNAVAILABLE`; exhaustion refuses, never a partial order | Read-only: identical result; no order mutation |
| `skill.care.track_shipping` | Carrier scan events for a valid tracking number | Checksum failure/unsupported carrier → validation failure; unknown number → `CARRIER_TRACKING_NOT_FOUND` | Missing `carrier`/`tracking_number` → `SCHEMA_VALIDATION_ERROR` | Carrier error ≤3; exhaustion fabricates no scan events | Read-only: identical result; no event written |
| `skill.care.manage_case` | Legal transition persisted once with status, SLA, evidence refs; receipt committed to `service_case_events` | Illegal transition → `INVALID_FSM_TRANSITION`; stale version → `CASE_VERSION_CONFLICT`; missing SLA → `CASE_SLA_POLICY_UNAVAILABLE`; missing evidence on resolve → `CASE_EVIDENCE_REQUIRED`; `AUTH-2` → `INSUFFICIENT_AUTHORITY` | Missing `case_id` or `expected_case_version` for non-CREATE action → `SCHEMA_VALIDATION_ERROR` | `retry_on_timeout:false` → lookup receipt by `(tenant_id, effect_key)`; if absent, re-read by `(tenant_id, case_id)` before retry; timed-out CREATE without receipt → `CASE_EFFECT_NOT_COMMITTED` | Matching `effect_key` replay returns exact receipt; conflicting fingerprint → `IDEMPOTENCY_CONFLICT`; `REOPEN` returns `IN_PROGRESS` preserving `case_number`, SLA history, evidence |
| `skill.care.initiate_return` | Approved RMA with label URL; `EV_RMA_INITIATION` | No bound approval → `REQUIRE_HUMAN_APPROVAL`/`APPROVAL_REQUIRED`; digest mismatch → `APPROVAL_PAYLOAD_MISMATCH`; outside window → `RETURN_WINDOW_EXPIRED` | Missing `effect_key`/images → `SCHEMA_VALIDATION_ERROR` / `EFFECT_KEY_REQUIRED` | Provider accepted, response lost → `EFFECT_UNKNOWN`; reconcile by `effect_key`; no second RMA | Same key + same payload → `REPLAY` with the same RMA; no duplicate label |
| `skill.care.escalate_to_human` | One handoff enqueued, bot mutex released once, SCR-005 shows human-held | Human already holds the mutex → no double release; unlisted agent → `UNAUTHORIZED_AGENT` | Missing `escalation_reason` → `SCHEMA_VALIDATION_ERROR` | Queue down → `QUEUE_DOWN`; handoff and mutex release commit together or not at all | Repeat escalation on the same conversation yields exactly one handoff and one release (`REPLAY`) |
| `skill.care.analyze_churn_risk` | Score + tier with `classification: HYPOTHESIS`; no FACT write | `AUTH-0` → `INSUFFICIENT_AUTHORITY`; cross-tenant customer → refused, 0 rows | Missing `customer_id` → `SCHEMA_VALIDATION_ERROR` | `MODEL_OFFLINE` after ≤2; no default tier and no `LOW` default | Stable score for identical inputs; nothing promoted to FACT or Organizational Knowledge |
| `skill.care.issue_retention_offer` | One voucher under an owner-approved floor decision; quota consumed once | Below floor → `ERR_FLOOR_PRICE_VIOLATION`; floor decision missing → `P_FLOOR_UNAVAILABLE`; second offer inside 30 days → `RETENTION_QUOTA_EXCEEDED`; 0 vouchers | Bad `offer_scenario` or negative `max_discount_value` → `SCHEMA_VALIDATION_ERROR` / `EFFECT_KEY_REQUIRED` | `EFFECT_UNKNOWN`; reconcile by `effect_key`; the quota is not double-consumed | Same key + same payload → `REPLAY` with the same `offer_id`/`voucher_code`; quota consumed exactly once |

### 6.7 Price-bearing skills and the P_floor interim rule `[OWNER-DECISION-REQUIRED]`

Five rows can set, quote, discount, or compensate a price: `skill.sales.check_price` (always), `skill.sales.create_cart` (only when a discount or offer is present), `skill.sales.create_order` (order total), `skill.mkt.dispatch_campaign` (only when the approved payload carries a price, discount, or offer), and `skill.care.issue_retention_offer`. A static registry flag cannot represent the two conditional rows; the runtime classifies them from normalized payload fields. A non-price cart or campaign is not refused solely because no floor decision exists. All price-bearing actions follow one rule:

- **Interim safety rule:** no price-bearing action dispatches without an owner-approved, provenance-bearing floor decision. Missing, unapproved, expired, or unattributable provenance is `P_FLOOR_UNAVAILABLE` and the action is refused; `ERR_FLOOR_PRICE_VIOLATION` covers an effective price computed below an approved floor. No numeric default may be invented and the ERP/SoR price remains the price of record (BR-001, BR-002, BR-003, NFR-008).
- **Two competing models stay visible:** (a) the ERP/policy service supplies an authoritative `floor_price` with provenance and the platform only validates presence, freshness, tenant binding, and signature; (b) the platform derives a floor from owner-approved policy inputs through a documented formula. This document selects neither, and the local candidate calculations elsewhere in the pack ([`04`](./04-core-engine-and-orchestrator.md), [`03`](./03-database-and-memory-schema.md), [`08`](./08-security-governance-nfr.md)) remain candidates, never canonical.
- **Unresolved until the decision is recorded:** ownership, formula/mode, rounding, currency handling, staleness window, and provenance format — Solution Architect with Business/Finance (README §8.1).
- **Capability is not a bypass:** a tenant disabling discount/subsidy capability removes that optional action class; it does not let a price-bearing proposal bypass the safety decision when the capability is used. "`P_floor` if enabled" is never a valid reading.
- **ECN-004** price protection stays `[OPTIONAL-EXTENSION][UNCONFIRMED][ASM-004]`, tenant-owned, and requires the same floor decision before any payout is computed.

Adjacent decisions this layer cannot resolve, each with its interim rule:

| Open decision | Owner | Interim rule |
|---|---|---|
| P_floor ownership, formula/mode, rounding, currency, staleness (README §8.1) | Solution Architect + Business/Finance | No price-bearing dispatch without a provenance-bearing owner-approved floor decision; `P_FLOOR_UNAVAILABLE` |
| Whether `skill.sales.create_order` is a tenant `AUTH-3` bounded-execute or always an `AUTH-4` approval route (the offline fixture exercises `AUTH-4`) | Business/Finance + Solution Architect | The registry row states the minimum; a stricter tenant route is permitted and is the safe default while the financial threshold is unset — never a weaker one |
| Discount and audience ceilings (ASM-003) | Business/Finance | Unset ⇒ approval route, never an invented default |
| Refund/compensation types, retention quota, return window (ASM-004) | Finance/Operations | Unset ⇒ `AUTH-4` route, never autonomous |
| Production connector and channel list (ASM-001) | Product/IT | Unapproved connector ⇒ declared unavailability, never substitution |
| KPI/SLA baseline (ASM-002) | Business | Unmeasured; no document may claim SLA attainment |
| Which Customer 360 fields may be retained long term (ASM-005) | Data/Legal/Product | Skill writes stay limited to the current task context until decided |
| Registry encoding of an approval-gated row's `required_authority: AUTH-4` (§6.3) | Solution Architect | `AUTH-4` serialized only in `skills.required_authority`; never in a grant |

## 7. Rollout Prerequisites `[BLUEPRINT][SRS §24 / P0–P5, owner: 09]`

A skill row may be migrated and exercised offline before its gate, but it is not enabled for a tenant until every prerequisite for its class exists. Gate definitions, evidence bundles, and sign-off are owned by [`09`](./09-sprint-roadmap-and-pilots.md); this table states only what the skill layer requires first. Mock-only or intercepted-boundary output can prove contract behaviour and can never close a gate.

| Skill set | First gate | Prerequisites before enablement | Evidence that closes the gate (`09`) |
|---|---|---|---|
| Registry foundation: all 23 rows registered, read-only classes enabled | P0 | Registry rows migrated (§03 Entity 20), schema validation wired, PEP verdict + audit writer live, tenant context/RLS wired, one digest implementation injected | P0: no authority-boundary violation and no lost trace |
| Care lookup set: `search_faq`, `lookup_order`, `track_shipping` (+ shared `check_stock`) | P1 | Server-side identity-verification record for order lookups, approved Second Brain corpus, carrier connector approved (ASM-001) | P1: one real end-to-end Care conversation with real evidence |
| Care workflow set: `manage_case`, `escalate_to_human` | P1 | Case store with FSM constraints and optimistic versioning, session mutex/SCR-005 takeover, SLA values recorded (ASM-002) | P1: case transition + takeover record |
| Sales commerce set: `search_product`, `check_price`, `create_cart`, `create_order`, `send_message`, `retrieve_customer` | P2 | API-001/002/003 adapters bound and approved, effect reservations + reconciliation job, consent store, floor decision recorded (README §8.1) | P2: AI action → real order → revenue evidence from the SoR |
| Sales advisory set: `recommend_product` | P2 | FR-SAL-003 field validation, verified Customer 360 timeline events (FR-C360-002) | P2: recommendation conversion measurement |
| Marketing set: `analyze_market_signal`, `segment_audience`, `check_consent`, `generate_content`, `audit_brand_compliance` | P3 | Brand/prohibited-claim corpus, audience limits recorded (ASM-003), injection screening wired (BR-009) | P3: human-approved marketing execution with attribution evidence |
| Approval-gated dispatch: `dispatch_campaign`, `initiate_return` | P3 (dispatch) / P1 (returns) | SCR-003 approval queue live with one-time claim and digest binding, recipient consent set, quotas, provider receipts | Signed approval + published campaign / RMA evidence |
| Retention set: `analyze_churn_risk`, `issue_retention_offer` | P4 | Quota and compensation policy recorded (ASM-004), floor decision, HYPOTHESIS tagging enforced | P4: cross-domain lifecycle without customer-context loss |
| Autonomy promotion of any `AUTH-3` row toward unattended execution | P5 | Zero policy violations and zero duplicate effects in the evidence window, cost/latency qualification, signed approver, versioned policy change | P5 contract in [`09`](./09-sprint-roadmap-and-pilots.md); high-risk classes are never promotable |

Additional enablement rules:

- Every row ships behind its own enablement flag stored with the registry row; disabling a skill degrades to the safe path (refuse and hand off to a human via SCR-005), never to an unguarded fallback or a cached value.
- Unset ASM-001..005 parameters fail closed: approval route, declared unavailability, or refusal — never a numeric default and never a silent connector substitution.
- Enabling an effect-bearing row without its reconciliation path (reservation + provider-confirmed absence before any re-dispatch) is prohibited: `EFFECT_UNKNOWN` must always have an owner.

## 8. Verification Scenarios `[BLUEPRINT][SRS §11, §12, §19 / NFR-001, NFR-002, NFR-003, NFR-004, NFR-008]`

Each scenario names an observable outcome; these are `[NOT-RUNTIME-EVIDENCE]` until executed against a runtime, and a check that only asserts a candidate exists or a value is non-empty is not evidence (§5).

| # | Scenario | Observable outcome | SRS anchor |
|---|---|---|---|
| 1 | Registry completeness | Exactly 23 rows with unique IDs, all eleven minima non-empty, each carrying the five baseline cases plus ≥ 1 specific case; a duplicate ID or missing baseline is refused at registration | §11 |
| 2 | Unknown skill | `SKILL_NOT_FOUND`; 0 adapter calls | §11 |
| 3 | Unauthorized agent | `UNAUTHORIZED_AGENT` before any clearance comparison or schema error; 0 effects | §12, BR-008 |
| 4 | Insufficient grant | `INSUFFICIENT_AUTHORITY` / `ERR_AUTHORITY_BOUNDARY_EXCEEDED`; grant unchanged after repeated attempts | BR-008, NFR-001 |
| 5 | Non-assignable grant | A stored `AUTH-4`/`AUTH-5` grant or a corrupt value is `INVALID_CLEARANCE` before any verdict path and never reaches the approval queue | §12 |
| 6 | AUTH-4 without approval | `REQUIRE_HUMAN_APPROVAL`/`APPROVAL_REQUIRED`; exactly one PENDING `approvals` row; 0 external effects; the row is claimable once (`APPROVAL_NOT_CLAIMABLE` on a second claim) | BR-007 |
| 7 | Approval payload binding | Matching digest → dispatch after current guards pass; a payload changed without authorization → `APPROVAL_PAYLOAD_MISMATCH`, no dispatch. Explicit `MODIFY` revalidates and atomically authorizes the normalized new revision; its persisted payload digest, effect key and checkpoint agree before release (`04` §4.2). | BR-007, NFR-002 |
| 8 | AUTH-5 hard deny | `PROHIBITED_ACTION` with no `approvals` row created, no queue position consumed, security alert audited | §12, BR-008 |
| 9 | No clearance upgrade | After an approval, the run's granted authority is unchanged and no rank requirement is relaxed | BR-008 |
| 10 | Schema invalidation | `SCHEMA_VALIDATION_ERROR` before dispatch; adapter call count 0 | §11 |
| 11 | Validation ordering | A row whose tenant or identity binding fails never reaches its adapter even with an otherwise valid payload; a policy/consent failure is not reachable by approval | §11, §15, BR-004 |
| 12 | Timeout, effect-free row | `TIMEOUT` classified retryable within the declared budget; exhaustion records exactly one breaker failure | NFR-004 |
| 13 | Timeout, effect-bearing row | `EFFECT_UNKNOWN`, never a blind resend; reconciliation by `effect_key` returns the provider-confirmed receipt or proves absence before any re-dispatch | BR-005/006, NFR-003/004 |
| 14 | Circuit breaker | After the declared failure count the breaker is `OPEN` and calls return `CIRCUIT_BREAKER_OPEN` with 0 adapter calls; a half-open probe follows the reset window | NFR-004 |
| 15 | Idempotent replay | Same key + same payload → `REPLAY` with the stored receipt and exactly one provider record; changed payload → `IDEMPOTENCY_CONFLICT`; expired reservation → `RECONCILE_REQUIRED`, never a second effect | BR-005/006, NFR-003 |
| 16 | Consent suppression | `allowed = false` / `CONSENT_REQUIRED`; the outbound skill refuses with 0 sends and one audited suppression | BR-004 |
| 17 | Missing floor decision | `P_FLOOR_UNAVAILABLE`; no quote, cart, order, campaign, or voucher dispatch, and no locally derived floor | BR-001, README §8.1 |
| 18 | Floor breach | `discount_allowed = false` / `ERR_FLOOR_PRICE_VIOLATION`; `final_price ≥ p_floor` in every response; the SoR price is unchanged | BR-001/002 |
| 19 | Identity unverified | `IDENTITY_UNVERIFIED` / `ORDER_OWNER_MISMATCH` with 0 order FACTs released | BR-003, NFR-006 |
| 20 | Tenant isolation | Cross-tenant reads return 0 rows and never disclose existence; RLS context resets between requests | NFR-006 |
| 21 | Evidence completeness | Every execution writes the 18-field Agent Run audit record plus its evidence card and digest; an audit write that fails prevents a claimed success | §17, BR-010, NFR-002 |
| 22 | Append-only audit | Denied and paused actions still produce audit rows with `execution_status` denied/pending; the digest chain verifies after tamper attempts | §17, NFR-002 |
| 23 | HYPOTHESIS separation | `skill.care.analyze_churn_risk` output never lands in a FACT store or Organizational Knowledge | FR-C360-003, §16 |
| 24 | Human takeover suppression | While a human holds the session mutex, no skill sends autonomously and the escalation path releases exactly once | NFR-007, SCR-005 |
| 25 | Case FSM | An illegal transition is rejected with the case unchanged; `REOPEN` returns `IN_PROGRESS` preserving `case_number`, SLA history, and evidence, with no stored `REOPENED` state | §8 |
| 26 | Connector failure and quota | Declared error, failure recorded, no fabricated success, and the operator route recorded (failure/retry, never a success claim) | NFR-008, TC-E2E-008 |
| 27 | Single-use approval and restart | After a crash between reservation and dispatch, recovery re-enters the same `effect_key`; one effect exists and the resumed run does not re-dispatch | BR-005/006, NFR-004 |
| 28 | Registry/spec consistency | A generated testcase expectation contradicting §6.5/§6.6 is reconciled in the owning generated source, not waived as behaviour | §11, README §10 |

### 8.1 Registry-to-invocation acceptance boundary `[BLUEPRINT][SRS §11, §12, §16, §17]`

The registry row is the complete admission contract for an invocation. Before a skill implementation is loaded, the runtime resolves the row by immutable `skill_id`, verifies the tenant and caller agent binding, validates the assignable grant, evaluates the `required_authority` route, and checks the row's enablement flag and connector binding. The normalized input is then validated against `input_schema`; only after consent, SoR freshness, floor provenance, takeover, policy, and approval-digest checks pass may the runtime reserve an external effect. An unknown, disabled, malformed, unapproved, or unavailable dependency returns its declared error and creates no provider effect.

The output boundary is equally strict: adapter responses are validated against `output_schema` before they can be returned as a successful result; a missing or ambiguous provider receipt is `EFFECT_UNKNOWN` and is handed to the `04` reconciliation path. Every invocation emits the row's evidence card and audit fields with `tenant_id`, `run_id`, `correlation_id`, authority/verdict, latency, cost status, and retry classification. Registry metadata never authorizes a side effect by itself: `AUTH-4` still requires the one-time bound approval, and no approval can change the agent grant.

This section completes the registry contract only; implementation code, connector credentials, provider availability, and execution results remain absent and `[NOT-RUNTIME-EVIDENCE]`.

Gate P1 remains open until live PostgreSQL/RLS, DB-backed Care pilots, Docker services, approved knowledge corpus, and real System-of-Record (SoR) evidence exist. Offline test harnesses verify local code paths only and do not close the gate.
