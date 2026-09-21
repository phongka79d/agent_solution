# Implement 10: Data Sovereignty, Source-of-Truth, and Authority Boundaries

> **BLUEPRINT STATUS — design-level specification only.**
> This document defines the canonical model for data ownership, source-of-truth rules, and read/write boundaries for the AgentOS Customer360 platform. It is a design artifact for the Gate P0 foundation stage and does not require operational data to be live. Numeric retention periods, freshness SLA values, and policy thresholds are placeholders to be finalized when the tenant's approved baseline is locked.

## 1. Purpose

The platform is designed to bridge probabilistic AI behavior with deterministic enterprise systems of record (SoR). A single, explicit data-governance model is required so that the system can safely distinguish between:

- authoritative business data,
- mirrored or synchronized copies,
- derived AI outputs,
- transient runtime caches,
- and customer/tenant-scoped operational data.

Without this model, the platform risks making AI-generated facts appear as if they were authoritative enterprise records. This is a critical design risk for pricing, inventory, identity, consent, and order handling.

---

## 2. Core Principle: One Fact, One Source, One Owner

Every business fact in the platform must be mapped to exactly one of these categories:

1. **System of Record (SoR)**
   - The authoritative source for the fact.
   - Typically ERP, POS, CRM, WMS, OMS, or payment platform.
   - Only the SoR can create or change the original fact.

2. **Mirror / Projection**
   - A synchronized copy used for low-latency reads and analytics.
   - Not authoritative.
   - Must retain provenance metadata and must not be used for legal decisions without validation.

3. **Derived / AI Generated Output**
   - A result created by reasoning, summarization, scoring, or inference.
   - Never treated as an authoritative business fact.
   - Must be marked as `derived`, include producing model/agent, and carry a timestamp and confidence score when relevant.

4. **Runtime Cache / Working Memory**
   - Ephemeral acceleration layer for session state or repeated reads.
   - Must be invalidated on source changes and never used as the primary fact source.

5. **Operational / Audit Evidence**
   - Logging, events, approval records, policy decisions, and audit trails.
   - Not a business fact in itself; it confirms what occurred and by whom.

---

## 3. Data Ownership Model

### 3.1 Ownership Matrix

| Data Domain | Canonical Fact | Source of Truth | Ownership | Readability | Writeability | Notes |
|---|---|---|---|---|---|---|
| Identity & customer | customer master record | CRM / POS / ERP | Customer Ops | Core + approved services | SoR only | Identity claims must be verified before profile lookup |
| Identity mapping | channel identifier mapping | CRM / auth provider | Identity Team | Core / policy engine | SoR only | Maps LINE, WhatsApp, web session, phone, email |
| Consent | marketing / order / analytics consent | CRM / website consent system | Legal + Marketing Ops | Core + support apps | SoR only | Must be channel-specific and timestamped |
| Product catalog | product / brand / category | ERP / PIM | Merchandising Ops | Core + sales + support | SoR only | Product metadata never invented by AI |
| Inventory | stock availability | WMS / OMS | Fulfillment Ops | Core + sales + support | SoR only | Real-time availability only from authoritative stock |
| Price | list price / floor / promotion | ERP / POS / pricing engine | Pricing Owner | Core + sales | SoR only | AI must never create price |
| Order state | order status / fulfillment | OMS / ERP | Order Ops | Core + support | SoR only | Human approval required for refunds/adjustments |
| Payment state | payment status | Payment provider / ERP | Finance Ops | Core + support | SoR only | Payment confirmation only from provider or ERP |
| Conversation | session transcript | Channel platform / app | Customer experience team | Core + agents | Channel + customer service | Must be tenant-scoped |
| Knowledge | approved product knowledge | Second Brain / approved docs | Knowledge owner | AI + support | Approved editors only | Grounding source for knowledge retrieval |
| AI reasoning | hypothesis / recommendation | AI reasoning runtime | AI platform | Internal only | AI runtime | Must be marked as derived, not authoritative |
| Audit evidence | approval / action logs | platform audit store | Security / governance | Admin + auditors | Platform only | Immutable, hash-linked, tenant-scoped |

---

## 4. Canonical Classification Rules

### 4.1 SoR vs Mirror vs Derived

A data item must be classified before a system can consume it:

