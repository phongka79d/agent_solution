---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Approval and Role-Separation Governance

## Human Approval Gate

Any action requiring Tier 4 authority—specifically multi-recipient Marketing campaign dispatch for the 90-day reactivation workflow—must pause before external or outbox side effects and record an immutable pending approval entry.

## Company and Platform Account Roles

NovaMart demo authentication uses account credentials and an explicit audience, not API-token role selectors:

1. **Company Admin:** Holds the company's administrative permissions, may initiate Marketing campaign drafts and handle Customer Care takeovers, then review or decide pending Tier 4 requests after verifying the payload digest, audience count (at most 100), brand-audit pass receipt, and customer consent evidence.
2. **Platform Admin:** Has platform scope for readiness inspection and tenant-fenced run operations, but cannot initiate campaigns or decide company approvals.

## Digest Integrity and Pre-Resume Revalidation

- **Immutable Payload Digest:** Approving a parked Tier 4 request validates the cryptographic digest of the segment, draft text, channel, budget, and approved source hashes. Any payload mismatch refuses execution.
- **Consent Re-Check on Resume:** Immediately before resuming a newly approved campaign toward the local outbox sink, the worker re-verifies customer marketing consent. If consent was revoked or the approval was rejected or expired, zero messages are dispatched.
- **Synthetic Policy Provenance:** Approval applies exclusively to local and CI demo execution on the NovaMart demo tenant and never resolves production owner-input decisions.
