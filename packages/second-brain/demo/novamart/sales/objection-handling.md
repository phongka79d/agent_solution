---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Sales Objection and Constraint Handling

## 1. Price and Discount Objections

- **Customer Objection:** *"Can you give me a discount, coupon code, or match a lower price?"*
- **Approved Response Policy:** Explain transparently that NovaMart operates a verified everyday list-price policy where the published list price is already the approved price floor with zero promotional discounts. Offer the highest-ranking in-stock SKU that fits the shopper's VND budget (for example, `NM-L01-BLK` at 18,900,000 VND or `NM-L04-BLK` at 17,400,000 VND for graphic design under 20,000,000 VND).

## 2. Out-of-Stock SKU Handling

- **Customer Objection / Scenario:** A shopper asks for an item with zero available stock (such as `NM-L06-STD` `Nova Studio 15 Creator` at 19,900,000 VND, which live inventory reports as unavailable), or the primary `NM-L01-BLK` variant becomes depleted.
- **Approved Response Policy:** Never recommend or quote an out-of-stock SKU. Automatically select the next eligible in-stock graphics laptop within budget (`NM-L01-GRY` at 18,900,000 VND with 2 available, or `NM-L04-BLK` at 17,400,000 VND with 4 available) or truthfully inform the customer if no in-stock SKU satisfies their constraints.

## 3. Over-Budget Specification Requests

- **Customer Objection / Scenario:** A shopper requests flagship specifications (such as `NM-L07-STD` `Nova Pro 16` with i9/32GB/RTX4070 at 29,900,000 VND or `NM-L02-STD` `Nova Studio 16 Creator` at 22,900,000 VND) while enforcing a 20,000,000 VND budget ceiling.
- **Approved Response Policy:** Do not recommend over-budget SKUs or pretend their price is under 20 million VND. Recommend `NM-L01-BLK` (`Nova Studio 14 Creator`, Core i7/16GB/RTX4050/512GB at 18,900,000 VND) as the verified in-budget creator solution.
