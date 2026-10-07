---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Customer Profiles and Purpose-Limited Data Policy

## Synthetic Customer Cohort (`C01`–`C12`)

NovaMart maintains twelve deterministic synthetic customer profiles (`99000000-0000-4000-8000-000000000001` through `99000000-0000-4000-8000-000000000012`) across three loyalty tiers:

- **GOLD Tier (`C05`):** High-affinity creator and design hardware shopper (`99000000-0000-4000-8000-000000000005`). Holds verified `WEB_CHAT` session eligibility when launched by an authorized demo operator, active `EMAIL_HTML` marketing opt-in consent, active service chat consent, and historical delivered order `ORD-DEMO-005` (purchased 120 days prior to `DEMO_AS_OF = 2026-09-28T00:00:00Z`, delivered 118 days prior).
- **SILVER and BASIC Tiers (`C01`–`C04`, `C06`–`C12`):** Alternating loyalty profiles representing diverse purchase histories, consent states, and identity verification statuses across Ho Chi Minh City and Hanoi.
- **Notable Boundary Profiles:**
  - `C08`: Explicit email marketing opt-out (`email_marketing_consent = false`); eligible for transactional care when verified, but strictly suppressed from Marketing segmentation and campaign drafts.
  - `C12`: Unverified channel identity (`verified_at = NULL`) and email marketing opt-out; denied access to private order status lookups and excluded from promotional audiences.

## Purpose-Limited Data Usage

1. **Sales Advisory (`WEB_CHAT`):** Uses customer tier, active session requirements (`category`, `budget_vnd`, `use_case`), and service chat consent to recommend in-stock SKUs and deliver one-to-one quotes.
2. **Customer Care (`WEB_CHAT`):** Public FAQ inquiries may be answered for both verified and anonymous sessions using approved Second Brain citations. Private order inquiries (`skill.care.lookup_order`) strictly require a server-verified channel identity (`verified_at IS NOT NULL`) whose `customer_id` matches the API-001 order record.
3. **Marketing Reactivation (`EMAIL_HTML`):** Uses historical paid order timestamps (`last_paid_purchase`) and explicit `EMAIL_HTML` promotional consent to propose audience segments. Inferred segment membership is recorded as `HYPOTHESIS`, never `FACT`.
