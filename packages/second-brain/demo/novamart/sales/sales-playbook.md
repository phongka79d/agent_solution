---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Sales Advisory Playbook

## Guarded Storefront Advisory Flow (`WEB_CHAT`)

When a shopper submits a product inquiry on the NovaMart storefront (`source_channel: WEB_CHAT`, `event_type: message.received`), the Sales runtime (`SalesAgentRuntime`) executes a deterministic, receipt-bound advisory sequence through `RevenueOrchestrator`:

1. **Customer Context Retrieval (`skill.sales.retrieve_customer`):** Loads verified Customer360 profile, loyalty tier (such as `C05` GOLD), timeline context, and service chat consent when a verified session is bound.
2. **Catalog Search (`skill.sales.search_product`):** Queries API-001 using normalized category and use-case filters (for example, `category: laptops`, `use_case: graphic design`).
3. **Deterministic Candidate Ranking:** Selects one optimal candidate SKU strictly from same-run API-001 search receipts based on active status, category match, graphics/specification alignment, and `unit_price <= budget_vnd` (breaking ties deterministically by SKU code; never trusting model-invented SKUs). For a `20,000,000 VND` graphic-design laptop request, `NM-L01-BLK` (`Nova Studio 14 Creator`, i7/16GB/RTX4050/512GB at `18,900,000 VND`) ranks first ahead of `NM-L01-GRY` and `NM-L04-BLK`.
4. **Live Inventory Verification (`skill.sales.check_stock`):** Confirms positive available-to-promise stock (`available_qty > 0`, e.g., 5 units available for `NM-L01-BLK` across `WH-HCM` and `WH-HN`). Out-of-stock items such as `NM-L06-STD` (`available_qty = 0`) are rejected.
5. **Signed Price and Floor Verification (`skill.sales.check_price`):** Verifies current VND unit price, owner-approved floor price (`P_floor = list_price`), and 15-minute signed quote provenance (`novamart-demo-v1`). Over-budget items such as `NM-L07-STD` (`29,900,000 VND`) are rejected.
6. **Constrained Recommendation (`skill.sales.recommend_product`):** Binds the verified SKU (`candidate_skus`) and maximum verified quote (`max_price_vnd`) to record an auditable recommendation receipt on the customer timeline.
7. **Grounded Customer Reply (`skill.sales.send_message`):** Formats a one-to-one response citing the verified SKU, exact VND price, warehouse availability, and no-discount policy (`P_floor = list_price`), then dispatches once through the guarded chat outbox.

## Autonomous Transaction Boundaries

- **No Autonomous Cart or Order Creation:** Sales advisory runs never autonomously execute `skill.sales.create_cart` or `skill.sales.create_order`, which remain gated behind explicit confirmation and payment controls.
