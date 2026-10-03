---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Platform Authority Policy

## Controlled Autonomy Levels

All autonomous actions in NovaMart are brokered through the platform's revenue orchestration, policy enforcement, and domain policy controls under six graduated authority tiers:

- **Tier 0 — Disabled / Read-Zero:** Default state for newly provisioned tenants; no autonomous action permitted.
- **Tier 1 — Read-Only Context & Discovery:** Permits non-mutating, tenant-scoped reads such as customer context retrieval, catalog search, stock and price checks, FAQ search, verified order lookup, audience segmentation, brand-compliance checks, and consent checks.
- **Tier 2 — Guarded Advisory & Internal Drafting:** Permits evidence-bound product recommendations, language-model content generation, and Customer Care human-escalation handoffs.
- **Tier 3 — Supervised One-to-One Customer Reply:** Permits policy-checked, single-recipient customer replies when backed by verified price and stock quotes, customer consent, and the absence of human takeover locks.
- **Tier 4 — Explicit Human Approval Required:** Mandatory gate for multi-recipient or commercial-commitment effects, including Marketing campaign dispatch and cart or order mutations. Execution pauses pending approval until an authorized human operator approves the immutable payload digest.
- **Tier 5 — Restricted Executive Authority:** Reserved for owner-level governance; never granted to autonomous assistants in this demo.

## Trust Boundary Invariants

Model outputs supply bounded typed hypotheses and grounded text formatting only and **never** assign tenant identity, customer identity, action identity, required authority, effect keys, unit prices, floor prices, or approval status.
