---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Product Catalog Guidance

## Non-Authoritative Guidance Notice

This document provides qualitative product family descriptions, specification summaries, and use-case fit guidance for NovaMart's 24 synthetic products (28 SKUs). **This document carries zero live price or inventory authority.** Agents must never quote prices, floor boundaries, or stock counts from this file; all live commercial figures must be queried at runtime via API-001 (`skill.sales.search_product`, `skill.sales.check_stock`, and `skill.sales.check_price`).

## Product Families (`NM-*`)

### 1. Laptops (`category: laptops`)

- **`NM-L01` Nova Studio 14 Creator (`NM-L01-BLK`, `NM-L01-GRY`):** 14-inch creator laptop featuring Intel Core i7, 16GB RAM, NVIDIA GeForce RTX 4050 GPU, and 512GB NVMe SSD. Primary fit for `graphic design`, photo editing, and mobile creative workflows under 20 million VND.
- **`NM-L02` Nova Studio 16 Creator (`NM-L02-STD`):** 16-inch workstation with AMD Ryzen 7, 32GB RAM, RTX 4060 GPU, and 1TB SSD for heavy `graphic design` and 3D rendering at higher budgets.
- **`NM-L03` Nova Work 14 (`NM-L03-STD`):** 14-inch business laptop with Intel Core i5, 16GB RAM, integrated graphics, and 512GB SSD tailored for `office` productivity.
- **`NM-L04` Nova Flex 15 (`NM-L04-BLK`, `NM-L04-SIL`):** 15-inch versatile creator notebook with AMD Ryzen 5, 16GB RAM, RTX 3050 GPU, and 512GB SSD suitable for `design` and multimedia workloads.
- **`NM-L05` Nova Air 13 (`NM-L05-STD`):** Ultralight 13-inch notebook (Core i5, 8GB RAM, integrated graphics, 256GB SSD) engineered for frequent `travel`.
- **`NM-L06` Nova Studio 15 Creator (`NM-L06-STD`):** 15-inch creator laptop (Core i7, 32GB RAM, RTX 4060, 1TB SSD); subject to live API-001 stock verification (`check_stock` must reject out-of-stock items).
- **`NM-L07` Nova Pro 16 (`NM-L07-STD`):** Flagship 16-inch workstation (Core i9, 32GB RAM, RTX 4070, 1TB SSD) for high-end `design` above standard 20 million VND budgets.
- **`NM-L08` Nova Work 15 (`NM-L08-STD`):** 15-inch enterprise laptop (Ryzen 7, 16GB RAM, integrated graphics, 512GB SSD) for multi-window `office` operations.

### 2. Monitors (`category: monitors`)

- **`NM-M01` NovaView 24 FHD (`NM-M01-BLK`, `NM-M01-WHT`):** 24-inch IPS Full HD monitor for everyday desk setups.
- **`NM-M02` NovaView 27 QHD (`NM-M02-STD`):** 27-inch QHD IPS display for sharp office and coding workflows.
- **`NM-M03` NovaColor 27 4K (`NM-M03-STD`) & `NM-M06` NovaColor 32 (`NM-M06-STD`):** Color-calibrated 4K UHD panels designed for print and digital graphic designers.
- **`NM-M04` NovaWide 34 (`NM-M04-STD`) & `NM-M05` NovaView 22 (`NM-M05-STD`):** 34-inch ultrawide productivity display and compact 22-inch secondary office monitor.

### 3. Accessories & Storage (`category: accessories`, `category: storage`)

- **Accessories:** `NM-A01` NovaDock USB-C (`NM-A01-USBC`, `NM-A01-USBA`), `NM-A02` NovaMouse Pro (`NM-A02-STD`, featured in historical order `ORD-DEMO-005`), `NM-A03` NovaKeyboard (`NM-A03-STD`), `NM-A04` NovaPen (`NM-A04-STD`), `NM-A05` NovaBag 15 (`NM-A05-STD`), and `NM-A06` NovaCam (`NM-A06-STD`).
- **Storage:** `NM-S01` NovaSSD 512 (`NM-S01-STD`), `NM-S02` NovaSSD 1TB (`NM-S02-STD`), `NM-S03` NovaDrive 2TB (`NM-S03-STD`), and `NM-S04` NovaSD 256 (`NM-S04-STD`).
