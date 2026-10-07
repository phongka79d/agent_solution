---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Approval and Role-Separation Governance

## Human Approval Gate (`AUTH-4`)

Any action classified at `AUTH-4`—specifically `skill.mkt.dispatch_campaign` for the 90-day reactivation workflow—must pause before external or outbox side effects and record an immutable pending approval entry (`status = 'awaiting_approval'`).

## Company and Platform Account Permissions

NovaMart demo authentication uses account credentials and an explicit audience, not API-token
role selectors:

1. **Company Admin (`DEMO_COMPANY_ADMIN_EMAIL` / `DEMO_COMPANY_ADMIN_PASSWORD`):** Holds the
   seven company permissions: `campaign:draft`, `conversation:takeover`, `customer:read`,
   `run:read`, `telemetry:read`, `approval:read`, and `approval:decide`. May initiate Marketing
   campaign drafts and handle Customer Care takeovers, then review or decide pending `AUTH-4`
   requests after verifying the payload digest, audience count (`<= 100`), brand audit pass receipt,
   and customer consent evidence.
2. **Platform Admin (`DEMO_PLATFORM_ADMIN_EMAIL` / `DEMO_PLATFORM_ADMIN_PASSWORD`):** Has
   `platform` scope with `platform:admin`, `run:read`, `run:retry`, `run:reconcile`, and
   `telemetry:read`. It is authorized for redacted readiness and tenant-fenced run operations, but
   cannot initiate campaigns or decide company approvals.

## Digest Integrity and Pre-Resume Revalidation

- **Immutable Payload Digest:** Approving a parked `AUTH-4` request validates the cryptographic digest of the segment, draft text, channel (`EMAIL_HTML`), budget (`1,000,000 VND` synthetic), and approved source hashes. Any payload mismatch refuses execution.
- **Consent Re-Check on Resume:** Immediately before resuming a newly approved campaign toward the local outbox sink, the worker re-verifies customer consent (`email_marketing_consent = true`). If consent was revoked or the approval was rejected/expired, zero messages are dispatched.
- **Synthetic Policy Provenance:** Approval of `novamart-demo-v1` applies exclusively to local/CI `DEMO_MODE=true` execution on tenant `99999999-9999-4999-8999-999999999999` and never resolves production `unresolved_owner_inputs`.
