---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Prohibited Marketing and Sales Claims

## MKT-04 Deterministic Brand Compliance Policy

Every Marketing campaign draft (`skill.mkt.audit_brand_compliance`) and customer-facing communication for NovaMart (`tenant_id: 99999999-9999-4999-8999-999999999999`) is audited against the explicit prohibited claims list below. Because NovaMart operates a strict synthetic no-discount policy (`P_floor = list_price`), zero-defect hardware guarantees, unauthorized third-party brand endorsements, and promotional discount claims are strictly forbidden. Any draft containing any of the bulleted phrases below fails compliance with `BLOCKING` severity.

## Explicit Prohibited Claim Phrases

- 100% guaranteed lifetime battery
- lowest price in Vietnam guaranteed
- zero-defect hardware warranty
- instant 50% discount code
- unconditional open-box full refund
- official Apple authorized distributor
- miễn phí trọn đời không điều kiện
- giảm giá 50% toàn bộ sản phẩm
- bảo hành vĩnh viễn trọn đời
- hoàn tiền 100% sau khi đã mở hộp sử dụng
