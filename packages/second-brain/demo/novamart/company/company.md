---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Vietnam — Synthetic Company Profile

## Overview and Demo Boundary

NovaMart Vietnam (`tenant_id: 99999999-9999-4999-8999-999999999999`) is a dedicated synthetic Vietnamese consumer and prosumer electronics retailer created exclusively for local and CI three-agent demonstrations. All policies, product lines, customer personas, and operational rules in this corpus carry `synthetic: true` provenance under `source_version: novamart-demo-v1` and never represent a live production merchant or substitute for real merchant owner sign-off.

## Core Retail Operations

- **Primary Market and Locale:** Vietnam domestic retail and online storefront (`locale: vi-VN`), operating in Vietnamese Dong (`currency: VND`).
- **Fulfillment Network:** Dual regional distribution hubs located in Ho Chi Minh City (`WH-HCM`, holding roughly 70% of baseline allocation) and Hanoi (`WH-HN`, holding roughly 30% of baseline allocation).
- **Merchandise Lines:** Creator and office laptops (`NM-L01` through `NM-L08`), FHD/QHD/4K and ultrawide monitors (`NM-M01` through `NM-M06`), productivity accessories (`NM-A01` through `NM-A06`), and high-speed NVMe/portable storage (`NM-S01` through `NM-S04`).
- **Customer Channels:** Supervised storefront web chat (`WEB_CHAT`) for Sales advisory and Customer Care support, and operator-initiated HTML email (`EMAIL_HTML`) for consented Marketing reactivation drafts.

## System of Record and Governance Principles

1. **Commercial Authority (`API-001`):** Real-time unit pricing, owner-approved floor prices (`P_floor`), signed price quotes, available-to-promise inventory, and order fulfillment statuses are served exclusively by the tenant-scoped API-001 commerce connector (`MOCK_ERP_DEMO_PACK=novamart`). Static knowledge documents never override API-001 runtime records.
2. **Unified Customer Context (`Customer360`):** Marketing, Sales, and Customer Care operate over a single tenant-scoped Customer360 timeline and evidence ledger while enforcing strict channel, consent, and identity boundaries.
3. **Human-in-the-Loop Controls:** High-consequence actions—including Marketing campaign dispatch (`AUTH-4`) and Customer Care human handoff (`awaiting_human` lease takeover)—require explicit authenticated operator action inside the NovaMart workspace.
