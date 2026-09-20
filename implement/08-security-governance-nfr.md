# Implement 08: Security, Governance & Non-Functional Requirements (NFR) Engine

> **BLUEPRINT STATUS — target design (Gate P0), not an inventory of existing code.**
> Every interface, class, rule, DDL reference, and policy parameter below is a **target blueprint for the
> Gate P0 (Foundation) build** (SRS AI-REV-SRS-001 §24). None of it exists in this documentation-only
> repository: no Policy Enforcement Point, audit logger, or floor-price engine is deployed, and no
> security, isolation, latency, cost, or availability result has been measured.
> Security, audit, idempotency, and fail-closed requirements (`NFR-001`, `NFR-002`, `NFR-003`,
> `NFR-007`, `NFR-008`, `BR-001`..`BR-010`, SRS §19) are **mandatory design invariants**.
> Numeric performance, cost, and uptime figures are **provisional design targets pending the ASM-002
> baseline and the NFR-009/NFR-010 benchmarks**, and the discount, audience, reminder-frequency, and
> refund/compensation thresholds are **tenant policy parameters owned by Business/Finance that remain
> [UNCONFIRMED][ASM-003/004]** (SRS §26) - this blueprint fixes no platform-wide value for them.

## 1. Authority Model & Policy Enforcement Point (PEP)

The platform operates on a zero-trust execution model where Large Language Models (LLMs) and autonomous agents possess zero direct execution privileges. The Authority Model (AUTH-0 through AUTH-5) establishes strict operational boundaries enforced deterministically by a central Policy Enforcement Point (PEP) interceptor middleware prior to any tool execution or external side effect.

```
                                    UNTRUSTED BOUNDARY
+------------------+         +-------------------------------+
| Autonomous Agent | ------> | Proposed Action (Raw Payload) |
+------------------+         +-------------------------------+
                                             |
=============================================|=============================================
                                     TRUSTED CORE BOUNDARY
                                             v
                             +-------------------------------+
                             | Policy Enforcement Point (PEP)|
                             +-------------------------------+
                                             |
                  +--------------------------+--------------------------+
                  |                          |                          |
                  v                          v                          v
        +-------------------+      +-------------------+      +-------------------+
        | Authority Matrix  |      | Business Rules    |      | Floor Price       |
        | (AUTH-0..5 Check) |      | (BR-001..BR-010)  |      | Engine (ECN-002)  |
        +-------------------+      +-------------------+      +-------------------+
                  |                          |                          |
                  +--------------------------+--------------------------+
                                             |
                         +-------------------+-------------------+
                         | Decision Outcome                      |
                         +-------------------+-------------------+
                                 /                   \
                  [ PASS / ALLOW ]                   [ FAIL / ESCALATE ]
                         |                                     |
                         v                                     v
            +-------------------------+             +-------------------------+
            | Tool / Adapter Dispatch |             | Block / SCR-003 Queue   |
            | (Signed effect_key)     |             | (Fail Closed NFR-008)   |
            +-------------------------+             +-------------------------+
                         |                                     |
                         +-------------------+-----------------+
                                             v
                             +-------------------------------+
                             | Immutable Audit Store         |
                             | (18 Fields + SHA-256 Chaining)|
                             +-------------------------------+
```

The audit store shown above is the canonical `agentos.audit_records` table (§03 DOMAIN 5, schema in §4.1); `agent_run_logs` is a separate operational log and never substitutes for it. Physical Evidence Records are the separate `agentos.evidence_records` rows referenced by an audit record's `evidence` field (BR-010).

### 1.1 Formal Authority Taxonomy (AUTH-0 to AUTH-5)

| Authority Level | Nomenclature | Permitted Operations | Prohibited Operations | Interceptor Policy Enforcement |
|---|---|---|---|---|
| **AUTH-0** | **Observe** | Read public catalogs, knowledge bases, read customer timeline (if verified). | Any write operation, customer profile modification, external messaging. | Rejects any invocation of mutational connectors (`db.write`, `api.post`). |
| **AUTH-1** | **Recommend** | Calculate match scores, generate product bundles, draft cross-sell hypotheses. | Publishing recommendations to external channels, creating orders. | Interceptor validates output schema; verifies payload is marked as hypothesis. |
| **AUTH-2** | **Draft** | Generate internal campaign copy, format draft support replies in Copilot mode. | Transmitting drafts to end customers or third-party networks. | Outbound dispatch blocked; stores payload in internal draft state store. |
| **AUTH-3** | **Bounded Execute** | Send transactional notifications, check real-time stock, query ERP order status. | Exceeding frequency caps, issuing unapproved discounts, modifying order data. | Checks parameter boundaries (tenant-configured frequency caps, rate limits, and stock thresholds; the concrete cap values are tenant policy, not platform constants). |
| **AUTH-4** | **Approval Required**| Prepare campaign broadcasts, discounts, compensations, refunds, and policy overrides that breach the tenant's configured autonomous limits (**[UNCONFIRMED][ASM-003/004]**). | Autonomous execution without cryptographically signed human approval. | Traps task into `awaiting_human`; dispatches notification to SCR-003 queue. |
| **AUTH-5** | **Prohibited** | **None.** `AUTH-5` is a terminal deny verdict, not a grantable clearance: no proposal is ever permitted at this level. | Arbitrary price generation, cross-customer context access (NFR-006), cross-tenant data access, raw data exfiltration - and every other action classified `AUTH-5`. | Hard server lock. Immediately aborts execution; triggers security audit alert. |

> **AUTH-4 and AUTH-5 are verdicts, not ranks.** Only `AUTH-0`..`AUTH-3` are assignable autonomous clearance levels with a numeric ordering; the database enforces this (`agents.assigned_authority CHECK (assigned_authority IN ('AUTH-0','AUTH-1','AUTH-2','AUTH-3'))`, §03). `AUTH-4` is a routing outcome: the prepared action is sent to the SCR-003 human approval gate and never executed autonomously. `AUTH-5` is an immediate hard deny that always terminates the action and is never reachable by accumulating rank. The concrete limits that push an action from autonomous (`AUTH-3`) to the approval gate (`AUTH-4`) - maximum discount rate, maximum refund/compensation amount, and maximum campaign audience size - are **tenant policy parameters owned by Business/Finance**, not platform constants. They are **not yet approved** and remain **[UNCONFIRMED][ASM-003/004]**; every skill specification that cites a numeric limit must be read as an illustrative placeholder until those owner-approved values are locked.

### 1.2 Policy Enforcement Point (PEP) Interceptor Implementation
The PEP interceptor wraps all agent tool executions. It operates as an asynchronous pipeline filter in the Orchestrator runtime.

