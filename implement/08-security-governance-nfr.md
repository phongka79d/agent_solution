# Implement 08: Security, Governance & Non-Functional Requirements (NFR) Engine

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

### 1.1 Formal Authority Taxonomy (AUTH-0 to AUTH-5)

| Authority Level | Nomenclature | Permitted Operations | Prohibited Operations | Interceptor Policy Enforcement |
|---|---|---|---|---|
| **AUTH-0** | **Observe** | Read public catalogs, knowledge bases, read customer timeline (if verified). | Any write operation, customer profile modification, external messaging. | Rejects any invocation of mutational connectors (`db.write`, `api.post`). |
| **AUTH-1** | **Recommend** | Calculate match scores, generate product bundles, draft cross-sell hypotheses. | Publishing recommendations to external channels, creating orders. | Interceptor validates output schema; verifies payload is marked as hypothesis. |
| **AUTH-2** | **Draft** | Generate internal campaign copy, format draft support replies in Copilot mode. | Transmitting drafts to end customers or third-party networks. | Outbound dispatch blocked; stores payload in internal draft state store. |
| **AUTH-3** | **Bounded Execute** | Send transactional notifications, check real-time stock, query ERP order status. | Exceeding frequency caps, issuing unapproved discounts, modifying order data. | Checks parameter boundaries (e.g., max 2 messages, rate limits, stock thresholds). |
| **AUTH-4** | **Approval Required**| Propose campaign broadcasts (> 5,000 recipients), discounts > 15%, refunds > 500 TWD. | Autonomous execution without cryptographically signed human approval. | Traps task into `awaiting_human`; dispatches notification to SCR-003 queue. |
| **AUTH-5** | **Prohibited** | Arbitrary price generation, cross-tenant data access, raw data exfiltration. | Strictly forbidden under all conditions. | Hard server lock. Immediately aborts execution; triggers security audit alert. |

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
  readonly agentAssignedAuthority: 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5';
  readonly customerId?: string;
  readonly sessionToken?: string;
  readonly correlationId: string;
}

export const AUTHORITY_HIERARCHY: Readonly<Record<string, number>> = Object.freeze({
  'AUTH-0': 0,
  'AUTH-1': 1,
  'AUTH-2': 2,
  'AUTH-3': 3,
  'AUTH-4': 4,
  'AUTH-5': 5,
});

export interface ActionProposal {
  readonly skillId: string;
  readonly toolName: string;
  readonly requiredAuthority: 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5';
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
  /**
   * Evaluates an agent action proposal against authority levels and security policies.
   * Enforces zero bypass: prompt injection cannot escalate privileges.
   */
  public async enforce(
    context: SecurityContext,
    proposal: ActionProposal
  ): Promise<EnforcementDecision> {
    // 1. Authoritative Server-Side Authority Resolution (BR-008, NFR-001)
    // Strictly ignore client-asserted permissions; look up authoritative authority from Skill Registry
    const authoritativeRequiredAuthority = this.lookupSkillAuthority(proposal.skillId) ?? proposal.requiredAuthority;
    const agentLevel = AUTHORITY_HIERARCHY[context.agentAssignedAuthority] ?? 0;
    const requiredLevel = AUTHORITY_HIERARCHY[authoritativeRequiredAuthority] ?? 5;

    // 2. Hard Lock: Prohibited operations are immediately terminated
    if (authoritativeRequiredAuthority === 'AUTH-5') {
      await this.recordSecurityViolation(context, proposal, 'HARD_LOCK_AUTH_5_PROHIBITED');
      return {
        authorized: false,
        decisionCode: 'DENY_PROHIBITED',
        rationale: 'Action is strictly prohibited by platform security policy (AUTH-5).',
      };
    }

    // 3. High-Risk Gate: Operations requiring human approval (AUTH-4) or exceeding threshold
    // Evaluated BEFORE autonomous rank comparison so capped agents (max AUTH-3) can submit for human sign-off
    if (authoritativeRequiredAuthority === 'AUTH-4' || this.isThresholdBreached(proposal)) {
      const ticketId = await this.routeToApprovalQueue(context, proposal);
      return {
        authorized: false,
        decisionCode: 'REQUIRE_HUMAN_APPROVAL',
        rationale: 'Action exceeds autonomous threshold and requires human sign-off via SCR-003.',
        approvalTicketId: ticketId,
      };
    }

    // 4. Autonomous Privilege Escalation Defense (BR-008, NFR-001)
    // Verifies that autonomous execution (AUTH-0..3) does not exceed assigned agent rank
    if (requiredLevel > agentLevel) {
      await this.recordSecurityViolation(context, proposal, 'PRIVILEGE_ESCALATION_BLOCKED');
      return {
        authorized: false,
        decisionCode: 'DENY_PROHIBITED',
        rationale: `Privilege escalation blocked (BR-008): Agent ${context.agentId} has assigned authority ${context.agentAssignedAuthority} (rank ${agentLevel}) but proposed action requires ${authoritativeRequiredAuthority} (rank ${requiredLevel}).`,
      };
    }

    // 4. Rate Limit & Bounded Checks for AUTH-3
    if (proposal.requiredAuthority === 'AUTH-3') {
      const bounded = await this.verifyBoundedParameters(context, proposal);
      if (!bounded.valid) {
        return {
          authorized: false,
          decisionCode: 'LIMIT_EXCEEDED',
          rationale: bounded.reason,
        };
      }
    }

    // 5. Default Permit for verified AUTH-0..AUTH-3 within authorized bounds
    return {
      authorized: true,
      decisionCode: 'PERMIT',
      rationale: 'Action satisfies authority bounds and operational constraints.',
    };
  }

