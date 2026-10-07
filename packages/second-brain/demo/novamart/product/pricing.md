---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Pricing and Price-Floor Authority Policy

## Authoritative Pricing Source (`API-001`)

All commercial pricing for NovaMart (`tenant_id: 99999999-9999-4999-8999-999999999999`) is governed exclusively by the tenant-scoped API-001 commerce connector (`/prices/lookup` and `/catalog/products`).

1. **Mandatory Live Lookup:** Before recommending a product or sending a price-bearing message (`skill.sales.recommend_product` and `skill.sales.send_message`), the Sales runtime must execute `skill.sales.check_price` and obtain a valid, non-expired signed quote from API-001.
2. **Currency and Tax Representation:** All prices are denominated in integer Vietnamese Dong (`currency: VND`). Quotes must match the exact unit price and currency returned by API-001; foreign currency conversions (such as TWD or USD) are rejected.
3. **Owner-Approved Floor Price (`P_floor`):** Under synthetic demo policy `novamart-demo-v1`, the owner-reviewed price floor equals the published list price (`P_floor = list_price`). Database mirror fields such as `cost_of_goods` (`0.70 * list_price`) and informational `minimum_margin_rate` (`0.10`) never authorize quoting below `P_floor`.
4. **No-Discount Rule:** Zero discretionary discounts, coupon reductions, or below-floor quotes are permitted (`max_discount_vnd = 0`). Proposed unit price must satisfy `unit_price >= P_floor` (`unit_price == list_price`).

## Quote Provenance and Fail-Closed Rules

- **Signed Quote TTL:** Every API-001 price quote carries cryptographic signature verification, `source: novamart-demo-v1`, and a strict 15-minute expiration window from request time.
- **Refusal Conditions:** If API-001 returns `P_FLOOR_UNAVAILABLE`, if the quote signature is invalid or expired, or if the candidate SKU's verified price exceeds the customer's stated `budget_vnd` ceiling, the runtime must halt before recommendation and refuse to fabricate a price.