```typescript
/**
 * @file governance/PolicyEnforcementPoint.ts
 * Deterministic interceptor middleware enforcing the Authority Model.
 */

export interface SecurityContext {
  readonly tenantId: string;
  readonly agentId: string;
  /**
   * Only AUTH-0..AUTH-3 are ever *assigned* to an agent (see §03
   * `agents.assigned_authority CHECK`). AUTH-4 is an approval verdict and
   * AUTH-5 is a deny verdict; neither is a grantable clearance level.
   */
  readonly agentAssignedAuthority: 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3';
  /**
   * Identity of the single customer bound to the current session. It MUST be the
   * server-verified identity resolved by the Orchestrator (TC-E2E-004), never a
   * value asserted by the model, the prompt, or the channel payload: private
   * profile/order lookups (AUTH-0 read of the customer timeline) fail closed
   * (NFR-008) until that verification completes. Customer A's context is never
   * loaded into a session verified as customer B (NFR-006, SRS §19).
   */
  readonly customerId?: string;
  readonly sessionToken?: string;
  readonly correlationId: string;
}

/**
 * Rank ordering of the four autonomous clearance levels ONLY.
 * AUTH-4 and AUTH-5 are deliberately absent: they are enforcement verdicts,
 * not superuser ranks, so no agent can ever "outrank" a denial.
 */
export const AUTONOMOUS_AUTHORITY_RANK: Readonly<Record<string, number>> = Object.freeze({
  'AUTH-0': 0,
  'AUTH-1': 1,
  'AUTH-2': 2,
  'AUTH-3': 3,
});

/**
 * Provisional fallback for the contact-frequency suppression cap when a tenant has
 * not configured its own. A design parameter, not an approved policy value.
 */
const DEFAULT_AUTONOMOUS_REMINDER_CAP = 2;

export type AuthorityLevel = 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5';

/**
 * Tenant-scoped autonomy limits that move an action from autonomous execution
 * (AUTH-3) to the AUTH-4 human approval gate. Every field is owned and
 * approved by the tenant's Business/Finance function and remains
 * [UNCONFIRMED][ASM-003/004] until locked. `undefined` means "the owner has
 * not approved a value yet" and MUST be treated as fail-closed (route to
 * approval), never as "unlimited".
 */
export interface TenantPolicyParameters {
  readonly maxAutonomousDiscountRate?: number;
  readonly maxAutonomousRefundAmount?: number;
  readonly maxAutonomousAudienceSize?: number;
  readonly maxAutonomousReminderCount?: number;
}

/** Source of tenant policy parameters (owner-approved autonomy limits). */
export interface TenantPolicySource {
  get(tenantId: string): TenantPolicyParameters | undefined;
}

/** Read side of the server-side Skill Registry holding `skills.required_authority` (§03). */
export interface SkillAuthoritySource {
  get(skillId: string): AuthorityLevel | undefined;
}

export interface ActionProposal {
  readonly skillId: string;
  readonly toolName: string;
  readonly requiredAuthority: AuthorityLevel;
  readonly payload: Record<string, unknown>;
  readonly proposedAt: string;
}

export interface EnforcementDecision {
  readonly authorized: boolean;
  readonly decisionCode: 'PERMIT' | 'DENY_PROHIBITED' | 'REQUIRE_HUMAN_APPROVAL' | 'LIMIT_EXCEEDED';
  readonly rationale: string;
  readonly approvalTicketId?: string;
}

export class PolicyEnforcementPoint {
  constructor(
    /** Loads tenant policy parameters; an unset limit fails closed (routes to approval). */
    private readonly tenantPolicyStore: TenantPolicySource = { get: () => undefined },
    /** Server-side Skill Registry; the only authority source the PEP trusts. */
    private readonly skillRegistry: SkillAuthoritySource = { get: () => undefined }
  ) {}

  /**
   * Evaluates an agent action proposal against authority levels and security policies.
   * Enforces zero bypass: prompt injection cannot escalate privileges.
   */
  public async enforce(
    context: SecurityContext,
    proposal: ActionProposal
  ): Promise<EnforcementDecision> {
    // 1. Authoritative Server-Side Authority Resolution (BR-008, NFR-001)
    //    The Orchestrator - never the agent or the LLM - constructs the proposal, and
    //    the server-side Skill Registry (`skills.required_authority`, §03) is the
    //    authoritative source for a skill's required authority. When the skill is
    //    absent from the registry the declared proposal authority is used; the numeric
    //    rank check below still stops any agent from exceeding its assigned clearance,
    //    and the AUTH-4/AUTH-5 verdicts below can never be outranked.
    const requiredAuthority = this.lookupSkillAuthority(proposal.skillId) ?? proposal.requiredAuthority;

    // 2. Hard Lock: AUTH-5 is an immediate deny verdict, evaluated FIRST and never
    //    compared against any rank. There is no clearance that unlocks it.
    if (requiredAuthority === 'AUTH-5') {
      await this.recordSecurityViolation(context, proposal, 'HARD_LOCK_AUTH_5_PROHIBITED');
      return {
        authorized: false,
        decisionCode: 'DENY_PROHIBITED',
        rationale: 'Action is strictly prohibited by platform security policy (AUTH-5).',
      };
    }

    // 3. Approval Gate: AUTH-4 is a routing verdict, not a rank. The prepared action is
    //    handed to SCR-003 for a signed human decision; the agent never executes it.
    //    Evaluated BEFORE rank comparison so an agent capped at AUTH-0..AUTH-3 can still
    //    submit high-risk work for sign-off; which agents may submit a given skill at all
    //    is enforced by the registry's `allowed_agents` binding (§05), not by rank.
    if (requiredAuthority === 'AUTH-4') {
      const ticketId = await this.routeToApprovalQueue(context, proposal);
      return {
        authorized: false,
        decisionCode: 'REQUIRE_HUMAN_APPROVAL',
        rationale: 'Skill is designated AUTH-4 and requires a signed human decision via SCR-003.',
        approvalTicketId: ticketId,
      };
    }

    // 4. Autonomous Privilege Escalation Defense (BR-008, NFR-001)
    //    Applies only to the ranked autonomous levels AUTH-0..AUTH-3, and runs
    //    BEFORE the tenant-limit branch so an under-privileged agent cannot
    //    launder an action it was never allowed to propose through the approval
    //    gate. (AUTH-4 skills already routed above, which is what lets a capped
    //    agent submit high-risk work for human sign-off.)
    const agentRank = AUTONOMOUS_AUTHORITY_RANK[context.agentAssignedAuthority];
    const requiredRank = AUTONOMOUS_AUTHORITY_RANK[requiredAuthority];
    if (agentRank === undefined || requiredRank === undefined || requiredRank > agentRank) {
      await this.recordSecurityViolation(context, proposal, 'PRIVILEGE_ESCALATION_BLOCKED');
      return {
        authorized: false,
        decisionCode: 'DENY_PROHIBITED',
        rationale: `Privilege escalation blocked (BR-008): Agent ${context.agentId} has assigned authority ${context.agentAssignedAuthority} but the action requires ${requiredAuthority}.`,
      };
    }

    // 5. Tenant autonomy limits: a within-authority action that breaches a
    //    Business/Finance-approved limit routes to the same AUTH-4 approval gate.
    //    Unset limits fail closed.
    const breachedPolicyField = this.findBreachedPolicyField(context, proposal);
    if (breachedPolicyField !== null) {
      const ticketId = await this.routeToApprovalQueue(context, proposal);
      return {
        authorized: false,
        decisionCode: 'REQUIRE_HUMAN_APPROVAL',
        rationale: `Action breaches tenant autonomy limit '${breachedPolicyField}' and requires human sign-off via SCR-003.`,
        approvalTicketId: ticketId,
      };
    }

    // 6. Rate Limit & Bounded Checks for AUTH-3
    if (requiredAuthority === 'AUTH-3') {
      const bounded = await this.verifyBoundedParameters(context, proposal);
      if (!bounded.valid) {
        return {
          authorized: false,
          decisionCode: 'LIMIT_EXCEEDED',
          rationale: bounded.reason,
        };
      }
    }

    // 7. Default Permit for verified AUTH-0..AUTH-3 within authorized bounds
    return {
      authorized: true,
      decisionCode: 'PERMIT',
      rationale: 'Action satisfies authority bounds and operational constraints.',
    };
  }

  /**
   * Returns the name of the first tenant autonomy limit breached by the payload,
   * or `null` when the action stays inside every approved limit.
   *
   * The thresholds themselves are NEVER hardcoded here: they are tenant policy
   * parameters owned by Business/Finance ([UNCONFIRMED][ASM-003/004]). An
   * unapproved (undefined) limit cannot authorize autonomy, so it fails closed
   * by routing the action to human approval.
   */
  private findBreachedPolicyField(context: SecurityContext, proposal: ActionProposal): string | null {
    const policy = this.resolveTenantPolicy(context.tenantId);
    const payload = proposal.payload;

    if (typeof payload.discountRate === 'number') {
      if (
        policy.maxAutonomousDiscountRate === undefined ||
        payload.discountRate > policy.maxAutonomousDiscountRate
      ) {
        return 'maxAutonomousDiscountRate';
      }
    }

    if (typeof payload.refundAmount === 'number') {
      if (
        policy.maxAutonomousRefundAmount === undefined ||
        payload.refundAmount > policy.maxAutonomousRefundAmount
      ) {
        return 'maxAutonomousRefundAmount';
      }
    }

    if (typeof payload.audienceSize === 'number') {
      if (
        policy.maxAutonomousAudienceSize === undefined ||
        payload.audienceSize > policy.maxAutonomousAudienceSize
      ) {
        return 'maxAutonomousAudienceSize';
      }
    }

    return null;
  }

  /**
   * Loads the tenant's owner-approved autonomy limits from tenant configuration.
   * The runtime binds this to the tenant configuration store; the platform ships
   * no default thresholds. An empty result means the tenant has not yet approved
   * any autonomy limit, which fails closed: every thresholded action routes to
   * human approval rather than executing autonomously.
   */
  private resolveTenantPolicy(tenantId: string): TenantPolicyParameters {
    return this.tenantPolicyStore.get(tenantId) ?? {};
  }

  private async verifyBoundedParameters(
    context: SecurityContext,
    proposal: ActionProposal
  ): Promise<{ valid: boolean; reason: string }> {
    // Example: enforce the tenant's messaging frequency cap. The cap is a
    // tenant-configured suppression parameter; the fallback is a provisional
    // design parameter, not an approved policy value.
    if (proposal.skillId === 'skill.sales.send_message') {
      const sentCount = (proposal.payload.previousAttempts as number) || 0;
      const policy = this.resolveTenantPolicy(context.tenantId);
      const maxReminders = policy.maxAutonomousReminderCount ?? DEFAULT_AUTONOMOUS_REMINDER_CAP;
      if (sentCount >= maxReminders) {
        return {
          valid: false,
          reason: `Suppression rule: tenant messaging frequency cap (${maxReminders}) exceeded.`,
        };
      }
    }
    return { valid: true, reason: '' };
  }

  /**
   * Creates the PENDING human-authorization row for an AUTH-4 gate and returns the
   * ticket reference surfaced to SCR-003.
   *
   * Per §03, the single canonical record is `agentos.approvals`; `approval_queue`
   * is a read-only VIEW over its PENDING rows, not a second table. The row is
   * unique per `(tenant_id, effect_key)` so one approval can never authorize two
   * executions, and the decision is written in the same transaction that resumes
   * the durable task.
   */
  private async routeToApprovalQueue(context: SecurityContext, proposal: ActionProposal): Promise<string> {
    // INSERT INTO agentos.approvals (tenant_id, run_id, action_id, effect_key,
    //   authority_required, payload, reason, decision)
    // VALUES ($1, $2, $3, $4, 'AUTH-4', $5, $6, 'PENDING')
    // RETURNING id;
    return `APV-${context.tenantId.substring(0, 4)}-${Date.now()}`;
  }

  private async recordSecurityViolation(
    context: SecurityContext,
    proposal: ActionProposal,
    violationType: string
  ): Promise<void> {
    // Dispatches the security violation as an immutable record to the canonical
    // agentos.audit_records table (§4.1, execution_status = 'denied') and raises the
    // security alert; the in-memory chain state for the tenant is not mutated here.
  }

  /**
   * Reads the authoritative required authority for a skill from the server-side
   * Skill Registry (§03 `skills.required_authority`, which accepts
   * 'AUTH-0'..'AUTH-4'; AUTH-5 is never a requirement, only a deny verdict).
   *
   * A missing registry entry returns `undefined`. `enforce` then falls back to the
   * proposal's own `requiredAuthority`. That fallback is safe - and deliberately not
   * "trust the model" - because the Orchestrator, never the agent or the LLM,
   * constructs the proposal; the autonomous rank check and the AUTH-4/AUTH-5 verdict
   * branches still apply, so an unregistered skill can never be used to exceed the
   * agent's assigned clearance. Which agents may invoke a registered skill at all is
   * bound by `skills.allowed_agents` (§03/§05), independently of this lookup.
   */
  private lookupSkillAuthority(skillId: string): AuthorityLevel | undefined {
    return this.skillRegistry.get(skillId);
  }
}
```

