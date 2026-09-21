# Implement 11: Pricing Policy Engine and Promotion Governance

> **BLUEPRINT STATUS — design-level specification only.**
> This document defines the platform's pricing and promotion governance model for the Gate P0 foundation layer. It is intentionally a design blueprint, not a live pricing engine or production policy repository. Numeric caps and thresholds are placeholders to be approved by the tenant's Business/Finance owners before production use.

## 1. Purpose

The pricing layer is the most sensitive operational boundary in the platform. AI may recommend, may summarize, and may draft offers, but it must never become the authoritative source of business-approved pricing, discounts, refund logic, or promotional eligibility. The architecture separates three concerns:

1. **Source-of-truth pricing** from ERP/POS/PIM
2. **Policy enforcement** from the platform rule engine
3. **AI recommendation** as a non-authoritative suggestion layer

This separation allows the platform to be policy-safe while still using AI for personalized recommendations.

---

## 2. Design Principle: Price Is Approved by Business, Not by AI

The platform shall enforce the following rules:

- The final sale price originates from the authoritative SoR pricing service.
- The AI system may generate a recommendation only using the approved price and policy metadata as inputs.
- Any discount, refund, promotion, or subsidy must pass through the rule engine and approval gate when beyond configured thresholds.
- The platform shall never allow AI to overwrite an authoritative price record.
- When a price or policy cannot be verified, the system fails closed and routes to human review.

---

## 3. Core Architecture

```text
ERP / POS / Pricing Service (SoR)
        ↓
Pricing Policy Store
        ↓
Policy Evaluation Engine
        ↓
AI Recommendation Service (non-authoritative)
        ↓
Approval Queue SCR-003 (AUTH-4 routing)
        ↓
Execution Adapter
```

### Components

#### 3.1 System of Record Price Source
- ERP / POS pricing service
- promotion catalog
- customer-specific price and agreement metadata
- region / channel / product-specific rule tables

#### 3.2 Policy Store
A tenant-owned policy store containing the approved business limits. This store must hold:

- max autonomous discount rate
- max refund / compensation amount
- max audience size for autonomous campaign sends
- pricing floor parameters
- product or category exclusions
- region and customer-tier restrictions
- time-based promotion constraints

#### 3.3 Policy Evaluation Engine
This layer checks every AI-proposed discount or price adjustment before execution. It evaluates:

- requested discount relative to approved bounds
- customer eligibility
- inventory availability
- order value or basket size restrictions
- channel-specific limitations
- legal or contractual restrictions

#### 3.4 AI Recommendation Layer
The AI layer may generate:

- best-fit product bundles,
- discount options within policy,
- upsell and cross-sell suggestions,
- price comparison explanations,
- recommendations for the human reviewer.

The AI layer may not:

- create a price without source validation,
- bypass the policy engine,
- approve a discount directly,
- assert a final promo code as valid without record verification.

---

## 4. Policy Inputs and Outputs

### 4.1 Input Variables

The rule engine shall accept these inputs:

- tenant_id
- customer_id
- customer_tier
- channel
- product / sku_id
- current list price
- current floor price / policy floor
- requested discount rate
- requested promotion code / bundle discount
- order value or basket value
- audience size (for campaigns)
- product category / region / channel restrictions
- consent status
- agent or user role

### 4.2 Output Decision

```text
Decision = PERMIT | REJECT | REQUIRE_HUMAN_APPROVAL | FAIL_CLOSED
```

Where:

- `PERMIT` means the action is within authorized bounds and may proceed.
- `REJECT` means the rule engine actively rejects the request.
- `REQUIRE_HUMAN_APPROVAL` means the action is valid in principle but exceeds autonomy thresholds.
- `FAIL_CLOSED` means one of the required facts is missing or unverifiable.

---

## 5. Policy Decision Model

### 5.1 Price Floor Guardrail

The system includes a design-time floor calculation policy, which must be treated as a policy evaluation helper rather than a competing pricing source.

$$
P_{floor} = \max\left(\frac{C + L}{1 - r},\; P_{base} - D_{cap}\right)
$$

Where:

