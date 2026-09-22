# Implement 08: Security, Governance & Non-Functional Requirements (NFR) Engine

> **BLUEPRINT STATUS — target blueprint; NOT IMPLEMENTED, DEPLOYED, MEASURED, or runtime evidence.**
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
> All code, SQL, formulas, diagrams, and verification examples are **target snippets** `[BLUEPRINT][NOT-RUNTIME-EVIDENCE]`. SRS §12/§13/§17/§19 supply the authority, business-rule, audit, and NFR requirements; concrete mechanisms belong to this owner document. Optional economics are not SRS requirements.

## 1. Authority Model & Policy Enforcement Point (PEP)

The target zero-trust design treats model/customer content as proposals, never credentials. SRS §12 / AUTH-0..5 and §13 / BR-008/009 require server-side authority enforcement; the PEP evaluates a proposal before approval queueing and again before an external effect. `PASS`/`ALLOW` in the diagrams below denote future decision branches, not verification results.

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

| Authority label | Grant or verdict | Permitted target operations | Prohibited operations | Interceptor policy enforcement |
|---|---|---|---|---|
| **AUTH-0** | **Observe** | Read public catalogs, knowledge bases, read customer timeline (if verified). | Any write operation, customer profile modification, external messaging. | Rejects any invocation of mutational connectors (`db.write`, `api.post`). |
| **AUTH-1** | **Recommend** | Calculate match scores, generate product bundles, draft cross-sell hypotheses. | Publishing recommendations to external channels, creating orders. | Interceptor validates output schema; verifies payload is marked as hypothesis. |
| **AUTH-2** | **Draft** | Generate internal campaign copy, format draft support replies in Copilot mode. | Transmitting drafts to end customers or third-party networks. | Outbound dispatch blocked; stores payload in internal draft state store. |
| **AUTH-3** | **Bounded Execute** | Send transactional notifications, check real-time stock, query ERP order status. | Exceeding frequency caps, issuing unapproved discounts, modifying order data. | Checks parameter boundaries (tenant-configured frequency caps, rate limits, and stock thresholds; the concrete cap values are tenant policy, not platform constants). |
| **AUTH-4** | **Approval Required**| Prepare campaign broadcasts, discounts, compensations, refunds, and policy overrides that breach the tenant's configured autonomous limits (**[UNCONFIRMED][ASM-003/004]**). | Autonomous execution without cryptographically signed human approval. | Returns the `AUTH-4` routing verdict (never a grant); the orchestrator parks the run in `awaiting_human` and raises the SCR-003 queue row only after the applicable policy/consent/source/floor checks pass (§7.1). |
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
 * A lookup that misses (`undefined`) is an invalid, non-assignable or unknown
 * grant: it MUST be denied before any comparison, never coerced to rank 0 and
 * never read as "no requirement".
 */
export const AUTONOMOUS_AUTHORITY_RANK: Readonly<Record<string, number>> = Object.freeze({
  'AUTH-0': 0,
  'AUTH-1': 1,
  'AUTH-2': 2,
  'AUTH-3': 3,
});

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
  /**
   * Deny by default: an unknown skill, an invalid or unknown grant, an unknown
   * `required_authority`, or missing trusted input returns a deny/route code,
   * never `PERMIT`. `LIMIT_EXCEEDED` is the approval route for an action beyond
   * the tenant's configured autonomous limit, not an execution permit.
   */
  readonly decisionCode: 'PERMIT' | 'DENY_PROHIBITED' | 'REQUIRE_HUMAN_APPROVAL' | 'LIMIT_EXCEEDED';
  readonly rationale: string;
  readonly approvalTicketId?: string;
}

/** Target PEP boundary; concrete persistence and dispatch belong to 03/04/06. */
export interface PolicyEnforcementPoint {
  enforce(context: SecurityContext, proposal: ActionProposal): Promise<EnforcementDecision>;
}