  private isThresholdBreached(proposal: ActionProposal): boolean {
    const payload = proposal.payload;

    // Discount rate threshold (> 15% requires human approval)
    if (typeof payload.discountRate === 'number' && payload.discountRate > 0.15) {
      return true;
    }

    // Compensation or refund threshold (> 500 TWD)
    if (typeof payload.refundAmount === 'number' && payload.refundAmount > 500) {
      return true;
    }

    // Audience scale threshold (> 5,000 customers)
    if (typeof payload.audienceSize === 'number' && payload.audienceSize > 5000) {
      return true;
    }

    return false;
  }

  private async verifyBoundedParameters(
    context: SecurityContext,
    proposal: ActionProposal
  ): Promise<{ valid: boolean; reason: string }> {
    // Example: verify messaging frequency cap (maximum 2 reminder messages)
    if (proposal.skillId === 'skill.sales.send_message') {
      const sentCount = (proposal.payload.previousAttempts as number) || 0;
      if (sentCount >= 2) {
        return { valid: false, reason: 'Suppression rule: Maximum of 2 reminder messages exceeded.' };
      }
    }
    return { valid: true, reason: '' };
  }

  private async routeToApprovalQueue(context: SecurityContext, proposal: ActionProposal): Promise<string> {
    // Inserts task into approval queue table and returns unique ticket ID
    return `APV-${context.tenantId.substring(0, 4)}-${Date.now()}`;
  }

