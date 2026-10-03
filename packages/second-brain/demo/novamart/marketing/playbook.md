---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Marketing Reactivation Playbook

## Operator-Initiated Reactivation Workflow

Marketing campaigns in NovaMart are strictly operator-initiated and are never triggered from the public storefront widget.

### Standard Reactivation Parameters

- **Objective:** Reactivation (re-engaging customers inactive for at least 90 days prior to the evaluation anchor).
- **Inactivity Threshold:** 90 days (last paid purchase strictly earlier than 90 days before the anchor).
- **Channel and Locale:** HTML email, Vietnamese (`vi-VN`).
- **Synthetic Budget Limit:** 1,000,000 VND (informational demo cap; zero real monetary spend).

## Fixed Canonical Five-Step Execution Sequence

1. **Audience Selection:** Queries customer paid order history and consent records to construct the 90-day inactive segment under the synthetic audience cap (at most 100 recipients). Includes eligible opted-in customers and excludes opted-out or unverified profiles.
2. **Content Generation:** Invokes the bound language-model provider to author a Vietnamese (`vi-VN`) HTML reactivation email grounded in `brand/voice.md`, `brand/terminology.md`, and `marketing/content-guidelines.md`.
3. **Brand Compliance Audit:** Runs deterministic brand-compliance screening against `brand/prohibited-claims.md` and verifies source-hash provenance across all five allowlisted Marketing documents.
4. **Consent Check:** Verifies active promotional consent for every member of the resolved segment and removes any suppressed recipient.
5. **Dispatch with Approval Gate:** Reserves the immutable payload digest and transitions the campaign to awaiting-approval under the human approval gate. **No external email or local outbox dispatch occurs until a separate authorized approver explicitly approves the unchanged digest.**
