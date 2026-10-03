---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Sales Qualification Framework

## Structured Requirement Extraction

Before recommending hardware, the Sales assistant qualifies the shopper's inquiry into bounded typed requirements (category, budget, use case):

1. **Product Category:** Maps shopper intent to one of the four canonical NovaMart merchandise categories: `laptops`, `monitors`, `accessories`, or `storage`.
2. **Maximum Budget Ceiling:** Normalizes Vietnamese currency expressions (such as `"under 20 million"`, `"dưới 20 triệu"`, or `"20,000,000 VND"`) into an exact integer VND ceiling (`20000000`). Candidate SKUs whose live unit price exceeds the budget ceiling are disqualified.
3. **Workload Use Case:**
   - `graphic design` / `design`: Requires discrete NVIDIA GeForce RTX graphics (RTX 3050, RTX 4050, RTX 4060, or RTX 4070), at least 16GB RAM, and fast NVMe SSD storage (or color-calibrated `NovaColor` 4K displays for monitors).
   - `office`: Prioritizes multi-core CPU efficiency (Core i5 / Ryzen 7), 16GB RAM, 512GB SSD, and dependable battery life (`Nova Work 14` / `Nova Work 15`).
   - `travel`: Prioritizes lightweight portability (`Nova Air 13`, 12,400,000 VND).

## Eligibility and Consent Preconditions

- **Channel and Service Consent:** One-to-one outbound advisory messages require an active storefront chat context, verified customer consent where applicable, and the absence of an active human takeover lock.
- **Live Commercial Verification:** Qualification never substitutes for live verification; every candidate must pass both a live stock check (positive available quantity) and a live price check (unit price at or above the approved floor and within the customer's budget).
