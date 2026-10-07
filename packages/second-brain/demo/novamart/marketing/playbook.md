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

Marketing campaigns in NovaMart (`tenant_id: 99999999-9999-4999-8999-999999999999`) are strictly operator-initiated via `POST /api/v1/campaigns/drafts` requiring `campaign:create` permission and are never triggered from the public storefront widget.

### Standard Reactivation Parameters

- **Objective:** `reactivation` (re-engaging customers inactive for at least 90 days prior to `DEMO_AS_OF = 2026-09-28T00:00:00Z`).
- **Inactivity Threshold:** `min_days_inactive: 90` (`last_paid_purchase < DEMO_AS_OF - 90d`).
- **Channel and Locale:** `channel: EMAIL_HTML`, `locale: vi-VN`.
- **Synthetic Budget Limit:** `budget_limit: 1000000` VND (informational demo cap; zero real monetary spend).

## Fixed Canonical Five-Skill Execution Sequence

1. **`skill.mkt.segment_audience`:** Queries Customer360 paid order history and consent records to construct the `inactive90` segment under the synthetic `ASM-003` audience cap (`cap = 100`). Includes eligible opted-in customers such as `C05` (`last_paid_purchase` at `DEMO_AS_OF - 120d`) and excludes opted-out profiles such as `C08` and unverified `C12`.
2. **`skill.mkt.generate_content`:** Invokes the bound OpenAI-compatible provider (`Core.LLMContentEngine`) to author a Vietnamese (`vi-VN`) HTML reactivation email grounded in `brand/voice.md`, `brand/terminology.md`, and `marketing/content-guidelines.md`.
3. **`skill.mkt.audit_brand_compliance`:** Runs deterministic MKT-04 screening against `brand/prohibited-claims.md` and verifies SHA-256 `source_version` provenance across all five allowlisted Marketing documents.
4. **`skill.mkt.check_consent`:** Verifies active `EMAIL_HTML` promotional consent for every member of the resolved segment and removes any suppressed recipient.
5. **`skill.mkt.dispatch_campaign` (`AUTH-4` Approval Gate):** Reserves the immutable payload digest and transitions the campaign to `awaiting_approval` under `AUTH-4`. **No external email or local outbox dispatch occurs until a separate authorized approver (`approval:decide`) explicitly approves the unchanged digest.**