---

## 2. Business Rules Engine (BR-001 to BR-010)

The Business Rules Engine provides a deterministic, non-LLM validation pipeline that audits every action payload before execution. Every rule is evaluated in sequence. If any rule fails, execution halts immediately with a typed error contract.

```
Action Context ---> [ BR-001: Zero Arbitrary Pricing       ] ---> PASS
               ---> [ BR-002: Hard Floor Price Boundary    ] ---> PASS
               ---> [ BR-003: Authoritative ERP Source      ] ---> PASS
               ---> [ BR-004: Mandatory Prior Consent      ] ---> PASS
               ---> [ BR-005: Idempotent Unique Effect Key ] ---> PASS
               ---> [ BR-006: Non-Duplicating Retries      ] ---> PASS
               ---> [ BR-007: Human Financial Approval     ] ---> PASS
               ---> [ BR-008: Strict Authority Boundaries  ] ---> PASS
               ---> [ BR-009: Prompt Injection Resilience  ] ---> PASS
               ---> [ BR-010: Immutable Evidence Record    ] ---> PASS ---> DISPATCH
```

### 2.1 Exhaustive Business Rules Specification

#### BR-001: Zero Arbitrary Pricing
- **Specification**: AI agents are strictly forbidden from generating or suggesting product prices dynamically from internal LLM reasoning.
- **Enforcement**: Any pricing data present in a response must directly reference an authenticated catalog SKU record. If a price payload lacks a valid ERP/POS catalog reference ID, the action is rejected.

#### BR-002: Hard Floor Price Boundary ($P_{floor}$)
- **Specification**: No promotional discount, bundle subsidy, or cart recovery coupon may produce an effective net price below the mathematical floor price. The invariant is $P \ge P_{floor}$; any proposed transaction with $P < P_{floor}$ is rejected.
- **Enforcement**: The floor is derived from the tenant's **owner-approved ERP/POS/Web/App policy inputs** (see §3.1); ERP/POS/Web/App remain the Systems of Record for the actual price, discount, and inventory, and the floor engine is not a parallel source of truth. Any transaction with $P < P_{floor}$ is blocked. When the cost/margin policy inputs are missing or unapproved, the engine fails closed instead of permitting the discount.

#### BR-003: Authoritative System of Record Pricing & Inventory
- **Specification**: Real-time product pricing, stock availability, and logistics statuses must be fetched synchronously from the System of Record (ERP/WMS via API-001).
- **Enforcement**: Cached inventory records older than the tenant's configured freshness window (a provisional design parameter; the illustrative value is 120 seconds) are marked invalid. If the ERP is unreachable, the system fails closed (zero stock assumed).

#### BR-004: Mandatory Prior Consent Verification & Suppression
- **Specification**: Outbound marketing communications are strictly forbidden without verified, unrevoked consent for the specified channel.
- **Enforcement**: The pipeline checks the customer consent registry before dispatch. If `marketing_consent == false` or `opted_out == true`, the message is suppressed silently without retrying.

#### BR-005: Idempotent External Actions via Deterministic `effect_key`
- **Specification**: Every mutational external operation (sending a LINE message, charging a card, creating an order) must carry a deterministic unique `effect_key`.
- **Enforcement**: Generated as:
  $$\text{effect\_key} = \text{SHA256}(\text{tenant\_id} + \text{customer\_id} + \text{action\_type} + \text{unique\_context\_id})$$
  Downstream adapters enforce unique key constraints. Duplicate keys return cached execution receipts.

#### BR-006: Non-Duplicating Retry Policies
- **Specification**: Automated network retries must never generate duplicate downstream orders, payments, or messages.
- **Enforcement**: Retries reuse the identical `effect_key`. Connectors check for prior execution receipts before resending.

#### BR-007: Mandatory Human Approval for Financial & Policy Risk
- **Specification**: Financial compensations, refunds, warranty policy overrides, and mass broadcasts strictly require human authorization. Whether a given amount, rate, or audience size is "high risk" is decided by the tenant's own **policy parameters** - maximum autonomous discount rate and broadcast audience (**[UNCONFIRMED][ASM-003]**), and maximum autonomous refund/compensation amount (**[UNCONFIRMED][ASM-004]**) - owned by Business/Finance and **not yet approved**. The blueprint deliberately ships **no** platform-wide numeric thresholds; every cited figure is an illustrative placeholder until those owner-approved values are locked for the tenant.
- **Enforcement**: The PEP (AUTH-4 gate) traps execution and generates an approval task in SCR-003. An action whose relevant policy parameter is unset fails closed and is routed to approval rather than executed.

#### BR-008: Strict Server-Side Authority Boundaries
- **Specification**: Agents cannot exceed their designated autonomous authority (`AUTH-0` to `AUTH-3`), even if the LLM reasoning claims authorization. `AUTH-4` and `AUTH-5` are not ranks to be exceeded: `AUTH-4` routes the prepared action to the SCR-003 approval gate, and `AUTH-5` is a hard deny that terminates it. No accumulation of rank ever reaches `AUTH-5`.
- **Enforcement**: The Orchestrator strictly ignores self-asserted permissions. Authority mapping is statically bound to the authenticated agent definition in PostgreSQL - `agents.assigned_authority` only accepts `AUTH-0`..`AUTH-3` (§03), while `skills.required_authority` accepts `AUTH-0`..`AUTH-4`. The PEP evaluates the `AUTH-5` deny and the `AUTH-4` approval route before it compares the numeric rank of the four autonomous levels, so a capped agent submits high-risk work for human sign-off instead of executing it or being silently escalated.

#### BR-009: Prompt Injection Resilience & Privilege Isolation
- **Specification**: User-supplied input (e.g., customer chat prompts or uploaded documents) cannot modify system policies, alter floor prices, or grant elevated privileges.
- **Enforcement**: Multi-layered defense: (1) Inputs are treated strictly as untrusted string literals within isolated data envelopes; (2) Canary token tracking detects boundary leakage; (3) System prompt instructions and tools run in separate execution contexts; (4) Privilege elevation attempts inside prompts are intercepted and neutralized by the PEP prior to tool dispatch.

#### BR-010: Immutable Evidence Record Attachment
- **Specification**: Every successful business transaction must produce an Evidence Record containing raw upstream API receipts, timestamps, and correlation IDs.
- **Enforcement**: Orchestrator will not mark a task `completed` unless a verified Evidence Record is committed to `agentos.evidence_records` (§03 DOMAIN 5) and referenced from the run's `agentos.audit_records` row (§4.1, field 14 `evidence`).