```text
Fact source classification
├── SoR: original, authoritative, business-operating system
├── Mirror: synchronized copy of SoR, read-optimized, non-authoritative
├── Derived: AI-generated, inferred, summarized, scored, recommended
├── Cache: ephemeral runtime optimization, invalidated on TTL or source change
└── Evidence: proof record of action, approval, or outcome
```

### 4.2 Mandatory Metadata for Every Record

Every fact-carrying table or event must include, where applicable:

- `tenant_id`
- `source_system`
- `source_record_id`
- `provenance` or `origin`
- `is_authoritative` (boolean)
- `is_derived` (boolean)
- `owner` (team or service)
- `updated_at`
- `valid_from` / `valid_to`
- `confidence_score` (for derived output)
- `version` (policy / prompt / model / document)

### 4.3 Provenance Rule

A system may only present a fact as authoritative when the fact carries a valid `source_system` and `source_record_id` pointing to a trusted SoR. If provenance is missing or stale, the system must:

- fail closed,
- refuse to render the value as final,
- route to human review if the action is material,
- never silently turn an unverified value into a customer-visible fact.

---

## 5. Source-of-Truth Matrix by Domain

### 5.1 Customer and Identity

| Entity | Authority | Why it is authoritative | Design rule |
|---|---|---|---|
| customers | CRM / ERP / authenticated application | single business customer directory | AI may read but not mutate |
| customer_identities | identity provider / channel registry | maps login, LINE UID, phone, email, session ID | must not be used without verified session |
| consents | consent repository | legal basis for contact and usage | must be channel-specific and timestamped |

**Design rule:** If a channel identity is not verified by the server, the system does not allow private data lookup, order lookup, or profile retrieval.

### 5.2 Commerce and Fulfillment

| Entity | Authority | Why it is authoritative | Design rule |
|---|---|---|---|
| products | ERP/PIM | official catalog | AI may recommend but cannot invent product metadata |
| skus | ERP/PIM | variant-level source | product attribute facts must match SoR |
| prices | ERP/POS pricing service | only price generator for legal sale | AI cannot calculate final price for customer-facing offer |
| inventories | WMS/OMS | warehouse stock reality | AI can only read and recommend based on real available stock |
| orders | OMS/ERP | transactional order source | AI cannot assert checkout completion without SoR confirmation |
| invoices | finance / ERP | invoice and tax record | support tools may reference them only after confirmation |

**Design rule:** AI may generate a recommendation, but the final quoted price or confirmed order state is never inserted by AI into the authoritative system.

### 5.3 Conversation and Customer Journey

| Entity | Authority | Why it is authoritative | Design rule |
|---|---|---|---|
| conversation sessions | channel platform / chat system | actual interaction record | stored by tenant and customer |
| event timeline | event ingestion service | sequence of channel events and triggers | must be separated from customer facts |
| AI hypotheses | AI runtime | inferred reasoning, not ground truth | always tagged as `HYPOTHESIS` |
| approval records | platform governance store | formal decision record | immutable and hash-linked |

**Design rule:** Fact, hypothesis, and recommendation must be visually and structurally different in UI and data model.

---

## 6. System-of-Record Boundaries and Fail-Closed Rules

### 6.1 Policy Guardrails

The platform applies the following rules at all ingestion and read boundaries:

1. **No AI-authored source-of-truth**
   - AI cannot create or overwrite authoritative pricing, inventory, order confirmation, or customer consent records.

2. **No silent trust of mirrors**
   - A mirrored price or inventory record is not treated as trustworthy beyond its specified freshness and provenance.

3. **No cross-tenant read**
   - A tenant cannot read another tenant’s data even if the same logical entity exists.

4. **No customer-context spillover**
   - Customer A context cannot be loaded into a session bound to customer B.

5. **No implicit AI approval**
   - AI-generated action proposals require human approval when policy requires it.

6. **No unverifiable action**
   - If pricing, stock, identity, or consent cannot be verified, the action must fail closed and route to human intervention.

### 6.2 Fail-Closed Decision Tree

```text
Customer action request
        ↓
Check tenant scope
        ↓
Check verified identity
        ↓
Check consent / policy context
        ↓
Check SoR availability
        ↓
If any check fails → FAIL CLOSED → human review / safe deny
If all checks pass → proceed with read-only validation or approved action
```

