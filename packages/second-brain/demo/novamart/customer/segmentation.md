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

For NovaMart, the 90-day inactive reactivation segment identifies existing customers who have not completed a paid purchase within the 90-day window preceding the evaluation anchor:

- **Qualifying Purchase Criterion:** The customer's last paid purchase occurred strictly earlier than 90 days before the evaluation anchor.
- **Qualifying Order Statuses:** Only orders with authoritative settled payment or fulfillment count toward the last paid purchase date.
- **Non-Qualifying Order Statuses:** Cancelled and unpaid pending orders never reset a customer's inactivity clock. A cancelled order does not reset a customer's last paid purchase, so an otherwise-eligible customer remains in the 90-day reactivation segment.

## Consent and Suppression Rules

1. **Explicit Promotional Consent Required:** Every candidate profile in audience segmentation and consent checking must hold active, unrevoked email marketing consent.
2. **Mandatory Exclusions:**
   - Profiles with revoked or false email marketing consent must be excluded from the target audience before content dispatch approval.
   - If a customer revokes consent after draft creation, any subsequent resume or dispatch check must fail closed and block delivery.
3. **Audience Cap:** Synthetic demo policy caps any single reactivation segment at a maximum of 100 eligible recipients.
4. **Epistemic Classification:** Segment eligibility derived from purchase history and behavioral signals is stamped as a hypothesis backed by cited customer and consent evidence, and is never promoted to an immutable identity fact.