### 2.2 Business Rules Pipeline Implementation
```typescript
/**
 * @file governance/BusinessRulesEngine.ts
 * Deterministic business rules validation pipeline.
 */

import {
  AUTONOMOUS_AUTHORITY_RANK,
  type AuthorityLevel,
  type TenantPolicyParameters,
} from './PolicyEnforcementPoint';

/**
 * Provisional fallback for BR-003 when a tenant has not configured its own
 * inventory freshness window. Not an approved policy value.
 */
const DEFAULT_INVENTORY_CACHE_MAX_AGE_MS = 120_000;

export interface RuleEvaluationResult {
  readonly ruleId: string;
  readonly passed: boolean;
  readonly errorCode?: string;
  readonly failureReason?: string;
}

export interface RuleContext {
  readonly tenantId: string;
  readonly agentId: string;
  /** Only AUTH-0..AUTH-3 are ever assigned; AUTH-4/AUTH-5 are verdicts, not ranks. */
  readonly agentAssignedAuthority: 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3';
  readonly requiredAuthority?: AuthorityLevel;
  /**
   * Owner-approved tenant autonomy limits ([UNCONFIRMED][ASM-003/004]).
   * An omitted field means "no approved limit", which fails closed.
   */
  readonly tenantPolicy: TenantPolicyParameters;
  readonly customerConsent: {
    readonly marketingAllowed: boolean;
    readonly optOutRecorded: boolean;
  };
  readonly pricing?: {
    readonly basePrice: number;
    readonly offeredPrice: number;
    readonly floorPrice: number;
    readonly catalogRefId?: string;
    readonly inventoryCacheTimestamp?: number; // Epoch timestamp in ms
    readonly inventoryCacheMaxAgeMs?: number; // Tenant-configured freshness window
  };
  readonly effectKey?: string;
  readonly priorExecutionReceipt?: {
    readonly effectKey: string;
    readonly executedAt: string;
    readonly status: 'SUCCESS' | 'FAILED';
  } | null;
  readonly financialRisk?: {
    readonly refundAmount?: number;
    readonly discountRate?: number;
    readonly policyModification?: boolean;
    readonly hasSignedApprovalToken?: boolean;
  };
  readonly evidenceRecordRef?: {
    readonly evidenceId: string;
    readonly sourceOfTruth: string;
    readonly verified: boolean;
  } | null;
  readonly isTaskCompletion?: boolean;
  readonly userPrompt?: string;
}

export class BusinessRulesEngine {
  public validate(context: RuleContext): readonly RuleEvaluationResult[] {
    return [
      this.evaluateBR001(context),
      this.evaluateBR002(context),
      this.evaluateBR003(context),
      this.evaluateBR004(context),
      this.evaluateBR005(context),
      this.evaluateBR006(context),
      this.evaluateBR007(context),
      this.evaluateBR008(context),
      this.evaluateBR009(context),
      this.evaluateBR010(context),
    ];
  }

  private evaluateBR001(ctx: RuleContext): RuleEvaluationResult {
    if (ctx.pricing && !ctx.pricing.catalogRefId) {
      return {
        ruleId: 'BR-001',
        passed: false,
        errorCode: 'ERR_ARBITRARY_PRICING',
        failureReason: 'Offered price has no authoritative ERP catalog reference ID.',
      };
    }
    return { ruleId: 'BR-001', passed: true };
  }

  private evaluateBR002(ctx: RuleContext): RuleEvaluationResult {
    if (ctx.pricing && ctx.pricing.offeredPrice < ctx.pricing.floorPrice) {
      return {
        ruleId: 'BR-002',
        passed: false,
        errorCode: 'ERR_FLOOR_PRICE_VIOLATION',
        failureReason: `Offered price (${ctx.pricing.offeredPrice}) violates P_floor boundary (${ctx.pricing.floorPrice}).`,
      };
    }
    return { ruleId: 'BR-002', passed: true };
  }

  private evaluateBR003(ctx: RuleContext): RuleEvaluationResult {
    if (ctx.pricing && ctx.pricing.inventoryCacheTimestamp) {
      const cacheAgeMs = Date.now() - ctx.pricing.inventoryCacheTimestamp;
      // Tenant-configured freshness window; the fallback is a provisional design
      // parameter, not a platform-approved policy value.
      const maxCacheAgeMs = ctx.pricing.inventoryCacheMaxAgeMs ?? DEFAULT_INVENTORY_CACHE_MAX_AGE_MS;
      if (cacheAgeMs > maxCacheAgeMs) {
        return {
          ruleId: 'BR-003',
          passed: false,
          errorCode: 'ERR_STALE_INVENTORY_CACHE',
          failureReason: `Inventory cache age (${Math.round(cacheAgeMs / 1000)}s) exceeds the configured freshness window (${Math.round(maxCacheAgeMs / 1000)}s). Fail Closed.`,
        };
      }
    }
    return { ruleId: 'BR-003', passed: true };
  }

  private evaluateBR004(ctx: RuleContext): RuleEvaluationResult {
    if (ctx.customerConsent.optOutRecorded || !ctx.customerConsent.marketingAllowed) {
      return {
        ruleId: 'BR-004',
        passed: false,
        errorCode: 'ERR_CONSENT_SUPPRESSED',
        failureReason: 'Customer has not granted valid marketing consent or has opted out.',
      };
    }
    return { ruleId: 'BR-004', passed: true };
  }

  private evaluateBR005(ctx: RuleContext): RuleEvaluationResult {
    if (!ctx.effectKey || ctx.effectKey.trim().length === 0) {
      return {
        ruleId: 'BR-005',
        passed: false,
        errorCode: 'ERR_MISSING_EFFECT_KEY',
        failureReason: 'External action lacks mandatory unique idempotency effect_key.',
      };
    }
    return { ruleId: 'BR-005', passed: true };
  }

  private evaluateBR006(ctx: RuleContext): RuleEvaluationResult {
    if (ctx.priorExecutionReceipt && ctx.priorExecutionReceipt.status === 'SUCCESS') {
      return {
        ruleId: 'BR-006',
        passed: false,
        errorCode: 'ERR_DUPLICATE_RETRY_BLOCKED',
        failureReason: `Action with effect_key ${ctx.priorExecutionReceipt.effectKey} was already executed at ${ctx.priorExecutionReceipt.executedAt}. Duplicate re-execution blocked.`,
      };
    }
    return { ruleId: 'BR-006', passed: true };
  }

  private evaluateBR007(ctx: RuleContext): RuleEvaluationResult {
    if (ctx.financialRisk) {
      const { refundAmount, discountRate, policyModification = false, hasSignedApprovalToken = false } = ctx.financialRisk;
      const policy = ctx.tenantPolicy;

      // A policy modification always needs human sign-off.
      // Amount/rate limits come from the tenant's approved policy parameters; an
      // unapproved (undefined) limit cannot authorize autonomy, so it fails closed.
      const reasons: string[] = [];
      if (policyModification) {
        reasons.push('policy modification');
      }
      if (refundAmount !== undefined) {
        if (policy.maxAutonomousRefundAmount === undefined || refundAmount > policy.maxAutonomousRefundAmount) {
          reasons.push(`refund ${refundAmount} outside approved autonomous limit`);
        }
      }
      if (discountRate !== undefined) {
        if (policy.maxAutonomousDiscountRate === undefined || discountRate > policy.maxAutonomousDiscountRate) {
          reasons.push(`discount rate ${discountRate} outside approved autonomous limit`);
        }
      }

      if (reasons.length > 0 && !hasSignedApprovalToken) {
        return {
          ruleId: 'BR-007',
          passed: false,
          errorCode: 'ERR_FINANCIAL_APPROVAL_REQUIRED',
          failureReason: `High-risk financial/policy action (${reasons.join('; ')}) strictly requires signed human approval (AUTH-4 via SCR-003).`,
        };
      }
    }
    return { ruleId: 'BR-007', passed: true };
  }

  private evaluateBR008(ctx: RuleContext): RuleEvaluationResult {
    if (!ctx.requiredAuthority) {
      return { ruleId: 'BR-008', passed: true };
    }

    // AUTH-5 is an immediate hard deny and is never reached by rank.
    if (ctx.requiredAuthority === 'AUTH-5') {
      return {
        ruleId: 'BR-008',
        passed: false,
        errorCode: 'ERR_PROHIBITED_ACTION',
        failureReason: 'Action is strictly prohibited by platform security policy (AUTH-5).',
      };
    }

    // AUTH-4 is an approval route, not a rank: it is handled by the BR-007 / PEP
    // approval gate and never evaluated as a numeric privilege comparison.
    if (ctx.requiredAuthority === 'AUTH-4') {
      return { ruleId: 'BR-008', passed: true };
    }

    const agentRank = AUTONOMOUS_AUTHORITY_RANK[ctx.agentAssignedAuthority];
    const reqRank = AUTONOMOUS_AUTHORITY_RANK[ctx.requiredAuthority];
    if (agentRank === undefined || reqRank === undefined || reqRank > agentRank) {
      return {
        ruleId: 'BR-008',
        passed: false,
        errorCode: 'ERR_AUTHORITY_BOUNDARY_EXCEEDED',
        failureReason: `Agent authority boundary exceeded: ${ctx.agentId} has ${ctx.agentAssignedAuthority} but requires ${ctx.requiredAuthority}.`,
      };
    }
    return { ruleId: 'BR-008', passed: true };
  }

  private evaluateBR009(ctx: RuleContext): RuleEvaluationResult {
    if (ctx.userPrompt) {
      // Regex heuristic for common prompt injection patterns attempting authority escalation
      const injectionPattern = /(ignore previous instructions|elevate privilege|system override|grant admin|set price to 0)/i;
      if (injectionPattern.test(ctx.userPrompt)) {
        return {
          ruleId: 'BR-009',
          passed: false,
          errorCode: 'ERR_INJECTION_DETECTED',
          failureReason: 'Prompt injection attempt detected; privilege escalation blocked.',
        };
      }
    }
    return { ruleId: 'BR-009', passed: true };
  }

  private evaluateBR010(ctx: RuleContext): RuleEvaluationResult {
    if (ctx.isTaskCompletion) {
      if (!ctx.evidenceRecordRef || !ctx.evidenceRecordRef.verified || !ctx.evidenceRecordRef.evidenceId) {
        return {
          ruleId: 'BR-010',
          passed: false,
          errorCode: 'ERR_MISSING_EVIDENCE_RECORD',
          failureReason: 'Task completion rejected: Mandatory verified Evidence Record is missing or unverified.',
        };
      }
    }
    return { ruleId: 'BR-010', passed: true };
  }
}
```

