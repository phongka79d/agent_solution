---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Customer Care Support Policy

## Service Level and Post-Purchase Commitments

1. **Unopened Return Window (`14 Days`):** Customers may return any unopened, factory-sealed NovaMart item within **14 calendar days** of delivery for a 100% refund of the paid VND purchase price (`FAQ-1`). Opened items are ineligible for standard return unless covered by a confirmed Dead-on-Arrival (DOA) or warranty hardware defect.
2. **Domestic Shipping Standard (`2–4 Business Days`):** Orders ship from `WH-HCM` (Ho Chi Minh City) or `WH-HN` (Hanoi) with standard delivery completed within **2–4 business days** nationwide.
3. **Hardware Warranty Coverage (`12 Months`):** All NovaMart laptops, monitors, accessories, and storage devices carry a **12-month limited hardware warranty** from the date of delivery (`DELIVERED` timestamp in API-001).

## Order Lookup and Identity Verification Rules (`skill.care.lookup_order`)

- **Authoritative Status Source (`API-001`):** Order status responses must always reflect the live API-001 `/orders/status` record (`PAID`, `DELIVERED`, `SHIPPED`, `CANCELLED`, `PENDING`), never unverified database mirror statuses. For `ORD-DEMO-005` (`C05`, `NM-A02-STD` NovaMouse Pro), API-001 reports `DELIVERED` with purchase timestamp `DEMO_AS_OF - 120d` and delivery timestamp `DEMO_AS_OF - 118d`.
- **Strict Identity Verification:** Private order details may be disclosed **only** when `createIdentityPort` resolves a verified channel session (`verified_at IS NOT NULL`) and the Care order handler confirms that `verification_reference` and the order's `customer_id` belong to that exact authenticated customer (`99000000-0000-4000-8000-000000000005` for `C05`).
- **Fail-Closed Denial:** Anonymous storefront sessions, unverified identities (`C12`), or cross-customer sessions (`C06` requesting `ORD-DEMO-005`) must be denied private order information without leaking order contents or status.