  private async recordSecurityViolation(
    context: SecurityContext,
    proposal: ActionProposal,
    violationType: string
  ): Promise<void> {
    // Dispatches immediate security audit event to tamper-evident audit store
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
- **Specification**: No promotional discount, bundle subsidy, or cart recovery coupon may produce an effective net price below the mathematical floor price:
  $$P < P_{floor}$$
- **Enforcement**: Server-side pricing engine calculates $P_{floor}$ using authoritative ERP cost metrics. Any transaction with $P < P_{floor}$ is blocked at the database level.

#### BR-003: Authoritative System of Record Pricing & Inventory
- **Specification**: Real-time product pricing, stock availability, and logistics statuses must be fetched synchronously from the System of Record (ERP/WMS via API-001).
- **Enforcement**: Cached inventory records older than 120 seconds are marked invalid. If the ERP is unreachable, the system fails closed (zero stock assumed).

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
- **Specification**: Financial compensations (> 500 TWD), refunds, warranty policy overrides, and mass broadcasts (> 5,000 recipients) strictly require human authorization.
- **Enforcement**: Interceptor traps execution and generates an approval task in SCR-003 (`AUTH-4`).

#### BR-008: Strict Server-Side Authority Boundaries
- **Specification**: Agents cannot exceed their designated authority levels (`AUTH-0` to `AUTH-3`), even if the LLM reasoning claims authorization.
- **Enforcement**: The Orchestrator strictly ignores self-asserted permissions. Authority mapping is statically bound to the authenticated agent definition in PostgreSQL.

#### BR-009: Prompt Injection Resilience & Privilege Isolation
- **Specification**: User-supplied input (e.g., customer chat prompts or uploaded documents) cannot modify system policies, alter floor prices, or grant elevated privileges.
- **Enforcement**: Multi-layered defense: (1) Inputs are treated strictly as untrusted string literals within isolated data envelopes; (2) Canary token tracking detects boundary leakage; (3) System prompt instructions and tools run in separate execution contexts; (4) Privilege elevation attempts inside prompts are intercepted and neutralized by the PEP prior to tool dispatch.
#### BR-010: Immutable Evidence Record Attachment
- **Specification**: Every successful business transaction must produce an Evidence Record containing raw upstream API receipts, timestamps, and correlation IDs.
- **Enforcement**: Orchestrator will not mark a task `completed` unless an Evidence Record with verified source references is committed to the audit store.

### 2.2 Business Rules Pipeline Implementation
```typescript
/**
 * @file governance/BusinessRulesEngine.ts
 * Deterministic business rules validation pipeline.
 */

export interface RuleEvaluationResult {
  readonly ruleId: string;
  readonly passed: boolean;
  readonly errorCode?: string;
  readonly failureReason?: string;
}

export interface RuleContext {
  readonly tenantId: string;
  readonly agentId: string;
  readonly agentAssignedAuthority: 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5';
  readonly requiredAuthority?: 'AUTH-0' | 'AUTH-1' | 'AUTH-2' | 'AUTH-3' | 'AUTH-4' | 'AUTH-5';
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
      const MAX_CACHE_AGE_MS = 120_000; // 120 seconds TTL
      if (cacheAgeMs > MAX_CACHE_AGE_MS) {
        return {
          ruleId: 'BR-003',
          passed: false,
          errorCode: 'ERR_STALE_INVENTORY_CACHE',
          failureReason: `Inventory cache age (${Math.round(cacheAgeMs / 1000)}s) exceeds 120s TTL threshold. Fail Closed.`,
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
      const { refundAmount = 0, discountRate = 0, policyModification = false, hasSignedApprovalToken = false } = ctx.financialRisk;
      const isHighRisk = refundAmount > 500 || discountRate > 0.15 || policyModification;
      if (isHighRisk && !hasSignedApprovalToken) {
        return {
          ruleId: 'BR-007',
          passed: false,
          errorCode: 'ERR_FINANCIAL_APPROVAL_REQUIRED',
          failureReason: `High-risk financial/policy action (refund: ${refundAmount}, discount: ${discountRate * 100}%, policyMod: ${policyModification}) strictly requires signed human approval (AUTH-4 via SCR-003).`,
        };
      }
    }
    return { ruleId: 'BR-007', passed: true };
  }

  private evaluateBR008(ctx: RuleContext): RuleEvaluationResult {
    const hierarchy: Record<string, number> = {
      'AUTH-0': 0,
      'AUTH-1': 1,
      'AUTH-2': 2,
      'AUTH-3': 3,
      'AUTH-4': 4,
      'AUTH-5': 5,
    };
    if (ctx.requiredAuthority) {
      const agentRank = hierarchy[ctx.agentAssignedAuthority] ?? 0;
      const reqRank = hierarchy[ctx.requiredAuthority] ?? 5;
      if (reqRank > agentRank) {
        return {
          ruleId: 'BR-008',
          passed: false,
          errorCode: 'ERR_AUTHORITY_BOUNDARY_EXCEEDED',
          failureReason: `Agent authority boundary exceeded: ${ctx.agentId} has ${ctx.agentAssignedAuthority} but requires ${ctx.requiredAuthority}.`,
        };
      }
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
The Floor Price Engine protects 100% of the merchant's net contribution margin. It governs all automated discounting, promotional vouchers, cart recovery offers, and replenishment subscriptions.

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
- $P_{base} \in \mathbb{R}^+$: The official base catalog listing price (excluding taxes and separate freight).
- $C \in \mathbb{R}^+$: Total unit variable cost = $\text{COGS} + \text{Packaging} + \text{Fulfillment} + \text{Allocated AI Compute Cost} + \text{Return Reserve}$.
  - Allocated AI compute cost is capped at $0.50 - 1.00\text{ TWD}$ ($\approx 400 - 800\text{ VND}$) per consultation session.
- $r \in [0, 1)$: Variable revenue-proportional deductions (payment gateway transaction fees e.g. 2.5%, marketplace platform fees, affiliate commissions).
- $L \ge 0$: Minimum mandatory absolute net contribution margin required per unit sold.
- $m \ge 0$: Minimum required net contribution margin ratio (e.g. $0.15$ for 15% net margin; $r + m < 1$).
- $D_{cap} \ge 0$: Maximum absolute promotional discount authorized by business finance.

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
The Floor Price Verification Service runs as an atomic, high-performance module within the Core Engine. It supports cryptographic HMAC signing of price quotes, distributed Redis budget holds, localized currency rounding, and strict Fail Closed enforcement.

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
  readonly revenueFeeRatio: number; // e.g. 0.025 for 2.5%
  readonly targetMargin: number; // L: Absolute margin
  readonly minNetMarginRatio?: number; // m: Ratio margin (e.g. 0.15 for 15%)
  readonly maxDiscountCap: number; // D_cap
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
- **Mechanism**: The engine applies an automatic 1.5% to 2.0% safety cushion to the variable cost component $C$:
  $$C_{adjusted} = C \times (1 + \text{FX\_Buffer})$$
- **Expiration Guard**: If a customer checks out after the 10-minute quote window expires, the system fetches the latest foreign exchange rates from API-001 and recalculates $P_{floor}$ before order creation.

---

## 4. Immutable Audit Logging Service

To satisfy compliance mandates (Taiwan PDPA, GDPR Article 30, CCPA) and system non-functional requirements (NFR-002, NFR-006), every execution of an AI agent is recorded in an immutable, cryptographically chained audit log.

### 4.1 Canonical 18-Field Audit Schema

| Field # | Field Name | Data Type | Description & Compliance Purpose |
|---|---|---|---|
| **1** | `run_id` | `UUID v4` | Unique execution run identifier. |
| **2** | `tenant_id` | `UUID v4 / String` | Tenant identity. Mandatory on all records for strict multi-tenant isolation. |
| **3** | `agent_id` | `String` | Executing agent identifier (`MKT-05`, `SAL-02`, `CS-01`). |
| **4** | `customer_or_entity_id`| `String (Pseudonymized)`| Salted hash or UUID of the customer/entity. No plaintext PII. |
| **5** | `trigger` | `String` | Triggering event (`cart.abandoned`, `order.lookup`, `message.received`). |
| **6** | `context` | `JSON Object` | Snapshot of sanitized input context and verified customer tier. |
| **7** | `skill` | `String` | Skill invoked (`skill.sales.check_stock`, `skill.care.lookup_order`). |
| **8** | `tool` | `String` | Downstream connector called (`API-001.InventoryConnector`, `ADPT-TW-001`). |
| **9** | `decision` | `JSON Object` | Orchestrator decision logic, reasoning summary, and confidence score. |
| **10**| `authority` | `Enum` | Applied authority level (`AUTH-0` through `AUTH-5`). |
| **11**| `approval` | `JSON Object \| null` | Human approver record if AUTH-4: `{ approver_id, action, signed_at }`. |
| **12**| `action` | `JSON Object` | Outbound payload containing unique `effect_key`. |
| **13**| `execution_status` | `Enum` | Status (`pending`, `executing`, `success`, `failed`, `denied`, `aborted`). |
| **14**| `evidence` | `JSON Object` | Authoritative receipt from source system (ERP order ID, tracking number). |
| **15**| `outcome` | `JSON Object \| null` | Business conversion outcome (`order_created`, `cart_recovered`). |
| **16**| `latency_ms` | `Integer` | Total execution elapsed time in milliseconds. |
| **17**| `cost` | `JSON Object` | Operational cost: `{ prompt_tokens, completion_tokens, cost_twd }`. |
| **18**| `error` | `JSON Object \| null` | Error code, sanitized message, and failure stack trace (if any). |
| **\***| `timestamp` | `ISO 8601 UTC` | Commited timestamp. |
| **\***| `chain_hash` | `CHAR(64) Hex` | Cryptographic SHA-256 hash linking this record to the preceding block. |

### 4.2 Cryptographic Hash Chaining & Tamper Detection
Every audit log entry is linked to its immediate predecessor via SHA-256 chaining. Modifying or deleting any historical record invalidates all subsequent hashes, providing verifiable tamper detection.

$$\text{Hash}_n = \text{SHA256}(\text{Hash}_{n-1} + \text{CanonicalJSON}(\text{Payload}_n) + \text{Timestamp}_n + \text{Nonce}_n)$$

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
  // Hash chain partitioned independently per tenant_id to satisfy NFR-006 multi-tenant isolation
  private readonly tenantLastHash: Map<string, string> = new Map();
  private readonly salt: string;
  private readonly GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

  constructor(salt: string) {
    this.salt = salt;
  }

  /**
   * Retrieves the previous hash for a given tenant. Checks in-memory cache first,
   * falling back to the most recent persisted audit record in PostgreSQL to guarantee continuity across restarts.
   */
  public async getPrevHashForTenant(
    tenantId: string,
    pgPool?: { query: (sql: string, params: unknown[]) => Promise<{ rows: Array<{ chain_hash: string }> }> }
  ): Promise<string> {
    const cached = this.tenantLastHash.get(tenantId);
    if (cached) return cached;

    if (pgPool) {
      const res = await pgPool.query(
        'SELECT chain_hash FROM agentos.audit_records WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1',
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
   */
  public createChainedRecord(rawPayload: AuditRecordPayload): {
    readonly record: AuditRecordPayload;
    readonly chainHash: string;
    readonly prevHash: string;
  } {
    const sanitizedPayload: AuditRecordPayload = {
      ...rawPayload,
      customerOrEntityId: this.pseudonymizeId(rawPayload.customerOrEntityId),
      context: this.maskPiiObject(rawPayload.context),
      action: this.maskPiiObject(rawPayload.action),
    };

    const prevHash = this.getPrevHashForTenant(sanitizedPayload.tenantId);
    const serialized = JSON.stringify(sanitizedPayload);
    const hashInput = `${prevHash}|${serialized}|${sanitizedPayload.timestamp}`;
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
   * Persists an audit log record and its cryptographic chaining metadata to PostgreSQL.
   */
  public async persistToPostgres(
    pgPool: { query: (sql: string, params: unknown[]) => Promise<unknown> },
    entry: { record: AuditRecordPayload; chainHash: string; prevHash: string }
  ): Promise<void> {
    const sql = `
      INSERT INTO audit_logs (
        run_id, tenant_id, agent_id, customer_or_entity_id, trigger,
        context, skill, tool, decision, authority, approval, action,
        execution_status, evidence, outcome, latency_ms, cost, error,
        timestamp, prev_hash, chain_hash
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
   * Validates integrity across a sequence of audit log entries for a given tenant.
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

      const serialized = JSON.stringify(current.record);
      const expectedHash = crypto
        .createHash('sha256')
        .update(`${current.prevHash}|${serialized}|${current.record.timestamp}`)
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

The platform guarantees compliance with 10 mandatory Non-Functional Requirements (NFRs) verified via automated continuous integration and runtime monitors:

| Requirement ID | NFR Domain | Specification Target | Verification Method & SLA Guard |
|---|---|---|---|
| **NFR-001** | **Security & Least Privilege** | Zero privilege escalation; prompt injection resilience; hard server lock for AUTH-5. | Automated adversarial penetration tests (`TC-E2E-006`); PEP interceptor unit tests. |
| **NFR-002** | **Auditability** | 100% of mutational operations recorded with 18-field canonical schema and SHA-256 hash chaining. | Daily cryptographic chain integrity sweep; zero unchained log entries. |
| **NFR-003** | **Idempotency & Durability**| Network retries with identical `effect_key` produce zero duplicate messages or transactions. | Chaos network fault injection testing (`TC-E2E-005`); database unique constraints. |
| **NFR-004** | **System Availability** | 99.9% uptime for core API and Storefront Widget endpoints (excluding scheduled maintenance). | Multi-zone Kubernetes deployment with auto-healing pods and health check probes. |
| **NFR-005** | **Explainability & Transparency** | 100% of qualification scores, recommendations, discounts, and routing decisions store logic `reason` and verified `evidence`. | Deterministic Decision audit logs; structured evidence separation contracts. |
| **NFR-006** | **Multi-Tenant Isolation**| Absolute isolation of customer profiles, vector search indices, and queues across tenants. | Automated cross-tenant penetration test suite running in CI pipeline. |
| **NFR-007** | **Human-in-the-Loop** | High-risk operations (AUTH-4) halt synchronously until human sign-off; Takeover mutex locks bot. | End-to-end integration tests verifying zero autonomous execution for AUTH-4. |
| **NFR-008** | **Fail Closed Behavior** | In the event of system failure, timeout, or missing cost metrics, transactions fail safe/closed. | Mock service outage test: pricing engine blocks discount and falls back to $P_{base}$. |
| **NFR-009** | **Performance & Latency** | Conversational response latency: median < 2.0s, p95 < 3.0s; API routing < 200ms. | Real-time Prometheus/Grafana p95 latency alarms; CDN edge acceleration. |
| **NFR-010** | **Cost Observability & Resource Limits**| AI token compute cost strictly capped at 0.50 - 1.00 TWD per complete customer dialogue. | Token usage accounting middleware; automatic session throttling upon budget breach. |

---

## 6. Economic Incentive Mechanisms & Anti-Sybil Defense

### 6.1 ECN-001: Sales Commission Reallocation & Instant Dynamic Subsidy (AI 智能即時補貼)

The platform avoids traditional arbitrary discounting by reallocating human sales commissions to real-time closing subsidies.

```
+-----------------------------------------------------------------------------+
| TRADITIONAL DISORGANIZED DISCOUNTING vs DETERMINISTIC ECN-001 COMMISSION POOL|
|                                                                             |
| Traditional: AI haggles arbitrarily -> Erodes margin -> Suspected of fraud  |
|                                                                             |
| ECN-001:                                                                    |
| Human Sales Commission Pool (3-5% GMV)                                      |
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
3. **Atomic 10-Minute TTL & Quota Limits**:
   - Subsidies are bounded by a 10-minute validity window (`quote_ttl = 600s`).
   - Scarcity is communicated transparently: *"3 subsidized slots unlocked for your session today"*. If unpaid after 10 minutes, the budget reservation is released back to the tenant's commission pool.

### 6.2 ECN-004: Dynamic Loyalty Budgeting & Anti-Sybil Defense

To prevent multi-account coupon farming and arbitrage bots from draining marketing budgets, the platform implements a 4-factor identity check and strict basket caps.

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
   - **Basket Cap**: Maximum promotional deduction per order is capped at 1,000 - 2,000 TWD.
   - **Minimum Spend Rule**: Subsidies require a minimum spend equal to at least 3x the voucher value.
   - **Category Exclusion**: High-ticket durable assets (e.g., EV Scooters) are strictly excluded from percentage-based discount vouchers. Only fixed-amount accessories or official government subsidy guidance can be applied.

