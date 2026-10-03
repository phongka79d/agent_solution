---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Customer Profiles and Purpose-Limited Data Policy

## Synthetic Customer Cohort

NovaMart maintains twelve deterministic synthetic customer profiles across three loyalty tiers:

- **GOLD Tier:** High-affinity creator and design hardware shopper. Holds verified storefront chat eligibility when launched by an authorized demo operator, active marketing opt-in consent, active service chat consent, and a historical delivered order.
- **SILVER and BASIC Tiers:** Alternating loyalty profiles representing diverse purchase histories, consent states, and identity verification statuses across Ho Chi Minh City and Hanoi.
- **Notable Boundary Profiles:**
  - Customer with explicit email marketing opt-out; eligible for transactional care when verified, but strictly suppressed from Marketing segmentation and campaign drafts.
  - Customer with an unverified channel identity and email marketing opt-out; denied access to private order status lookups and excluded from promotional audiences.

## Purpose-Limited Data Usage

1. **Sales Advisory:** Uses customer tier, active session requirements (category, budget, use case), and service chat consent to recommend in-stock SKUs and deliver one-to-one quotes.
2. **Customer Care:** Public FAQ inquiries may be answered for both verified and anonymous sessions using approved knowledge citations. Private order inquiries strictly require a server-verified channel identity whose customer identity matches the authoritative order record.
3. **Marketing Reactivation:** Uses historical paid order timestamps and explicit promotional consent to propose audience segments. Inferred segment membership is recorded as a hypothesis, never as an immutable fact.