---

## 3. Mathematical Floor Price Engine (ECN-002 $P_{floor}$)

### 3.1 Mathematical Specification & Boundary Invariants
The Floor Price Engine is a **derived guardrail**, not a pricing source. Every input it consumes - catalog base price, unit variable cost, revenue-proportional fees, target margins, and the discount cap - comes from the tenant's **owner-approved ERP/POS/Web/App policy configuration**, and the authoritative price, discount, and inventory values always remain in those Systems of Record. The engine stores no catalog and serves no price of its own; it only rejects a proposed quote whose effective net price would fall below the owner-approved floor. It is therefore not a parallel source of truth, and its inputs remain subject to **[UNCONFIRMED][ASM-003/004]** until Business/Finance lock them for the tenant.

Within the Orchestrator, the engine is intended to guard automated discounting, promotional vouchers, cart recovery offers, and replenishment subscriptions; its ability to preserve contribution margin is a design objective to be validated against measured data, not an achieved result.

#### Governing Equations
The effective discounted selling price $P$ is bounded by:
$$P = P_{base} - D \quad \text{where} \quad 0 \le D \le D_{cap}$$

The unit contribution margin is defined as:
$$\text{Contribution Margin} = P \times (1 - r) - C$$

The deterministic floor price $P_{floor}$ integrates both absolute minimum margin $L$ and ratio-based margin $m$:
$$P_{floor\_abs} = \frac{C + L}{1 - r}$$
$$P_{floor\_ratio} = \frac{C}{1 - r - m} \quad (\text{for } r + m < 1.0)$$
$$P_{floor} = \max\left(P_{floor\_abs}, \; P_{floor\_ratio}, \; P_{base} - D_{cap}\right)$$

#### Parameter Definitions & Invariants
All parameters below are supplied by the tenant's owner-approved ERP/SoR policy configuration; the engine never invents or defaults them.
- $P_{base} \in \mathbb{R}^+$: The official base catalog listing price read from the System of Record (excluding taxes and separate freight).
- $C \in \mathbb{R}^+$: Total unit variable cost = $\text{COGS} + \text{Packaging} + \text{Fulfillment} + \text{Allocated AI Compute Cost} + \text{Return Reserve}$, each component supplied by the owner-approved cost policy.
  - The allocated AI compute allowance per consultation session (see NFR-010) is a **provisional design target** pending the ASM-002 baseline and the NFR-010 benchmark; it is tenant-configured, not a platform constant.
- $r \in [0, 1)$: Variable revenue-proportional deductions (payment gateway transaction fees, marketplace platform fees, affiliate commissions), per the tenant's approved fee schedule.
- $L \ge 0$: Minimum mandatory absolute net contribution margin required per unit sold (owner-approved, **[UNCONFIRMED][ASM-003]**).
- $m \ge 0$: Minimum required net contribution margin ratio (owner-approved, **[UNCONFIRMED][ASM-003]**; $r + m < 1$).
- $D_{cap} \ge 0$: Maximum absolute promotional discount authorized by the tenant's finance owner (**[UNCONFIRMED][ASM-003]**).

```
                             PRICE BOUNDARY CONTINUUM
+---------------------------------------------------------------------------------+
| $0.00         P_floor                        P_quoted                 P_base    |
|   |--------------|-------------------------------|-----------------------|      |
|   <-- ILLEGAL -->|<------- LEGAL DISCOUNT RANGE -------->|                      |
|   (Fail Closed)  | min acceptable price          actual offered price    list   |
+---------------------------------------------------------------------------------+
```

### 3.2 Backend Floor Price Verification Service
The Floor Price Verification Service runs as a module within the Core Engine. It supports cryptographic HMAC signing of price quotes, distributed Redis budget holds, localized currency rounding, and strict Fail Closed enforcement. It holds **no** cost, margin, or discount-cap defaults: the caller supplies `UnitCostParameters` read from the tenant's owner-approved ERP/SoR policy, and missing or invalid inputs throw rather than defaulting.

```typescript
/**
 * @file pricing/FloorPriceEngine.ts
 * Deterministic Floor Price Verification Service with cryptographic quote signing.
 */
import crypto from 'crypto';
import Redis from 'ioredis';

export interface UnitCostParameters {
  readonly cogs: number;
  readonly fulfillment: number;
  readonly aiComputeCost: number;
  readonly returnReserve: number;
  readonly revenueFeeRatio: number; // r: revenue-proportional fee ratio, from the tenant's approved fee schedule
  readonly targetMargin: number; // L: Absolute margin (owner-approved, ASM-003)
  readonly minNetMarginRatio?: number; // m: Ratio margin (owner-approved, ASM-003); omitted when the owner has not set one
  readonly maxDiscountCap: number; // D_cap (owner-approved, ASM-003)
}

export interface QuoteRequest {
  readonly tenantId: string;
  readonly customerId: string;
  readonly sku: string;
  readonly basePrice: number;
  readonly proposedDiscount: number;
  readonly currency: string;
}

export interface SignedPriceQuote {
  readonly quoteId: string;
  readonly tenantId: string;
  readonly sku: string;
  readonly quotedPrice: number;
  readonly floorPrice: number;
  readonly discountApplied: number;
  readonly currency: string;
  readonly expiresAt: string; // ISO 8601 UTC
  readonly signature: string; // HMAC-SHA256
}

export class FloorPriceEngine {
  private readonly hmacSecret: string;
  private readonly redis: Redis;

  constructor(hmacSecret: string, redisClient: Redis) {
    this.hmacSecret = hmacSecret;
    this.redis = redisClient;
  }

  /**
   * Applies country-specific currency rounding rules to prevent fraction-of-cent leakage.
   * - TWD: Round UP to 1 TWD integer.
   * - VND: Round UP to 1,000 VND.
   * - USD/EUR/GBP: Round UP to 2 decimal places (cents).
   */
  public roundCurrency(amount: number, currency = 'TWD'): number {
    switch (currency.toUpperCase()) {
      case 'TWD':
        return Math.ceil(amount);
      case 'VND':
        return Math.ceil(amount / 1000) * 1000;
      case 'USD':
      case 'EUR':
      case 'GBP':
      default:
        return Math.ceil(amount * 100) / 100;
    }
  }

  /**
   * Calculates the deterministic mathematical floor price.
   * Fail Closed (NFR-008): Throws if cost parameters are invalid or missing,
   * or if P_floor exceeds base listing price.
   */
  public calculateFloorPrice(
    basePrice: number,
    params: UnitCostParameters,
    currency = 'TWD'
  ): number {
    if (params.revenueFeeRatio >= 1.0 || params.revenueFeeRatio < 0) {
      throw new Error('Invalid revenueFeeRatio: must be in range [0, 1). Fail Closed.');
    }

    const totalVariableCostC =
      params.cogs + params.fulfillment + params.aiComputeCost + params.returnReserve;

    if (totalVariableCostC <= 0 || basePrice <= 0) {
      throw new Error('Invalid cost metrics: total variable cost and base price must be positive.');
    }

    // 1. P_floor_abs = (C + L) / (1 - r)
    const costPlusAbsMargin = (totalVariableCostC + params.targetMargin) / (1 - params.revenueFeeRatio);

    // 2. P_floor_ratio = C / (1 - r - m)
    let costPlusRatioMargin = 0;
    if (typeof params.minNetMarginRatio === 'number' && params.minNetMarginRatio > 0) {
      const denominator = 1 - params.revenueFeeRatio - params.minNetMarginRatio;
      if (denominator <= 0) {
        throw new Error('Invalid margin ratio: revenueFeeRatio + minNetMarginRatio >= 1. Fail Closed.');
      }
      costPlusRatioMargin = totalVariableCostC / denominator;
    }

    // 3. Max discount threshold = P_base - D_cap
    const maxDiscountThreshold = basePrice - params.maxDiscountCap;

    const rawFloor = Math.max(costPlusAbsMargin, costPlusRatioMargin, maxDiscountThreshold);

    // Fail-Closed Check: If P_floor > P_base, product cannot be discounted or sold at loss
    if (rawFloor > basePrice) {
      throw new Error(
        `Fail Closed (NFR-008): Calculated P_floor (${rawFloor}) exceeds base listing price (${basePrice}). Margin preservation breached.`
      );
    }

    // Apply country-specific rounding
    return this.roundCurrency(rawFloor, currency);
  }

  /**
   * Generates a cryptographically signed price quote with a 10-minute TTL.
   */
  public async generateSignedQuote(
    request: QuoteRequest,
    params: UnitCostParameters
  ): Promise<SignedPriceQuote> {
    const floorPrice = this.calculateFloorPrice(request.basePrice, params, request.currency);
    const offeredPrice = request.basePrice - request.proposedDiscount;

    // Hard Boundary Check: Rejects if discount penetrates floor price
    if (offeredPrice < floorPrice) {
      throw new Error(`Discount rejected: Offered price ${offeredPrice} is below P_floor ${floorPrice}.`);
    }

    const quoteId = `QUO-${crypto.randomUUID()}`;
    const ttlSeconds = 600; // 10-minute validity
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    // Sign quote with HMAC-SHA256
    const payloadToSign = `${quoteId}|${request.tenantId}|${request.sku}|${offeredPrice}|${request.currency}|${expiresAt}`;
    const signature = crypto.createHmac('sha256', this.hmacSecret).update(payloadToSign).digest('hex');

    // Store atomic budget hold in Redis
    const budgetKey = `budget:hold:${request.tenantId}:${quoteId}`;
    await this.redis.set(budgetKey, request.proposedDiscount.toString(), 'EX', ttlSeconds);

    return {
      quoteId,
      tenantId: request.tenantId,
      sku: request.sku,
      quotedPrice: offeredPrice,
      floorPrice,
      discountApplied: request.proposedDiscount,
      currency: request.currency,
      expiresAt,
      signature,
    };
  }

  /**
   * Verifies the cryptographic integrity and validity of a price quote at checkout.
   */
  public verifyQuoteSignature(quote: SignedPriceQuote): boolean {
    const now = new Date();
    if (new Date(quote.expiresAt) <= now) {
      return false; // Quote expired
    }

    const payloadToVerify = `${quote.quoteId}|${quote.tenantId}|${quote.sku}|${quote.quotedPrice}|${quote.currency}|${quote.expiresAt}`;
    const expectedSignature = crypto
      .createHmac('sha256', this.hmacSecret)
      .update(payloadToVerify)
      .digest('hex');

    return crypto.timingSafeEqual(Buffer.from(quote.signature), Buffer.from(expectedSignature));
  }
}
```