---

## 7. Canonical Data Flow Pattern

### 7.1 Read Flow

```text
Channel / user request
        ↓
Orchestrator
        ↓
Policy engine validates tenant + customer + authorization
        ↓
Query source-of-truth service (ERP / CRM / WMS / OMS / consent store)
        ↓
Receive authoritative record with provenance
        ↓
Prepare AI context and summarization only from verified records
        ↓
Return answer or recommendation with evidence tag
```

### 7.2 Write / Action Flow

```text
AI proposes action
        ↓
PEP evaluates authority and policy constraints
        ↓
If within approved rules → create signed action proposal
        ↓
If outside policy → route to SCR-003 approval queue
        ↓
Human approves or rejects
        ↓
Platform dispatches to correct SoR adapter
        ↓
System records execution evidence (immutable audit log)
```

---

## 8. Data Freshness and Staleness Policy

Every mirror or derived record should declare one of the following:

- **Strongly authoritative**: directly from SoR, no delay risk
- **Fresh enough for recommendation**: within freshness SLA window
- **Stale**: outside SLA, must not be used for final decisions
- **Unknown**: no provenance; deny or escalate

### Example design placeholders

| Data Type | Freshness SLA (design placeholder) | Action if stale |
|---|---|---|
| Price | 5 minutes | block automated quote rendering |
| Inventory | 30 seconds | surface availability as uncertain |
| Consent status | real-time | block marketing send without current valid state |
| Order status | 1 minute | permit read-only answer with evidence tag |
| Customer profile | 5 minutes | require re-verification before sensitive reads |

These numbers are intentionally placeholders and must be replaced by tenant-approved baselines.

---

## 9. Tenant, Customer, and Session Scoping

All persistent data must be scoped by at least:

- `tenant_id`
- `customer_id` when a customer is known
- `session_id` for conversation-state processing
- `correlation_id` for request tracing

### Mandatory rules

- No cross-tenant query without explicit tenant-bound enforcement.
- No customer record lookup without verified identity.
- No customer timeline sharing across sessions not belonging to the same verified customer.
- No accidental use of a prior-session context to answer a new customer session.

---

## 10. Design Pattern for Derived AI Outputs

AI-generated outputs must be separated structurally from SoR facts. A standard output contract should include:

```json
{
  "record_type": "HYPOTHESIS",
  "tenant_id": "tenant-uuid",
  "customer_id": "customer-uuid",
  "source": "ai.reasoning",
  "model": "gpt-4.1-mini",
  "confidence": 0.82,
  "created_at": "2026-09-21T10:00:00Z",
  "evidence": [
    "product_catalog:sku_123",
    "customer_consent:consent_456"
  ],
  "provenance": "derived-from-verified-context",
  "status": "proposal"
}
```

### What this makes explicit

- This is not an authoritative business fact.
- It can be recommended or shown as a suggestion.
- It may still be used to trigger a human approval route when the action is high-risk.

---

## 11. Data Sovereignty Design Obligations

This blueprint assumes a zero-trust adoption model. Each domain must declare and enforce:

- data owner,
- source of truth,
- access policy,
- retention policy,
- legal basis,
- update cadence,
- fallback behavior.

This is especially important for:

- customer personally identifiable data,
- order and payment records,
- pricing and promotions,
- marketing opt-ins and opt-outs,
- cross-border or regional compliance requirements.

---

## 12. Minimal Design Acceptance Criteria

The following criteria define the minimum bar for this blueprint to be considered complete at design level:

1. Every core entity is mapped to a single source-of-truth owner.
2. Every AI output is explicitly tagged as derived or hypothesis.
3. No pricing, order, consent, identity, or inventory fact is treated as authoritative without provenance.
4. Every tenant-scoped object is bound to `tenant_id` at persistence and runtime.
5. Every customer-scoped read requires verified identity before access.
6. Fail-closed logic is defined for missing provenance, stale data, and policy violations.

---

## 13. Recommended Next Artifact

To maintain consistency with the rest of the implementation blueprint, the next supporting artifact should be:

- **11-pricing-policy-engine.md** — a design doc for price-floor logic, rule evaluation, promotion policy ownership, and approval routing.

This keeps pricing and promotional decisions separate from the AI recommendation layer and prevents the LLM from being used as an authority system.
