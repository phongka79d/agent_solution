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

Before recommending hardware, the Sales runtime qualifies the shopper's inquiry into bounded typed requirements (`category`, `budget_vnd`, `use_case`):

1. **Product Category (`category`):** Maps shopper intent to one of the four canonical NovaMart merchandise categories: `laptops`, `monitors`, `accessories`, or `storage`.
2. **Maximum Budget Ceiling (`budget_vnd`):** Normalizes Vietnamese currency expressions (such as `"under 20 million"`, `"dưới 20 triệu"`, or `"20,000,000 VND"`) into an exact integer VND ceiling (`20000000`). Candidate SKUs whose API-001 unit price exceeds `budget_vnd` are disqualified.
3. **Workload Use Case (`use_case`):**
   - `graphic design` / `design`: Requires discrete NVIDIA GeForce RTX graphics (`RTX 3050`, `RTX 4050`, `RTX 4060`, or `RTX 4070`), at least `16GB RAM`, and fast NVMe SSD storage (or color-calibrated `NovaColor` 4K displays for monitors).
   - `office`: Prioritizes multi-core CPU efficiency (`Core i5`/`Ryzen 7`), `16GB RAM`, 512GB SSD, and dependable battery life (`Nova Work 14` / `Nova Work 15`).
   - `travel`: Prioritizes lightweight portability (`Nova Air 13`, `12,400,000 VND`).

## Eligibility and Consent Preconditions

- **Channel and Service Consent:** One-to-one outbound advisory messages (`skill.sales.send_message`) require active `WEB_CHAT` channel context, verified customer consent where applicable, and absence of an active human takeover lock (`CONVERSATION_LOCKED`).
- **Live Commercial Verification:** Qualification never substitutes for live API-001 verification; every candidate must pass both `skill.sales.check_stock` (`available_qty > 0`) and `skill.sales.check_price` (`unit_price <= budget_vnd` and `unit_price >= P_floor`).