### 3.3 Foreign Exchange Safety Cushion (FX Rate Buffer)
For cross-border e-commerce (e.g., USD/TWD, JPY/TWD), currency fluctuations can erode real-time margins.
- **Mechanism**: The engine applies a configurable safety cushion to the variable cost component $C$:
  $$C_{adjusted} = C \times (1 + \text{FX\_Buffer})$$
  The buffer percentage is a tenant-configured parameter approved by Business/Finance (**[UNCONFIRMED][ASM-003]**); the blueprint does not fix a platform-wide value.
- **Expiration Guard**: If a customer checks out after the quote window expires, the system fetches the latest foreign exchange rates from API-001 and recalculates $P_{floor}$ before order creation.

---

## 4. Immutable Audit Logging Service

Taiwan PDPA, GDPR Article 30, and CCPA each impose audit-evidence obligations. The audit service is **designed to produce the evidence those regimes expect, subject to legal review and operational validation**; this blueprint asserts no achieved compliance and no production certification. It serves system non-functional requirements NFR-002 and NFR-006.

### 4.1 Canonical 18-Field Audit Schema

The 18 domain fields below are the SRS §17 audit fields. They are persisted verbatim as columns of `agentos.audit_records` (§03 DOMAIN 5), which additionally carries the surrogate primary key `id`, the event `timestamp`, and the two chaining columns `prev_hash` / `chain_hash`. The table is deliberately distinct from `agent_run_logs`.

| Field # | Column | Data Type | Description & Compliance Purpose |
|---|---|---|---|
| **1** | `run_id` | `VARCHAR(64)` | Unique execution run identifier. |
| **2** | `tenant_id` | `UUID` | Tenant identity. Mandatory on all records for strict tenant isolation. |
| **3** | `agent_id` | `VARCHAR(32)` | Executing agent identifier (`MKT-05`, `SAL-02`, `CS-01`). |
| **4** | `customer_or_entity_id`| `VARCHAR(64)` (Pseudonymized)| Salted hash or UUID of the customer/entity. No plaintext PII. |
| **5** | `trigger` | `VARCHAR(128)` | Triggering event (`cart.abandoned`, `order.lookup`, `message.received`). |
| **6** | `context` | `JSONB` | Snapshot of sanitized input context and verified customer tier. |
| **7** | `skill` | `VARCHAR(64)` | Skill invoked (`skill.sales.check_stock`, `skill.care.lookup_order`). |
| **8** | `tool` | `VARCHAR(64)` | Downstream connector called (`API-001.InventoryConnector`, `ADPT-TW-001`). |
| **9** | `decision` | `JSONB` | Orchestrator decision logic, reasoning summary, and confidence score. |
| **10**| `authority` | `VARCHAR(16)` | Applied authority level (`AUTH-0` through `AUTH-5`). |
| **11**| `approval` | `JSONB \| null` | Human approver record if AUTH-4: `{ approver_id, action, signed_at }`. |
| **12**| `action` | `JSONB` | Outbound payload containing unique `effect_key`. |
| **13**| `execution_status` | `VARCHAR(32)` | Status (`pending`, `executing`, `success`, `failed`, `denied`, `aborted`). |
| **14**| `evidence` | `JSONB` | Authoritative receipt from source system (ERP order ID, tracking number). |
| **15**| `outcome` | `JSONB \| null` | Business conversion outcome (`order_created`, `cart_recovered`). |
| **16**| `latency_ms` | `INT` | Total execution elapsed time in milliseconds. |
| **17**| `cost` | `JSONB` | Operational cost: `{ prompt_tokens, completion_tokens, cost_twd }`. |
| **18**| `error` | `JSONB \| null` | Error code, sanitized message, and failure stack trace (if any). |
| **\***| `timestamp` | `TIMESTAMPTZ` | Audit **event** time (the column is quoted as `"timestamp"` in SQL because it is a reserved word). |
| **\***| `prev_hash` | `CHAR(64)` | `chain_hash` of this tenant's immediately preceding record (`prev_hash` is `NOT NULL`; the genesis record uses 64 zeros). |
| **\***| `chain_hash` | `CHAR(64)` | SHA-256 digest chaining this record to its predecessor. `UNIQUE (tenant_id, chain_hash)`. |

### 4.2 Cryptographic Hash Chaining & Tamper Detection
Every audit record links to its immediate predecessor for the same `tenant_id` via SHA-256 chaining. Modifying or deleting any historical record invalidates all subsequent hashes for that tenant, which is what makes tampering detectable.

$$\text{chain\_hash}_n = \text{SHA256}\left(\text{prev\_hash}_n \parallel \text{CanonicalJSON}(\text{payload}_n) \parallel \text{timestamp}_n\right)$$

`payload_n` is the sanitized **18 domain fields** of §4.1 (the SRS §17 audit fields): it excludes the surrogate `id`, the chaining columns `prev_hash` / `chain_hash`, and the event `timestamp_n`, which enters the digest explicitly as the third input. The three inputs are joined with the `|` separator exactly as written above; the writer (`createChainedRecord`) and the verifier (`verifyChainIntegrity`) must use this identical construction, or every chain check fails.

`CanonicalJSON` is RFC 8785 (JSON Canonicalization Scheme) over `payload_n`, so the digest is reproducible; there is no per-record nonce, and `prev_hash` is the previous record's `chain_hash` (the genesis record uses 64 zeros). Chains are partitioned per `tenant_id` - never globally - so the tenant-level isolation layer of NFR-006 is preserved; the verifier rejects a sequence whose `tenant_id` changes between consecutive records. Writers for one tenant must therefore serialize on that tenant's chain (single-writer per run, or an explicit lock): the `UNIQUE (tenant_id, chain_hash)` constraint of `agentos.audit_records` (§03) is the backstop that rejects a forked chain instead of silently persisting it.

