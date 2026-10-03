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

1. **Audience Cap:** Every campaign segment created under this demo policy is strictly bounded to a maximum of 100 target recipients. Any segment query or dispatch request exceeding 100 profiles or lacking an explicit cap is refused.
2. **Inactivity Eligibility:** For 90-day reactivation campaigns, only customers whose last paid purchase occurred strictly earlier than 90 days before the evaluation anchor are eligible. Cancelled orders and unpaid pending orders do not count as paid purchases.
3. **Email Opt-Out Enforcement:**
   - Customers with email marketing consent disabled must be suppressed during segmentation and re-checked immediately before dispatch.
   - Consent is re-verified immediately prior to any post-approval resume; if consent was revoked while the campaign awaited approval, dispatch is blocked.
4. **Mandatory Human Approval:**
   - Multi-recipient Marketing campaign dispatch requires explicit human approval and parks the run in an awaiting-approval state.
   - Role separation is enforced: the tenant creator of a campaign cannot approve their own campaign; a distinct tenant approver must review the audience count, brand-compliance receipt, consent evidence, and immutable payload digest.
5. **Local-Only Outbox Boundary:** Even after approval in demo mode, delivery writes exclusively to the local synthetic outbox sink and never transmits live external emails.