- $P_{floor}$ = minimum permitted effective final price
- $C$ = cost-related value or cost base
- $L$ = logistics / fulfillment / support overhead
- $r$ = permitted margin or target risk factor
- $P_{base}$ = authoritative base price from SoR
- $D_{cap}$ = approved maximum discount cap

### Design interpretation

- This formula is an evaluation model only.
- It does not replace the ERP/POS price as source of truth.
- The platform may reject a proposed price if it breaches the floor.
- The platform may not generate or overwrite a new base price.

### 5.2 Discount and Promotion Rules

Discount rules must be expressed as business policy, not model behavior. Example placeholders:

- customer tier discount cap
- loyalty discount cap
- first-purchase discount cap
- category-specific promotion exclusions
- campaign audience maximum
- frequency cap per customer per 30 days
- maximum refund / compensation amount
- promotion stacking restrictions

---

## 6. Approval Thresholds

The platform shall route any action that exceeds the configured autonomous limits to the human approval center SCR-003.

### Example design thresholds (placeholders only)

| Rule Type | Example Placeholder | Escalation Trigger |
|---|---|---|
| Discount rate | 15% | request > 15% and not in approved customer promotion rule |
| Refund / compensation | 500 TWD | request exceeds approved amount |
| Campaign audience size | 10,000 recipients | broadcast size exceeds approved threshold |
| Frequency cap | 2 reminders/30 days | more than allowed reminder count |
| Bundle promotion | 1 active bundle rule | conflicting active promotions |

These values are placeholders only. They are not platform constants and must be approved by the tenant's owner before becoming production policy.

---

## 7. Promotion Lifecycle

### 7.1 Promotion Concept

A promotion is a structured object with business lifecycle states:

```text
DRAFT -> APPROVED -> ACTIVE -> EXPIRED -> REVOKED
```

### 7.2 Required Promotion Fields

- promotion_id
- tenant_id
- product or category scope
- region / channel scope
- customer-tier eligibility
- discount type
- discount amount / percentage
- start_at / end_at
- max redemption count
- max basket value or item value threshold
- policy version
- approval ticket id (if escalated)
- created_by / approved_by

### 7.3 Promotion Rule Enforcement

Before any promotion is sent or executed:

- customer must be eligible,
- product must be eligible,
- channel must allow the promotion,
- date range and inventory must be valid,
- prior redemption count must be checked,
- policy must be current and approved.

---

## 8. Revenue and Finance Boundary

The pricing engine is a business control system, not a marketing automation feature. It must be owned by the finance / pricing / commercial operations team, with technical implementation by the platform team.

### Required governance roles

- **Pricing Owner**: approves pricing policy and floor logic
- **Finance Ops**: validates refunds, compensation, and financial guardrails
- **Marketing Ops**: defines campaign limits, promotion timing, and audience scope
- **Platform Security / Governance**: ensures enforcement and auditability

---

## 9. Auditability Requirements

Every pricing and promotion decision must generate an immutable record containing:

- tenant_id
- request_id
- customer_id (if applicable)
- product_id / sku_id
- policy_version
- rule set evaluated
- input values
- decision outcome
- approval ticket id if escalated
- approver identity
- timestamp
- evidence reference

This record is the authoritative evidence for audit and dispute resolution.

---

## 10. Fail-Closed Pricing Rules

The platform shall fail closed when:

- the authoritative price is missing,
- price provenance is stale or unknown,
- discount policy is missing,
- customer eligibility cannot be verified,
- the promotion is expired or conflict-checked,
- required approval is not present,
- the promotion or policy version is unknown.

The outcome of a fail-closed condition is never a silent fallback to a guessed price. The action is blocked or escalated.

---

## 11. Minimal Acceptance Criteria

The design satisfies the minimum bar when all of the following are true:

1. Price generation remains in the recognized SoR pricing system.
2. AI does not mutate authoritative price data.
3. Promotion and discount logic runs through a policy engine with provenance.
4. Escalation to SCR-003 occurs when thresholds are exceeded.
5. All pricing decisions are immutable and auditable.
6. Missing or stale policy facts fail closed without exceptions.

---

## 12. Recommended Supporting Artifact

The next artifact to align with this blueprint is:

- **12-identity-consent-lifecycle.md**

This doc will define the customer identity verification model, consent lifecycle, and the safe boundaries for customer data access.