```
+--------------------------+         +--------------------------+
| Audit Block #1001        |         | Audit Block #1002        |
| - Run ID: run-99120      |         | - Run ID: run-99121      |
| - Tenant: ACME-01        |         | - Tenant: ACME-01        |
| - Action: Send LINE Msg  |         | - Action: Check Stock    |
| - PrevHash: 8a71...bc01  | ------> | - PrevHash: 4f12...e890  |
| - Hash:     4f12...e890  |         | - Hash:     9c33...112a  |
+--------------------------+         +--------------------------+
```

```typescript
/**
 * @file audit/CryptographicAuditLogger.ts
 * Cryptographically chained audit logging service with automated PII masking.
 */
import crypto from 'crypto';

export interface AuditRecordPayload {
  readonly runId: string;
  readonly tenantId: string;
  readonly agentId: string;
  readonly customerOrEntityId: string;
  readonly trigger: string;
  readonly context: Record<string, unknown>;
  readonly skill: string;
  readonly tool: string;
  readonly decision: Record<string, unknown>;
  readonly authority: 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5';
  readonly approval: Record<string, unknown> | null;
  readonly action: Record<string, unknown>;
  readonly executionStatus: 'pending' | 'executing' | 'success' | 'failed' | 'denied' | 'aborted';
  readonly evidence: Record<string, unknown>;
  readonly outcome: Record<string, unknown> | null;
  readonly latencyMs: number;
  readonly cost: { promptTokens: number; completionTokens: number; costTwd: number };
  readonly error: { code: string; message: string } | null;
  readonly timestamp: string;
}

export class CryptographicAuditLogger {
  // Hash chain partitioned independently per tenant_id: this preserves the
  // tenant-level isolation layer of NFR-006 (§03 RLS/namespace partitioning).
  // It is the additional platform layer - the customer-context isolation that
  // SRS §19 mandates is enforced upstream, before any context is loaded.
  private readonly tenantLastHash: Map<string, string> = new Map();
  private readonly salt: string;
  private readonly GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

  constructor(salt: string) {
    this.salt = salt;
  }

  /**
   * Retrieves the previous hash for a given tenant. Checks the in-memory cache first,
   * falling back to the most recent persisted record in `agentos.audit_records` so the
   * chain stays continuous across restarts. Ordered by the quoted event-time column
   * `"timestamp"` (the canonical column name in §03; there is no `created_at` here).
   */
  public async getPrevHashForTenant(
    tenantId: string,
    pgPool?: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ chain_hash: string }> }> }
  ): Promise<string> {
    const cached = this.tenantLastHash.get(tenantId);
    if (cached) return cached;

    if (pgPool) {
      const res = await pgPool.query(
        'SELECT chain_hash FROM agentos.audit_records WHERE tenant_id = $1 ORDER BY "timestamp" DESC, id DESC LIMIT 1',
        [tenantId]
      );
      if (res.rows.length > 0 && res.rows[0].chain_hash) {
        this.tenantLastHash.set(tenantId, res.rows[0].chain_hash);
        return res.rows[0].chain_hash;
      }
    }
    return this.GENESIS_HASH;
  }
  /**
   * Sanitizes PII fields and generates a cryptographically chained audit record partitioned by tenant_id.
   *
   * Async because the predecessor hash is read through `getPrevHashForTenant`, which falls back to
   * `agentos.audit_records` when this process holds no in-memory chain state (e.g. after a restart).
   * The digest binds exactly the documented inputs: prev_hash | CanonicalJSON(payload) | timestamp,
   * where `payload` is the sanitized record without the event `timestamp` (bound as the third input).
   */
  public async createChainedRecord(rawPayload: AuditRecordPayload): Promise<{
    readonly record: AuditRecordPayload;
    readonly chainHash: string;
    readonly prevHash: string;
  }> {
    const sanitizedPayload: AuditRecordPayload = {
      ...rawPayload,
      customerOrEntityId: this.pseudonymizeId(rawPayload.customerOrEntityId),
      context: this.maskPiiObject(rawPayload.context),
      action: this.maskPiiObject(rawPayload.action),
    };

    const prevHash = await this.getPrevHashForTenant(sanitizedPayload.tenantId);
    const { timestamp, ...chainedPayload } = sanitizedPayload;
    const serialized = this.canonicalizeJson(chainedPayload);
    const hashInput = `${prevHash}|${serialized}|${timestamp}`;
    const chainHash = crypto.createHash('sha256').update(hashInput).digest('hex');

    // Update tenant-specific hash chain state
    this.tenantLastHash.set(sanitizedPayload.tenantId, chainHash);

    return {
      record: sanitizedPayload,
      chainHash,
      prevHash,
    };
  }

  /**
   * RFC 8785 (JCS) canonicalization of the sanitized payload, so the chain digest is
   * reproducible regardless of property insertion order.
   */
  private canonicalizeJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map((v) => this.canonicalizeJson(v)).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${this.canonicalizeJson(v)}`).join(',')}}`;
  }

  /**
   * Persists an audit record and its chaining metadata to `agentos.audit_records` (§03 DOMAIN 5).
   * The column list mirrors the canonical table exactly, including `prev_hash`, `chain_hash`,
   * and the quoted reserved-word column `"timestamp"`.
   */
  public async persistToPostgres(
    pgPool: { query: (sql: string, params: unknown[]) => Promise<unknown> },
    entry: { record: AuditRecordPayload; chainHash: string; prevHash: string }
  ): Promise<void> {
    const sql = `
      INSERT INTO agentos.audit_records (
        run_id, tenant_id, agent_id, customer_or_entity_id, trigger,
        context, skill, tool, decision, authority, approval, action,
        execution_status, evidence, outcome, latency_ms, cost, error,
        "timestamp", prev_hash, chain_hash
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21
      )
    `;

    const r = entry.record;
    await pgPool.query(sql, [
      r.runId,
      r.tenantId,
      r.agentId,
      r.customerOrEntityId,
      r.trigger,
      JSON.stringify(r.context),
      r.skill,
      r.tool,
      JSON.stringify(r.decision),
      r.authority,
      r.approval ? JSON.stringify(r.approval) : null,
      JSON.stringify(r.action),
      r.executionStatus,
      JSON.stringify(r.evidence),
      r.outcome ? JSON.stringify(r.outcome) : null,
      r.latencyMs,
      JSON.stringify(r.cost),
      r.error ? JSON.stringify(r.error) : null,
      r.timestamp,
      entry.prevHash,
      entry.chainHash,
    ]);
  }

  /**
   * Validates integrity across a sequence of audit records for a single tenant.
   * Verification recomputes the same RFC 8785 digest the writer used.
   */
  public verifyChainIntegrity(
    entries: readonly { record: AuditRecordPayload; chainHash: string; prevHash: string }[]
  ): boolean {
    for (let i = 1; i < entries.length; i++) {
      const current = entries[i];
      const previous = entries[i - 1];

      if (current.record.tenantId !== previous.record.tenantId) {
        throw new Error('Cannot verify chain across mismatched tenant IDs. Chains must be isolated.');
      }

      if (current.prevHash !== previous.chainHash) {
        return false; // Broken link in hash chain
      }

      const { timestamp, ...chainedPayload } = current.record;
      const serialized = this.canonicalizeJson(chainedPayload);
      const expectedHash = crypto
        .createHash('sha256')
        .update(`${current.prevHash}|${serialized}|${timestamp}`)
        .digest('hex');

      if (current.chainHash !== expectedHash) {
        return false; // Record tampering detected
      }
    }
    return true;
  }

  private pseudonymizeId(id: string): string {
    return crypto.createHmac('sha256', this.salt).update(id).digest('hex').substring(0, 16);
  }

  private maskPiiObject(obj: Record<string, unknown>): Record<string, unknown> {
    const masked: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'string') {
        // Mask emails
        if (value.includes('@')) {
          masked[key] = value.replace(/(.{2})(.*)(@.*)/, '$1***$3');
          continue;
        }
        // Mask phone numbers (Taiwan & International)
        if (/\d{8,12}/.test(value)) {
          masked[key] = value.replace(/(\d{3})\d{4,6}(\d{2})/, '$1****$2');
          continue;
        }
      }
      masked[key] = value;
    }
    return masked;
  }
}
```

---

## 5. Non-Functional Requirements (NFR-001 to NFR-010) Verification Matrix

This matrix maps the 10 mandatory Non-Functional Requirements to the design target that satisfies them and the verification method intended to prove it. It is a **design commitment, not a report of achieved results**: nothing here has been measured in production, and no compliance certification is claimed. Numeric targets that are not fixed by the SRS are **provisional design targets** to be locked against measured baselines (ASM-002) and the named benchmarks before they may be quoted as SLAs.

