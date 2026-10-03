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

NovaMart Vietnam is a dedicated synthetic Vietnamese consumer and prosumer electronics retailer created exclusively for local and CI demonstrations. All policies, product lines, customer personas, and operational rules in this corpus are synthetic and never represent a live production merchant or substitute for real merchant owner sign-off.

## Core Retail Operations

- **Primary Market and Locale:** Vietnam domestic retail and online storefront (`locale: vi-VN`), operating in Vietnamese Dong (`currency: VND`).
- **Fulfillment Network:** Two regional distribution hubs located in Ho Chi Minh City (roughly 70% of baseline allocation) and Hanoi (roughly 30% of baseline allocation).
- **Merchandise Lines:** Creator and office laptops (`NM-L01` through `NM-L08`), FHD/QHD/4K and ultrawide monitors (`NM-M01` through `NM-M06`), productivity accessories (`NM-A01` through `NM-A06`), and high-speed NVMe/portable storage (`NM-S01` through `NM-S04`).
- **Customer Channels:** Supervised storefront web chat for Sales advisory and Customer Care support, and operator-initiated HTML email for consented Marketing reactivation drafts.

## System of Record and Governance Principles

1. **Commercial Authority:** Real-time unit pricing, owner-approved floor prices, signed price quotes, available-to-promise inventory, and order fulfillment statuses are served exclusively by the tenant-scoped commerce connector. Static knowledge documents never override live connector records.
2. **Unified Customer Context:** Marketing, Sales, and Customer Care operate over a single tenant-scoped customer timeline and evidence ledger while enforcing strict channel, consent, and identity boundaries.
3. **Human-in-the-Loop Controls:** High-consequence actions—including Marketing campaign dispatch and Customer Care human handoff—require explicit authenticated operator action inside the NovaMart workspace.