/** Every result must come from a real tenant-scoped binding, never a generated receipt. */
export interface GovernanceDependencies {
  readonly registry: SkillAuthoritySource;
  readonly tenantPolicy: TenantPolicySource;
  readonly approvalStore: {
    createOrReadPending(binding: {
      tenantId: string;
      runId: string;
      effectKey: string;
      payloadDigest: string;
      requiredAuthority: 'AUTH-4';
    }): Promise<{ approvalId: string }>;
  };
  readonly audit: {
    appendDecision(context: SecurityContext, proposal: ActionProposal, decision: EnforcementDecision): Promise<void>;
  };
}
```

**Normative execution algorithm `[BLUEPRINT][SRS §11..13, §17, §19 / BR-007..010, NFR-008]`:** validate schema and verified tenant/session/subject; load the server registry; reject an unknown skill, an unlisted agent, an unknown or non-assignable `required_authority`, and an assigned grant outside `AUTH-0..3` - each fails closed before any route or rank is computed; apply hard-deny policy before considering approval. A missing registry entry is `UNKNOWN_SKILL`, never a fallback to `proposal.requiredAuthority`. Proposal authority and approval flags are descriptive inputs only and cannot authorize execution.

For required AUTH-0..3, compare the authenticated grant; for required AUTH-4, calculate an approval route without rank comparison. Evaluate trusted policy, consent, identity, source freshness, floor provenance, and takeover before creating an executable approval candidate. Missing policy cannot authorize dispatch. A human-resolution work item may describe missing input, but it is not an executable approval until the missing data is resolved. Re-read these checks on resume so a stale approval cannot outlive opt-out, price expiry, takeover, or policy revision. AUTH-5 never queues.

Queue creation uses the real `approvals` row from [03](./03-database-and-memory-schema.md), bound to `(tenant_id, run_id, effect_key, payload_digest)` with uniqueness and optimistic version checks. No timestamp-generated approval ID, synthetic success receipt, or no-op audit writer is permitted. The one-time claim and durable transition are committed together by [04](./04-core-engine-and-orchestrator.md). `MODIFY` invalidates the old payload authorization: the normalized new payload and its revision are explicitly reauthorized only after the full checks re-run, and a stale `expected_payload_sha256` conflicts before any claim. The PEP returns a verdict, never dispatches directly. Only the orchestrator may reserve an effect and invoke [06](./06-api-and-connectors-spec.md); audit persistence failure blocks new dispatch.

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

#### BR-002: No Price or Discount Change Outside Policy (SRS §13)
- **Requirement `[SRS-MUST]`**: AI cannot change price or discount outside the approved policy. A policy floor is one `[BLUEPRINT]` enforcement mechanism, not a new definition of the SRS rule.
- **Target enforcement**: reject a proposal outside the approved discount/price bounds, including an effective price below an owner-approved floor. No price-bearing action may dispatch without an owner-approved, provenance-bearing floor decision. The ERP-supplied and platform-derived models remain competing proposals in [README §8.1](./README.md#81-p_floor-ownership-and-formula--owner-decision-required); ownership/formula/mode/rounding remain `[OWNER-DECISION-REQUIRED]` for the Solution Architect and Business/Finance. Approval cannot legalize a sub-floor action or invent missing provenance.

#### BR-003: Authoritative System of Record Pricing & Inventory
- **Specification**: Real-time product pricing, stock availability, and logistics statuses must be fetched synchronously from the System of Record (ERP/WMS via API-001).
- **Target enforcement**: source freshness is a tenant-approved parameter, not the illustrative 120-second default. If price/inventory is unknown or the SoR is unreachable, return unavailable and refuse the dependent effect. Do not fabricate zero stock as a FACT or silently offer the base price.

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
- **Enforcement**: The `AUTH-4` verdict routes the prepared action to the SCR-003 approval gate; the orchestrator persists the one PENDING approval row and parks the run in `awaiting_human` (§04), while the PEP itself returns the verdict instead of dispatching. An action whose relevant policy parameter is unset fails closed and is routed to approval rather than executed.

#### BR-008: Strict Server-Side Authority Boundaries
- **Specification**: Agents cannot exceed their designated autonomous authority (`AUTH-0` to `AUTH-3`), even if the LLM reasoning claims authorization. `AUTH-4` and `AUTH-5` are not ranks to be exceeded: `AUTH-4` routes the prepared action to the SCR-003 approval gate, and `AUTH-5` is a hard deny that terminates it. No accumulation of rank ever reaches `AUTH-5`.
- **Enforcement**: The Orchestrator strictly ignores self-asserted permissions. Authority mapping is statically bound to the authenticated agent definition in PostgreSQL - `agents.assigned_authority` only accepts `AUTH-0`..`AUTH-3` (§03), while `skills.required_authority` accepts `AUTH-0`..`AUTH-4`. The PEP evaluates the `AUTH-5` deny and the `AUTH-4` approval route before it compares the numeric rank of the four autonomous levels, so a capped agent submits high-risk work for human sign-off instead of executing it or being silently escalated.

#### BR-009: Prompt Injection Resilience & Privilege Isolation
- **Specification**: User-supplied input (e.g., customer chat prompts or uploaded documents) cannot modify system policies, alter floor prices, or grant elevated privileges.
- **Enforcement**: Multi-layered defense: (1) Inputs are treated strictly as untrusted string literals within isolated data envelopes; (2) Canary token tracking detects boundary leakage; (3) System prompt instructions and tools run in separate execution contexts; (4) Privilege elevation attempts inside prompts are intercepted and neutralized by the PEP prior to tool dispatch.

#### BR-010: Immutable Evidence Record Attachment
- **Specification**: Every successful business transaction must produce an Evidence Record containing raw upstream API receipts, timestamps, and correlation IDs.
- **Enforcement**: Orchestrator will not mark a task `completed` unless a verified Evidence Record is committed to `agentos.evidence_records` (§03 DOMAIN 5) and referenced from the run's `agentos.audit_records` row (§4.1, field 14 `evidence`).

### 2.2 Business Rules Evaluation Contract `[BLUEPRINT][SRS §13 / BR-001..010]`

The ten rows in §8 are the rule contract. `validate` consumes the server-hydrated tenant/customer context, registry grant/verdict, versioned policy and consent, authoritative price/inventory references, approval binding, and durable effect reservation. It returns a typed `DENY`, `AWAITING_HUMAN_APPROVAL`, `REPLAY`, or `PERMIT` with rule IDs, reason and evidence references; this is not a substitute for the authority verdict names in [04](./04-core-engine-and-orchestrator.md).

1. Reject malformed/unbound context before loading private records. Registry lookup and allowed-agent checks precede rule evaluation; neither client flags nor model text supplies approval or consent.
2. Evaluate BR-008/009 hard denials before BR-007 routing. Unknown required authority fails closed; AUTH-4 does not compare numerically, AUTH-5 never queues. Injection-pattern matching may emit an alert but is not the security boundary: tool/schema/grant isolation must reject an attack that contains none of the example words.
3. Evaluate BR-001..004 against trusted sources. Missing fields are an error, never `passed: true`; unapproved freshness/discount/reminder parameters have no numeric fallback. Consent checks apply to marketing/outreach, not as a fabricated requirement to access public FAQ.
4. Resolve BR-005/006 using [04 effect reservations](./04-core-engine-and-orchestrator.md). An identical committed request returns its original receipt (`REPLAY`), not a duplicate error; a changed payload under the same key is `IDEMPOTENCY_CONFLICT`; indeterminate dispatch is reconciliation-only. No second effect follows expiry of a Redis cache.
5. An eligible AUTH-4 proposal pauses through the real approval store. For executable actions, the latest approval digest/version, tenant policy, consent and takeover state are checked immediately before reservation/dispatch. Exceeding an immutable safety rule cannot be approved away.
6. Persist the decision/audit intent before the effect; on adapter response, validate receipt and persist execution/evidence before success. BR-010 is a completion check, not a requirement to possess the future provider receipt before dispatch. Audit failure after a possible send records a pending reconciliation obligation and blocks blind retries; it does not retroactively undo the provider effect.

Failures return the stable code in §8 and a sanitized `correlation_id`; the caller follows [06 error envelopes](./06-api-and-connectors-spec.md). Read retries use bounded adapter deadlines; validation, consent and policy denial are not retryable without new trusted input. No rule may mutate a tenant policy or fabricate a provider response.

## 3. Mathematical Floor Price Engine (ECN-002 $P_{floor}$)

### 3.1 Mathematical Specification & Boundary Invariants
This section retains the **platform-derived competing candidate**, not a selected production formula. The other proposal is an authoritative ERP/policy-service floor plus provenance. The Solution Architect and Business/Finance must decide ownership, formula/margin mode, rounding, currency, freshness and provenance in [README §8.1](./README.md#81-p_floor-ownership-and-formula--owner-decision-required) `[OWNER-DECISION-REQUIRED]`. Both proposals leave catalog price and inventory in the SoR. No price-bearing action may dispatch without an owner-approved, provenance-bearing floor decision; no numeric default may be invented.

Within the Orchestrator, the engine is intended to guard automated discounting, promotional vouchers, cart recovery offers, and replenishment subscriptions; its ability to preserve contribution margin is a design objective to be validated against measured data, not an achieved result.

#### Governing Equations
The effective discounted selling price $P$ is bounded by:
$$P = P_{base} - D \quad \text{where} \quad 0 \le D \le D_{cap}$$

The unit contribution margin is defined as:
$$\text{Contribution Margin} = P \times (1 - r) - C$$

The following equations are a **platform-derived competing candidate**, not a canonical production formula. They MUST NOT be used to dispatch a price-bearing action until the owner decision in `README.md` §8.1 locks ownership, margin mode, rounding, currency, staleness, and provenance.

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
The following isolated target snippet illustrates the platform-derived candidate only. Its arithmetic, quote serialization, and illustrative TTL do not establish approved provenance and cannot be wired directly to a live checkout or adapter. Dispatch remains gated by §7.3 and the [04 action boundary](./04-core-engine-and-orchestrator.md); `UnitCostParameters` alone is not a trusted floor decision. The candidate must be replaced or completed according to the recorded owner decision before rollout; it is not an alternative production route.

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
  readonly minNetMarginRatio: number; // m: owner-approved, including explicit zero; absent fails closed
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
    if (!Number.isFinite(params.minNetMarginRatio) || params.minNetMarginRatio < 0) {
      throw new Error('P_FLOOR_UNAVAILABLE: owner-approved minNetMarginRatio is required.');
    }
    const denominator = 1 - params.revenueFeeRatio - params.minNetMarginRatio;
    if (denominator <= 0) {
      throw new Error('Invalid margin ratio: revenueFeeRatio + minNetMarginRatio >= 1. Fail Closed.');
    }
    const costPlusRatioMargin = totalVariableCostC / denominator;

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
   * Illustrative quote serialization with explicit owner-approved TTL, not dispatch authorization.
   */
  public async generateSignedQuote(
    request: QuoteRequest,
    params: UnitCostParameters,
    approvedTtlSeconds: number
  ): Promise<SignedPriceQuote> {
    if (!Number.isSafeInteger(approvedTtlSeconds) || approvedTtlSeconds <= 0) {
      throw new Error('P_FLOOR_UNAVAILABLE: owner-approved quote lifetime is required.');
    }
    const floorPrice = this.calculateFloorPrice(request.basePrice, params, request.currency);
    const offeredPrice = request.basePrice - request.proposedDiscount;

    // Hard Boundary Check: Rejects if discount penetrates floor price
    if (offeredPrice < floorPrice) {
      throw new Error(`Discount rejected: Offered price ${offeredPrice} is below P_floor ${floorPrice}.`);
    }

    const quoteId = `QUO-${crypto.randomUUID()}`;
    const ttlSeconds = approvedTtlSeconds;
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
This subsection belongs to the **platform-derived candidate only** (README §8.1); under the ERP/policy-service candidate the platform performs no currency derivation and only validates the supplied floor decision.
For cross-border e-commerce (e.g., USD/TWD, JPY/TWD), currency fluctuations can erode real-time margins.
- **Mechanism (candidate)**: The engine applies a configurable safety cushion to the variable cost component $C$:
  $$C_{adjusted} = C \times (1 + \text{FX\_Buffer})$$
  The buffer percentage is a tenant-configured parameter approved by Business/Finance (**[UNCONFIRMED][ASM-003]**); the blueprint does not fix a platform-wide value.
- **Expiration Guard**: A quote authorizes nothing after its validity window ends. An expired quote MUST be re-resolved against the owner-approved floor source and its freshness/provenance rules before order creation: under the platform-derived candidate that means recalculating $P_{floor}$ from refreshed owner-approved inputs, and under the ERP/policy-service candidate it means re-fetching the authoritative floor. Neither route may substitute a locally defaulted floor, and currency, rounding, and freshness handling remain `[OWNER-DECISION-REQUIRED]` (README §8.1).

---

## 4. Immutable Audit Logging Service

The audit target implements SRS §17 / NFR-002 and supports later legal review of jurisdiction-specific obligations. GDPR/CCPA/PDPA applicability and retention remain subject to Data/Legal/Product review under ASM-005. This blueprint asserts no achieved compliance or certification.

### 4.1 Audit Field Mapping `[SRS-MUST][SRS §17 / NFR-002]`

The SRS lists 18 run fields including Timestamp. The table below maps 17 non-time SRS fields plus the blueprint `tenant_id`; `timestamp` supplies the eighteenth SRS field. `id`, `prev_hash`, and `chain_hash` are persistence additions, not extra SRS minima. [03](./03-database-and-memory-schema.md) owns physical `agentos.audit_records`; `agent_run_logs` is a separate operational projection, never substitute evidence.

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
| **10**| `authority` | `VARCHAR(16)` | Applied grant/verdict label; `decision` separately records assigned grant, registry requirement and action verdict. AUTH-4/5 here are not agent grants. |
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

`payload_n` contains the sanitized 17 non-time SRS fields plus `tenant_id`; it excludes `id`, `prev_hash`, `chain_hash`, and event time. The byte contract is UTF-8 `prev_hash + "|" + CanonicalJSON(payload) + "|" + timestamp`, with UTC ISO timestamp serialized identically by writer and verifier. `CanonicalJSON` is RFC 8785 over validated finite JSON values; invalid Unicode/numbers are rejected, not silently converted. Masking happens before canonicalization; array order is preserved.

Chains are partitioned per tenant. Serialize each tenant's append under a database transaction/advisory lock, read the durable predecessor, hash, insert the record and commit before releasing the lock. A process-local map is not authoritative. `UNIQUE (tenant_id, chain_hash)` detects duplicate hashes but **does not prevent two distinct children of one predecessor**; tenant serialization is required. Verify the genesis record and every subsequent record against its predecessor, and compare the last hash against a separately retained trusted checkpoint to detect tail truncation. Verify failures stop affected mutations and raise an operator/security incident, never rewrite the chain.

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

### 4.3 Audit Append, Privacy, Rotation, and Recovery Contract `[BLUEPRINT][SRS §17, §19 / NFR-002, NFR-006, NFR-008]`

| Concern | Required input and target behavior | Failure / recovery evidence |
|---|---|---|
| Tenant/subject | Server-bound tenant/run/customer-or-entity, registry agent/skill/tool, sanitized trigger/context/decision/action | Missing binding refuses append and new dispatch; customer B cannot retrieve customer A's audit payload even within one tenant |
| Approval/status | Applied grant, required route and verdict in `decision`; exact approval ID/version/digest or explicit not-required; status uses the existing DDL enum | An indeterminate provider attempt is pending/failed with an UNKNOWN error detail, never `success`; receipt and durable reconciliation control settlement |
| Time/order | Service/database UTC clock supplies `timestamp`; provider `occurred_at` remains separate evidence metadata; monotonic timer supplies latency | Clock skew alarm blocks chronology-sensitive approval/quote checks; no customer-provided timestamp controls authorization; transaction order determines predecessor |
| PII/secrets | Allowlisted audit schema, recursive masking of objects/arrays, pseudonymous subject IDs; all free-text errors sanitized; raw provider data stored only in access-controlled evidence where ASM-005 allows | Secret/token/key values are rejected or removed before persistence/log export; verify nested payloads and exception stacks, not just top-level strings |
| Key rotation | KMS-managed pseudonymization/signing keys scoped by tenant and purpose; key ID/version in decision/evidence metadata; rotation event binds previous/new versions | No secret material in audit; retain protected verification material per legal retention. Revocation blocks new signatures, never rehashes historical records |
| Hash/checkpoint | RFC 8785 byte contract in §4.2; tenant-serialized append; checkpoint hash/export digest retained with restricted access | Recompute all entries including genesis; detect interior edit/removal/reorder and checkpoint-tail mismatch; isolate tenant and preserve forensic copy |
| Append-only storage | Application role INSERT/SELECT only for audit/evidence; migrations/retention use separately authorized role; evidence references bind run/effect/provider receipt and digest | No update/delete to make a failed chain pass. Use append-only correction records referring to the original; ASM-005 governs legal retention and minimized payloads |
| Audit unavailable before send | Commit pending intent, authority/policy verdict and effect reservation before outbound side effect | Refuse dispatch with `AUDIT_UNAVAILABLE`; bounded storage retry can resume only after durable intent is confirmed |
| Audit unavailable after send | Preserve attempt identity and possible-effect reservation; do not return a fabricated success or erase the external effect | Stop further mutation, reconcile provider/SoR by original `effect_key`, append recovered receipt/error before completing; no fresh-key retry |
| Cost/outcome | Persist token/model/API-tool cost with currency/rate version; unknown values explicitly pending rather than zero; outcome requires sourced attribution | Later cost/outcome is a linked append record. Conversion cannot be inferred from a model message or HTTP acceptance alone |

**Rollout prerequisites:** [01](./01-tech-stack-and-environment.md) secret/trust configuration; [03](./03-database-and-memory-schema.md) RLS and append-only permissions; [04](./04-core-engine-and-orchestrator.md) durable effect protocol; [06](./06-api-and-connectors-spec.md) real receipts; approved ASM-005 data classes. QA must demonstrate concurrent append, crash before/after commit, first-record tampering, cross-tenant read refusal, nested secret masking, rotation continuity and provider reconciliation before any gate sign-off.

---

## 5. Non-Functional Requirements (NFR-001 to NFR-010) Verification Matrix

This matrix specifies design mechanisms and future verification, not observed results. Owner roles are responsible for collecting runtime evidence; NFR-009/010 benchmark figures remain `[PROVISIONAL][ASM-002]`. SRS §19 requirements are not weakened by illustrative numeric targets.

| NFR / SRS §19 | Design mechanism and owner | Failure behavior | Future verification / evidence class |
|---|---|---|---|
| `NFR-001` Security | Backend/Security; PEP registry/grant/allowed-agent and trust boundaries in §7 | Deny unknown/unallowed context before queue or dispatch | TC-E2E-002/006; untrusted prompt/self-grant/unknown skill negatives; runtime invariant |
| `NFR-002` Auditability | Backend/Security + Data; §4 atomic intent/receipt append | No new dispatch without durable audit intent; a post-send audit gap is reconciled by `effect_key`, never read as proof the effect did not occur | TC-E2E-009; chain genesis/concurrency/tamper/checkpoint and external-effect completeness; invariant |
| `NFR-003` Idempotency | Backend/Integration; [04 effect protocol](./04-core-engine-and-orchestrator.md) and provider reconciliation | Same payload replays receipt; mismatch rejects; UNKNOWN never blindly retries | TC-E2E-005/008; compare provider ledger and durable reservations across restart/cache expiry; invariant |
| `NFR-004` Availability | Platform/AI Engineering; deadlines, durable checkpoints, fencing, bounded retries | Pause dependent work on outage; resume last committed state, not memory | Worker-kill/network-partition recovery with no lost trace; mechanisms required, uptime number provisional |
| `NFR-005` Explainability | AI Engineering; reason plus sourced evidence on decisions/recommendations | Missing grounding refuses important decision/action | TC-E2E-009; follow reason/evidence to trusted source, preserve FACT/HYPOTHESIS distinction; invariant |
| `NFR-006` Isolation | Data/Security; RLS plus subject/session checks, Redis prefixes, Qdrant filters | Missing tenant/verified subject refuses private retrieval | TC-E2E-004; positive owned records plus bidirectional customer/tenant refusal in prompt/cache/log/reply; invariant |
| `NFR-007` Human Override | Backend/Frontend; durable pause and takeover lease checked each step | Lease conflict/stale operator stops protected actions; no autonomous send during hold | SCR-005 race/restart/resume with no later unapproved effect; invariant |
| `NFR-008` Failure Safety | Backend/Security; authoritative price/stock/consent/authority and provenance checks | Fail closed with truthful unavailable status; never default base price, stock or approval | TC-E2E-003/007/008 and missing floor/policy; outage and restoration revalidate inputs; invariant |
| `NFR-009` Performance | Platform + Business; stage latency, end-to-end and queue metrics | Deadline classified by read vs possibly sent effect; overload limits admission, not safety checks | Representative load benchmark with p50/p95/p99, data volume and error/throughput; SLA only after baseline |
| `NFR-010` Cost Observability | AI Engineering + Business/Finance; token/model/tool costs linked to run/customer/conversion | Unavailable cost marked pending; owner-approved budget may stop new work, never erase receipt | Reconcile provider usage and known conversion denominators; measured coverage invariant, cost budgets provisional |

---

## 6. Economic Incentive Mechanisms & Anti-Sybil Defense

> **Provisional figures.** Every percentage, monetary amount, day count, and quota in this section is an **illustrative placeholder of the proposed design**, not an approved or measured value. The subsidy source ratio, basket cap, minimum-spend multiple, and reward quotas are **tenant policy parameters** owned by Business/Finance and only take effect once locked under **[UNCONFIRMED][ASM-003]** (discount and promotion thresholds) and **[UNCONFIRMED][ASM-004]** (refund and compensation approval). Commission-reallocation ratios are additionally market assumptions that require measurement against the merchant's real cost structure.
> `[OPTIONAL-EXTENSION]` ECN-001/004 are beyond SRS §1/§13. Enable only after tenant Business/Finance policy and ASM-003/004 sign-off; identity/fingerprint data additionally needs ASM-005 review. Their absence must not disable baseline Care/Sales/Marketing contracts. No illustrative quota, scarcity claim, identity factor, or local floor value enables an effect.

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
   - Scarcity wording may report only a server-verified remaining approved allocation, never the illustrative claim of three slots. An expired unpaid hold is released idempotently under the ledger/effect contract; expiry alone does not erase a possibly completed purchase.

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
   - **Payment Fingerprint**: Provider-issued opaque payment-method fingerprint only, under approved ASM-001/005 scope. Do not collect or hash raw card numbers in the AI platform.
   - **Normalized Address Hash**: Parsed and standardized delivery address (e.g. Taiwan 3+3 postal code standard) to detect apartment/unit variation tricks.
2. **Anti-Arbitrage Guardrails**:
   - **Basket Cap**: The maximum promotional deduction per order is a tenant-configured limit (**[UNCONFIRMED][ASM-003]**); no platform-wide cap exists in this blueprint.
   - **Minimum Spend Rule**: The minimum-spend multiple relative to the voucher value is a tenant-configured policy parameter, not a fixed platform constant.
   - **Category Exclusion**: high-ticket durable assets (e.g., EV Scooters) are excluded from percentage-based discount vouchers **by tenant/product policy**; only fixed-amount accessories or official government subsidy guidance may be applied. The blueprint fixes no category list of its own.


## 7. Threat Model, PEP Order, and Governance Contract `[SRS-MUST][SRS §12, §16, §17, §19 / NFR-001, NFR-002, NFR-006, NFR-008]`

This section owns security and governance semantics. It is target design only; snippets and matrices are `[NOT-RUNTIME-EVIDENCE]`.

| Trust boundary | Threats | Required controls |
|---|---|---|
| LLM prompt and customer input | prompt injection, data exfiltration, fabricated authority | untrusted envelope, schema/tool allowlist, PEP, no model-supplied identity/authority |
| Operator input and Command Center | privilege escalation, stale approval, cross-tenant disclosure | authenticated operator scope, optimistic version, one-time approval binding, audit |
| Browser/widget | token theft, origin spoofing, host-page interference | browser-safe token, TLS, explicit origin, Shadow DOM, no enterprise secret |
| Gateway/webhooks | replay, tampering, tenant spoofing, denial of service | signature/HMAC, replay/idempotency key, rate limits, tenant context |
| Orchestrator/skill runtime | unauthorized tool use, duplicate effect, fabricated result | registry, AUTH verdicts, effect reservation, response validation, evidence |
| PostgreSQL/Redis/Qdrant | cross-tenant disclosure, context leakage, tampering | RLS/composite FKs, tenant key prefixes, payload filters, append-only evidence |
| SoR/providers | receipt forgery, timeout ambiguity, quota abuse | mTLS/TLS, provider signature, receipt reconciliation, circuit breaker |
| Secrets/audit store | disclosure, key compromise, log tampering | managed secret rotation, masking, hash chain, append-only permissions |

### 7.1 PEP decision pipeline

The target sequence is **normalize request → resolve tenant/identity → registry lookup (unknown skill, unlisted agent, and unknown or non-assignable `required_authority` all fail closed) → assigned grant check (a grant outside `AUTH-0..3` is rejected, before any route is computed) → AUTH-5 deny → AUTH-4 routing verdict, computed without rank comparison → AUTH-0..3 rank check → BR-001..010 and the applicable policy, consent, identity, source-freshness, floor-provenance and takeover checks → queue or deny → effect reservation immediately before authorized dispatch → evidence/audit**. The `AUTH-4` verdict does not itself create a queue row: queue creation is deferred until every applicable check above has passed (an unresolved input is a human work item, never an executable approval), and the durable effect reservation is taken only at execution time, never at queue time. No later check may override an earlier hard deny, and unavailable trusted input fails closed.

### 7.2 Authority matrix correction

Assigned grants are only `AUTH-0..AUTH-3`. `required_authority` is a registry routing field and may be `AUTH-4`; `AUTH-4` is not a grant or rank. The action verdict is `AUTO_APPROVED`, `AWAITING_HUMAN_APPROVAL`, or `DENIED` (the PEP-level `decisionCode` in §1.2 spells the same routes: `PERMIT` → `AUTO_APPROVED`; `REQUIRE_HUMAN_APPROVAL`/`LIMIT_EXCEEDED` → `AWAITING_HUMAN_APPROVAL`; `DENY_PROHIBITED` → `DENIED`); approval state is the lifecycle of a specific queue row; audit execution status is the recorded outcome (`pending`, `executing`, `success`, `failed`, `denied`, `aborted`). An approval binds one prepared action and never functions as a grant: it satisfies only the `AUTH-4` pause, and it cannot waive consent, verified identity, the floor decision, evidence, or takeover. `AUTH-5` is terminal hard deny and never enters SCR-003.

### 7.3 P_floor safety and conflict

No price-bearing action dispatches without an owner-approved, provenance-bearing floor decision: a missing or unapproved floor decision refuses the dispatch with `P_FLOOR_UNAVAILABLE` and is not bypassed by queueing the action for approval - the floor decision must be resolved by its owner first, and no human approval ever substitutes for it. A tenant disabling discount/subsidy capability disables that optional action class; it does not bypass the safety decision for a price-bearing proposal that uses the capability. Ownership, formula/margin mode, rounding, currency, staleness, and provenance remain `[OWNER-DECISION-REQUIRED]` between the ERP/policy-service proposal and platform-derived proposal in `README.md` §8.1. The formula examples in this document, including the `max(P_floor_abs, P_floor_ratio, P_base - D_cap)` candidate, are not canonical.

## 8. Business Rule and Audit Matrix `[SRS-MUST][SRS §13, §17 / BR-001..010]`

| Rule | Trigger / trusted input | Deny/error | Audit/evidence | Retry/operator route |
|---|---|---|---|---|
| BR-001 | price not traceable to an authenticated catalog/SKU reference - no invented price (SRS §13); the blueprint adds the floor-decision provenance check as an extra mechanism | `P_FLOOR_UNAVAILABLE` (missing/unapproved floor decision); an untraceable price fails the authoritative-reference check | source/provenance reference | no retry; resolve owner policy |
| BR-002 | discount or price change outside approved policy, including any effective price below the approved floor | `ERR_FLOOR_PRICE_VIOLATION` | proposed/approved values and digest | terminal refusal; human approval cannot waive the floor (a within-policy over-limit discount routes through BR-007) |
| BR-003 | price/inventory/order absent or stale from SoR | `AUTHORITATIVE_SOURCE_UNAVAILABLE` | connector receipt/error | reconcile or human handoff |
| BR-004 | missing/withdrawn consent | `CONSENT_REQUIRED` | consent record/version | no retry; operator/consent route |
| BR-005 | missing/unstable effect key | `EFFECT_KEY_REQUIRED` | canonical payload digest | terminal until corrected |
| BR-006 | retry or replay under an existing `effect_key` | identical key + identical payload → no error, the original receipt is returned; changed payload under the same key → `IDEMPOTENCY_CONFLICT` (409); indeterminate outcome → `UNKNOWN`, reconciled by key | original receipt and new digest | replay returns the original receipt; mismatch stops; an `UNKNOWN` effect is never blind-retried |
| BR-007 | high-risk/financial action, or one whose applicable tenant policy parameter is unset (fail closed) | `REQUIRE_HUMAN_APPROVAL` | PENDING approval row | pause/resume through SCR-003; an approval never waives consent, identity, floor, evidence, or takeover checks |
| BR-008 | insufficient authority, or an invalid/unknown grant or registry requirement (fail closed); an `AUTH-5` requirement is never queueable | `INSUFFICIENT_AUTHORITY` / `INVALID_CLEARANCE` (non-assignable or unknown grant) / `PROHIBITED_ACTION` (AUTH-5) - codes per §04 §3.2.1 | grant, required route, verdict | no retry; operator review |
| BR-009 | prompt injection/privilege attempt | `PROMPT_INJECTION_BLOCKED` | security event and payload digest | no retry; security route |
| BR-010 | missing/tampered evidence attachment | `EVIDENCE_REQUIRED` | chain/hash failure | block completion; audit repair route |

## 9. Audit, NFR, and Economic Extension Contract `[SRS-MUST][SRS §17, §19 / NFR-001..010]`

The audit contract carries all SRS §17 fields, tenant chain scope, canonical JSON/hash rules, append-only behavior, PII masking, key rotation, trusted clock source, evidence references, and explicit handling when audit persistence fails. Audit failure MUST prevent a claimed successful external action: before dispatch it refuses the effect, and after a possible send it records a reconciliation obligation under the original `effect_key` - never an assertion that nothing was sent, and never a blind retry. The NFR matrix in §5 is a design mechanism and verification map: runtime invariants (authority, isolation, idempotency, evidence, fail-closed) are distinct from provisional benchmarks (latency, cost, uptime, retention).

ECN-001 and ECN-004 are `[OPTIONAL-EXTENSION]`, beyond the SRS baseline, tenant-owned, and `[UNCONFIRMED][ASM-003/004]`. They are not enabled by illustrative defaults and cannot weaken BR-001..010, consent, authority, or audit requirements.

## 10. Security Verification Scenarios `[BLUEPRINT][SRS §12, §16, §17, §19]`

Future checks MUST cover prompt injection; self-asserted authority; cross-tenant and cross-customer access; missing consent; missing price/provenance; duplicate effects; hash-chain tamper detection; secret leakage; quota exhaustion; and fail-closed recovery. Results require persisted evidence and are not runtime proof until executed.

### 10.1 Governance acceptance and failure boundaries `[BLUEPRINT][SRS §12, §13, §17, §19 / NFR-001..010]`

The PEP is the only action-admission boundary. It consumes server-resolved tenant and subject context, the registered agent grant and skill requirement, owner-approved policy/consent/source references, the action digest, and the durable effect identity. It emits a typed verdict plus rule IDs and evidence references; it never mutates the grant, changes a System-of-Record value, invents a missing policy parameter, or converts an operator decision into a safety bypass. `AUTH-4` means one prepared action awaits a bound human decision; `AUTH-5` is terminal denial with no queue entry and no path through promotion.

Audit/evidence failure is a safety result, not a logging warning. Before dispatch, the required audit intent must be durable; after a possible provider effect, a failed receipt/evidence append creates a reconciliation obligation under the same `effect_key` and prevents a success claim or blind retry. Hash-chain verification includes the genesis record, predecessor links, tenant scope, canonical serialization, and rotation metadata. Retention and legal applicability remain owner decisions under ASM-005; this blueprint claims no certification or measured compliance.

The NFR verification boundary separates immutable invariants from measurements. Tenant/customer isolation, authority separation, consent, idempotency, human override, source truth, and fail-closed behavior must hold on every permitted path. Latency, throughput, uptime, token cost, bundle size, and retention windows remain provisional until their ASM owner supplies a baseline and the future runtime produces an auditable measurement. A benchmark cannot waive an invariant, and a passed document check cannot close a runtime gate.

Rollout requires the `01` environment/secret boundary, `03` RLS and append-only schema, `04` durable effect and approval protocol, `05` registry admission rules, `06` authentic provider receipts, and the `09` signed evidence bundle. Missing prerequisites keep the affected capability disabled; no example constant, mock, formula candidate, or `[OPTIONAL-EXTENSION]` grants permission to dispatch.
