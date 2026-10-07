---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Marketing Campaign Governance Rules

## Mandatory Operational Controls

1. **Audience Cap (`ASM-003 = 100`):** Every campaign segment created under `novamart-demo-v1` is strictly bounded to a maximum of `100` target recipients (`cap = 100`). Any segment query or dispatch request exceeding 100 profiles or lacking an explicit cap is refused.
2. **Inactivity Eligibility (`min_days_inactive = 90`):** For 90-day reactivation campaigns, only customers with `last_paid_purchase < DEMO_AS_OF - 90 days` (`DEMO_AS_OF = 2026-09-28T00:00:00Z`) are eligible. Cancelled orders (`ORD-DEMO-017`) and unpaid pending orders do not count as paid purchases.
3. **Email Opt-Out Enforcement:**
   - Customers with `email_marketing_consent = false` (specifically `C08` and `C12`) must be suppressed during segmentation and re-checked during `skill.mkt.check_consent`.
   - Consent is re-verified immediately prior to any post-approval resume; if consent was revoked while `awaiting_approval`, dispatch is blocked.
4. **Mandatory `AUTH-4` Human Approval:**
   - `skill.mkt.dispatch_campaign` requires authority level `AUTH-4` and parks the run in `awaiting_approval` status (`campaign.status = 'awaiting_approval'`).
   - Role separation is enforced: the tenant creator (`campaign:create`) cannot approve their own campaign; a distinct tenant approver (`approval:decide`) must review the audience count, brand compliance receipt, consent evidence, and immutable payload digest.
5. **Local-Only Outbox Boundary:** Even after `AUTH-4` approval in `DEMO_MODE`, delivery writes exclusively to the local synthetic outbox sink and never transmits live external emails.