| Requirement ID | NFR Domain | Specification Target | Verification Method & SLA Guard |
|---|---|---|---|
| **NFR-001** | **Security & Least Privilege** | Zero privilege escalation across `AUTH-0`..`AUTH-3`; prompt injection resilience; `AUTH-4` routes to human approval; `AUTH-5` is an immediate hard deny. | Automated adversarial penetration tests (`TC-E2E-006`); PEP interceptor unit tests. |
| **NFR-002** | **Auditability** | Every mutational operation recorded in `agentos.audit_records` with the 18-field canonical schema and SHA-256 hash chaining. | Daily cryptographic chain integrity sweep; zero unchained log entries. |
| **NFR-003** | **Idempotency & Durability**| Network retries with identical `effect_key` produce zero duplicate messages or transactions. | Chaos network fault injection testing (`TC-E2E-005`); database unique constraints. |
| **NFR-004** | **System Availability** | Core API and Storefront Widget endpoints remain available through retry, timeout, and recovery, excluding scheduled maintenance. A 99.9% uptime figure is a **provisional design target** pending the ASM-002 baseline, not a contractual SLA. | Multi-zone Kubernetes deployment with auto-healing pods and health check probes. |
| **NFR-005** | **Explainability & Transparency** | Qualification scores, recommendations, discounts, and routing decisions store logic `reason` and verified `evidence`. | Deterministic Decision audit logs; structured evidence separation contracts. |
| **NFR-006** | **Data Isolation (Customer Context) — MUST** | SRS §19 semantic: **data belonging to verified customer A must never appear in the context of customer B.** Every context load, session memory, and prompt carries data for the single verified customer of the current session only, and identity verification (`TC-E2E-004`) must complete before any profile or order lookup. Tenant-to-tenant isolation is an **additional, independent platform requirement layered on top of** this customer-level isolation — it does not replace or weaken it. | Automated cross-tenant and cross-customer isolation test suite (`TC-NFR-006` / `TC-DATA-001`) running in CI, covering PostgreSQL RLS, Redis key namespaces, vector collections, and AI context envelopes. |
| **NFR-007** | **Human-in-the-Loop** | Operations classified `AUTH-4` halt synchronously in `awaiting_human` until a signed human decision; Takeover mutex locks the bot out of business replies. | End-to-end integration tests verifying zero autonomous execution for `AUTH-4` skills. |
| **NFR-008** | **Fail Closed Behavior** | In the event of system failure, timeout, missing authority, unverified price/inventory/consent, or an unapproved tenant policy limit, execution fails closed and escalates to a human. | Mock service outage test: pricing engine blocks discount and falls back to $P_{base}$; unset policy parameter routes to SCR-003. |
| **NFR-009** | **Performance & Latency** | Conversational responses are designed for near-real-time interaction. Any concrete figure - e.g. median < 2.0s, p95 < 3.0s, API routing < 200ms - is a **provisional design target pending the ASM-002 baseline and the NFR-009 benchmark**, which is what locks the official SLA. | Real-time Prometheus/Grafana p95 latency alarms; CDN edge acceleration; benchmark harness run per SRS §19 before any SLA commitment. |
| **NFR-010** | **Cost Observability & Resource Limits**| Token, model, API/tool cost, cost/run, cost/customer, and cost/conversion are instrumented and attributable per tenant and per run. The 0.50 - 1.00 TWD per-dialogue figure is a **provisional design target pending the ASM-002 cost baseline and the NFR-010 benchmark**; it is a tenant-configured budget, not a committed cap. | Token usage accounting middleware; automatic session throttling upon budget breach. |

---

## 6. Economic Incentive Mechanisms & Anti-Sybil Defense

> **Provisional figures.** Every percentage, monetary amount, day count, and quota in this section is an **illustrative placeholder of the proposed design**, not an approved or measured value. The subsidy source ratio, basket cap, minimum-spend multiple, and reward quotas are **tenant policy parameters** owned by Business/Finance and only take effect once locked under **[UNCONFIRMED][ASM-003]** (discount and promotion thresholds) and **[UNCONFIRMED][ASM-004]** (refund and compensation approval). Commission-reallocation ratios are additionally market assumptions that require measurement against the merchant's real cost structure.

### 6.1 ECN-001: Sales Commission Reallocation & Instant Dynamic Subsidy (AI 智能即時補貼)

The design reallocates human sales commissions to real-time closing subsidies instead of the traditional pattern of ad-hoc, arbitrary discounting.

```
+-----------------------------------------------------------------------------+
| TRADITIONAL DISORGANIZED DISCOUNTING vs DETERMINISTIC ECN-001 COMMISSION POOL|
|                                                                             |
| Traditional: AI haggles arbitrarily -> Erodes margin -> Suspected of fraud  |
|                                                                             |
| ECN-001:                                                                    |
| Human Sales Commission Pool (ratio tenant-configured, ASM-003)              |
|      |                                                                      |
|      v (When AI qualifies lead & detects genuine price sensitivity)         |
| Reallocated to AI Instant Dynamic Subsidy (AI 智能即時補貼)                  |
|      |                                                                      |
|      v (Locked with 10-Minute TTL HMAC Token + P_floor Verification)        |
| Converted into 1-Click Order Confirmation (Line Pay / 7-Eleven CVS COD)     |
+-----------------------------------------------------------------------------+
```

1. **Selective Subsidy Triggering (Silence for Price-Insensitive Buyers)**:
   - If a customer inquires about technical specifications, compatibility, warranties, or delivery timelines, the AI focuses exclusively on value consulting at full list price ($P_{base}$).
   - Subsidies are triggered only upon explicit price-sensitivity markers (e.g., *"giá hơi cao"*, *"vượt ngân sách"*, *"太貴"*, *"有優惠嗎"*).
2. **Localization & Anti-Fraud Positioning (Taiwan Consumer Culture)**:
   - Taiwan consumers are hyper-vigilant against online scam websites (詐騙網站). Conversational haggling (討價還價) severely degrades official brand trust.
   - The platform strictly bans the word "Bargain/Haggle". Instead, it frames offers as:
     - **AI Instant Dynamic Subsidy (AI 智能即時補貼)**
     - **LINE Member Flash Privilege (LINE 專屬快閃折抵)**
     - **Bonus LINE Points Reward (加碼送 LINE Points)**
   - UI prompts display the merchant's verified **Taiwan Unified Business Number (統一編號 - Tongyi Bianhao)** and **LINE Official Account Blue/Green Badge**.
3. **Atomic Quote TTL & Quota Limits**:
   - Subsidies are bounded by a validity window (`quote_ttl = 600s`); the 600-second value is a **blueprint design parameter, not an approved policy value**, and is tenant-configurable.
   - Scarcity is communicated transparently: *"3 subsidized slots unlocked for your session today"*. If unpaid when the validity window elapses, the budget reservation is released back to the tenant's commission pool.

### 6.2 ECN-004: Dynamic Loyalty Budgeting & Anti-Sybil Defense

The blueprint specifies a 4-factor identity check and tenant-configured basket caps to protect marketing budgets against multi-account coupon farming and arbitrage bots.

```
+-----------------------------------------------------------------------------+
|                4-FACTOR SYBIL IDENTITY RESOLUTION ENGINE                    |
|                                                                             |
|  [ Factor 1: Mobile Carrier OTP ]      [ Factor 2: Device Fingerprint Hash ]|
|                 \                                 /                         |
|                  v                               v                          |
|             +-----------------------------------------+                     |
|             | Unified Identity Cluster Resolution     |                     |
|             +-----------------------------------------+                     |
|                  ^                               ^                          |
|                 /                                 \                         |
|  [ Factor 3: Payment Instrument Hash ] [ Factor 4: Normalized Address Hash ]|
+-----------------------------------------------------------------------------+
```

1. **4-Factor Identity Cluster Resolution**:
   - **Carrier OTP**: Requires verified mobile phone number; virtual VOIP numbers are rejected.
   - **Device Hash**: SHA-256 hash of browser canvas, WebGL renderer, and screen resolution.
   - **Payment Fingerprint**: One-way salt-hashed token of credit card number or LINE Pay account ID.
   - **Normalized Address Hash**: Parsed and standardized delivery address (e.g. Taiwan 3+3 postal code standard) to detect apartment/unit variation tricks.
2. **Anti-Arbitrage Guardrails**:
   - **Basket Cap**: The maximum promotional deduction per order is a tenant-configured limit (**[UNCONFIRMED][ASM-003]**); no platform-wide cap exists in this blueprint.
   - **Minimum Spend Rule**: The minimum-spend multiple relative to the voucher value is a tenant-configured policy parameter, not a fixed platform constant.
   - **Category Exclusion**: high-ticket durable assets (e.g., EV Scooters) are excluded from percentage-based discount vouchers **by tenant/product policy**; only fixed-amount accessories or official government subsidy guidance may be applied. The blueprint fixes no category list of its own.

