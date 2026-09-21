# Implement 12: Identity Verification, Consent Lifecycle, and Data Access Boundaries

> **BLUEPRINT STATUS — design-level specification only.**
> This document defines the platform's customer identity verification, consent lifecycle, and customer-data access boundaries. It is an architectural blueprint for the Gate P0 foundation stage and does not rely on real customer data or production deployment. The exact thresholds and retention periods are placeholder values to be approved by the tenant and legal/compliance owners.

## 1. Purpose

The AgentOS platform operates in a high-trust customer context: AI is expected to help with product guidance, order support, and commercial assistance. That requires a strict separation between:

- unauthenticated browsing,
- verified customer identity,
- consented customer contact,
- and customer-specific account access.

This document defines how the system verifies identity, governs consent, and limits access to customer data so that AI never leaks, guesses, or overreaches into customer information outside the verified session context.

---

## 2. Design Principles

1. **No private data without verified identity**
   - The platform must verify the customer before reading any private profile or order detail.

2. **Consent is channel-specific and time-bound**
   - A customer can consent to marketing on LINE but not on email; the platform must track this independently.

3. **Context is single-customer only**
   - A session bound to customer A must never include customer B profile or order context.

4. **Fail closed**
   - If identity, consent, or policy context is invalid or missing, the system does not guess; it blocks or routes to human review.

5. **Audit every identity and consent decision**
   - Evidence of who verified the identity and when consent was given must be recorded.

---

## 3. Identity Verification Model

### 3.1 Identity States

```text
UNVERIFIED -> VERIFIED -> REJECTED
         \-> EXPIRED
         \-> REVOKED
```

### 3.2 Verification Methods

Identity verification may occur through one or more approved methods depending on the channel and risk profile:

- authenticated session token,
- verified mobile or email challenge,
- signed order lookup token,
- known customer account login,
- internal CSR-assisted verification,
- approved partner verification method.

### 3.3 Rules

- The system never trusts a client-side identity claim as authoritative.
- Customer data access is permitted only after server-side verification.
- A verification step must happen before any private profile, order, or payment record lookup.
- If verification fails or expires, the session must downgrade to generic help mode only.

---

## 4. Customer Session Context Model

### 4.1 Session Binding

Each customer-facing conversation session is bound to:

- `tenant_id`
- `session_id`
- `customer_id` only after verified identity
- `channel_id` or channel origin
- `correlation_id`

### 4.2 Single-Customer Access Rule

```text
If session.customer_id is null -> no private profile or order lookup allowed.
If session.customer_id is set -> only records associated with that customer can be loaded.
If a cross-customer match is detected -> block and log security event.
```

### 4.3 Context Isolation Rule

The AI runtime must receive context only for the verified customer bound to the active session. It must never combine:

- customer A profile,
- customer B order data,
- customer C consent state,
- customer D historical event sequence.

Cross-session memory access is forbidden unless explicitly bound to the same verified customer and valid tenant scope.

---

## 5. Consent Model

### 5.1 Consent Types

The platform recognizes at least the following consent classes:

- `marketing_messaging`
- `order_updates`
- `analytics`
- `retention_followup`
- `profile_reuse`

Each consent record is channel-specific and tenant-scoped:

- `channel` = LINE / WhatsApp / email / SMS / web / app
- `is_granted`
- `opt_in_method`
- `opt_in_timestamp`
- `opt_out_timestamp`
- `evidence_text`

### 5.2 Consent Lifecycle

```text
UNSET -> GRANTED -> WITHDRAWN
   \-> EXPIRED
   \-> REPLACED
```

### 5.3 Channel-Specific Consent Rule

Marketing consent is never globally assumed. A customer may consent on one channel but not another. The platform must evaluate the required channel and consent status separately.

Examples:

- LINE consent granted → allowed for LINE messages
- email consent absent → blocked for email marketing
- order update consent present → allowed for transactional notifications only

### 5.4 Consent Enforcement Rule

AI must not send outbound promotional messages without valid, current consent for the target channel and message type.

If consent is missing or expired:

- the system must not trigger outbound campaign sends,
- it must instead route the contact to an approved human workflow or generic informational response.

---

## 6. Data Access Tiers

The customer-data access model should be defined as the following tiers:

### Tier 0: Public / non-sensitive
- general product info
- public FAQ entries
- public brand information
- public support guidance

### Tier 1: Session-scoped non-private
- current conversation transcript
- previously verified session state for the same customer
- user-provided information within the current interaction

### Tier 2: Verified customer private access
- order status
- customer profile
- shipping information
- identity and consent metadata
- support history relevant to the verified customer

### Tier 3: Restricted sensitive operational data
- finance and payment details
- internal CSR notes
- audit records
- policy exceptions
- legal / compliance decisions

Only roles explicitly permitted by policy may access Tier 3 data. AI agents never receive direct Tier 3 access without explicit approval and technical controls.

---

## 7. Customer Data Access Decision Flow

```text
Customer request arrives
        ↓
Check tenant scope
        ↓
Check channel identity
        ↓
Check server-side verification status
        ↓
If not verified -> deny private data access
        ↓
Check consent + policy + role permissions
        ↓
Load only relevant customer-scoped data
        ↓
Generate response or action proposal
        ↓
Log evidence
```

---

## 8. Identity and Consent Evidence Record

Every verification and consent event must record:

- `tenant_id`
- `customer_id` when available
- `session_id`
- `verification_method`
- `verification_timestamp`
- `succeed_or_fail`
- `consent_type`
- `channel`
- `opt_in_method`
- `evidence_text`
- `operator_id` if human-assisted
- `correlation_id`

This evidence must be retained in the immutable audit layer and should be queryable for legal, support, and security review.

---

## 9. Safety and Privacy Fail-Closed Rules

The platform must fail closed whenever any of the following is true:

- customer identity is not verified for private data access,
- customer consent is not present for the target channel and action,
- the session is not bound to a single verified customer,
- the data requested belongs to another tenant,
- the retrieval path cannot establish provenance,
- a privacy policy is missing or ambiguous.

Failure must lead to one of these outcomes:

- reject the request,
- ask the customer to verify identity,
- route to human support,
- or present only generic public information.

---

## 10. Human Handoff Rules

When the system cannot safely access or act on customer data, it must present a clear safe handoff path:

- human takeover in SCR-005,
- specialized support queue,
- verification flow,
- or a generic informational response with no private data disclosure.

The AI must never continue uncertain customer-specific behavior after a verification or consent failure.

---

## 11. Minimal Design Acceptance Criteria

The design is acceptable at the blueprint stage when all of the following are true:

1. Private customer data access requires verified identity.
2. Consent is channel-specific and timestamped.
3. A session carries only a single verified customer context.
4. AI cannot switch customer context without a new verified session.
5. Missing consent or identity causes fail-closed behavior.
6. Every verification and consent event is recorded with evidence.
7. Human handoff is available whenever identity or consent is uncertain.

---

## 12. Recommended Follow-On Artifact

The next design artifact aligned to this blueprint is:

- **13-operational-runbook.md**

This will define operational failure modes, incident handling, customer privacy escalation, and policy-driven safe recovery flows.
