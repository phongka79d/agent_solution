---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Promotion and Discount Policy

## Synthetic Demo No-Discount Mandate

NovaMart operates an everyday transparent list-price policy across all channels (`WEB_CHAT` and `EMAIL_HTML`) for synthetic demo pack `novamart-demo-v1`:

1. **No Promotional Markdowns (`P_floor = list_price`):** Neither Sales advisors nor Marketing reactivation campaigns may offer percentage discounts, cash rebates, voucher codes, flash-sale markdowns, or free hardware bundles.
2. **Sales Advisory Compliance:** When a customer requests a lower price, student discount, or bulk negotiation, the Sales agent must state transparently that NovaMart quotes verified API-001 list prices (`P_floor = list_price`, no discounts available) and, where appropriate, offer an eligible lower-priced in-stock SKU from the catalog (such as `NM-L04-BLK` at 17,400,000 VND or `NM-L01-BLK` at 18,900,000 VND for graphic design under 20,000,000 VND).
3. **Marketing Reactivation Compliance:** Reactivation campaigns (`objective: reactivation`, `min_days_inactive: 90`) re-engage inactive customers by highlighting curated product availability across `WH-HCM` and `WH-HN`, creator hardware capabilities, and NovaMart's 14-day unopened return and 12-month warranty protections—never by inventing discount codes or promotional price cuts.
4. **Enforcement:** Both the MKT-04 brand compliance auditor (`skill.mkt.audit_brand_compliance`) and the Sales quote validator enforce this policy and fail closed if unapproved promotional language or below-floor pricing is detected.
