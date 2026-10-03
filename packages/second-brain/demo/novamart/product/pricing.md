---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Pricing and Price-Floor Policy

## Authoritative Pricing Source

All commercial pricing for NovaMart is governed exclusively by the tenant-scoped commerce connector (`/prices/lookup` and `/catalog/products`).

1. **Mandatory Live Lookup:** Before recommending a product or sending a price-bearing message, the Sales assistant must perform a live price check and obtain a valid, non-expired signed quote from the commerce connector.
2. **Currency and Tax Representation:** All prices are denominated in integer Vietnamese Dong (`VND`). Quotes must match the exact unit price and currency returned by the live source; foreign currency conversions (such as TWD or USD) are rejected.
3. **Owner-Approved Floor Price:** Under this demo policy, the owner-reviewed price floor equals the published list price. Internal cost fields and informational margin figures never authorize quoting below the approved floor.
4. **No-Discount Rule:** Zero discretionary discounts, coupon reductions, or below-floor quotes are permitted. A proposed unit price must be at or above the approved floor, which equals the list price.

## Quote Provenance and Fail-Closed Rules

- **Signed Quote TTL:** Every price quote carries cryptographic signature verification and a strict 15-minute expiration window from request time.
- **Refusal Conditions:** If the price floor is unavailable, if the quote signature is invalid or expired, or if the candidate product's verified price exceeds the customer's stated budget ceiling, the assistant must halt before recommending and refuse to fabricate a price.
