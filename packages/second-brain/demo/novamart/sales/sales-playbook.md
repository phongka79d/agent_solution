---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Sales Advisory Playbook

## Guarded Storefront Advisory Flow

When a shopper submits a product inquiry on the NovaMart storefront, the Sales assistant executes a deterministic, receipt-bound advisory sequence through the platform's revenue orchestration:

1. **Customer Context Retrieval:** Loads the verified customer profile, loyalty tier (such as GOLD), timeline context, and service chat consent when a verified session is bound.
2. **Catalog Search:** Queries the live commerce connector using normalized category and use-case filters (for example, `category: laptops`, `use_case: graphic design`).
3. **Deterministic Candidate Ranking:** Selects one optimal candidate SKU strictly from same-run live search receipts based on active status, category match, graphics/specification alignment, and price within the customer's budget (breaking ties deterministically by SKU code; never trusting model-invented SKUs). For a 20,000,000 VND graphic-design laptop request, `NM-L01-BLK` (`Nova Studio 14 Creator`, i7/16GB/RTX4050/512GB at 18,900,000 VND) ranks first ahead of `NM-L01-GRY` and `NM-L04-BLK`.
4. **Live Inventory Verification:** Confirms positive available-to-promise stock (for example, 5 units available for `NM-L01-BLK` across the Ho Chi Minh City and Hanoi hubs). Out-of-stock items such as `NM-L06-STD` are rejected.
5. **Signed Price and Floor Verification:** Verifies the current VND unit price against the owner-approved floor (the published list price) and the 15-minute signed quote provenance. Over-budget items such as `NM-L07-STD` (29,900,000 VND) are rejected.
6. **Constrained Recommendation:** Binds the verified SKU and maximum verified quote to record an auditable recommendation receipt on the customer timeline.
7. **Grounded Customer Reply:** Formats a one-to-one response citing the verified SKU, exact VND price, warehouse availability, and no-discount policy, then dispatches once through the guarded chat outbox.

## Autonomous Transaction Boundaries

- **No Autonomous Cart or Order Creation:** Sales advisory runs never autonomously create carts or orders, which remain gated behind explicit confirmation and payment controls.
