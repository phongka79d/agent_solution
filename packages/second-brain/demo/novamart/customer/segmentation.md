---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# Customer Segmentation and 90-Day Reactivation Policy

## Canonical 90-Day Inactive Reactivation Definition

For NovaMart tenant `99999999-9999-4999-8999-999999999999`, the `inactive90` reactivation segment identifies existing customers who have not completed a paid purchase within the 90-day window preceding the evaluation anchor (`DEMO_AS_OF = 2026-09-28T00:00:00Z`):

- **Qualifying Purchase Criterion:** `last_paid_purchase < DEMO_AS_OF - 90 days` (i.e., strictly earlier than `2026-06-30T00:00:00Z`).
- **Qualifying Order Statuses:** Only orders with authoritative settled payment or fulfillment (`PAID`, `SHIPPED`, `DELIVERED`) count toward `last_paid_purchase`.
- **Non-Qualifying Order Statuses:** `CANCELLED` and unpaid `PENDING` orders never reset a customer's inactivity clock. Specifically, `ORD-DEMO-017` (`CANCELLED` at `DEMO_AS_OF - 60d` for `C05`) does not reset `C05`'s last paid purchase (`ORD-DEMO-005`, purchased at `DEMO_AS_OF - 120d`, delivered at `DEMO_AS_OF - 118d`), so `C05` qualifies for the 90-day reactivation segment.

## Consent and Suppression Rules

1. **Explicit Promotional Consent Required:** Every candidate profile in `skill.mkt.segment_audience` and `skill.mkt.check_consent` must hold active, unrevoked `EMAIL_HTML` marketing consent (`consent_granted = true`).
2. **Mandatory Exclusions:**
   - Profiles with revoked or false email marketing consent (such as `C08` and `C12`) must be excluded from the target audience before content dispatch approval.
   - If a customer revokes consent after draft creation (`awaiting_approval`), any subsequent resume or dispatch check must fail closed and block delivery.
3. **Audience Cap (`ASM-003`):** Synthetic demo policy caps any single reactivation segment at a maximum of `100` eligible recipients (`cap = 100`).
4. **Epistemic Classification:** Segment eligibility derived from purchase history and behavioral signals is stamped with `classification: HYPOTHESIS` backed by cited Customer360 and consent evidence, and is never promoted to an immutable identity `FACT`.
