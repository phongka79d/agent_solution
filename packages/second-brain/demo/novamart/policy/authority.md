---
status: approved
owner: novamart-demo-operator
source_version: novamart-demo-v1
approved_at: 2026-09-28T00:00:00Z
tenant_id: 99999999-9999-4999-8999-999999999999
synthetic: true
---

# NovaMart Platform Authority Policy (`AUTH-0`..`AUTH-5`)

## Controlled Autonomy Levels

All agent skill executions in NovaMart (`tenant_id: 99999999-9999-4999-8999-999999999999`) are brokered exclusively through `RevenueOrchestrator`, `PolicyEnforcementPoint` (PEP), and `DomainPolicyEngine` under six graduated authority tiers:

- **`AUTH-0` (Disabled / Read-Zero):** Default state for newly provisioned tenant shells; no autonomous skill execution permitted.
- **`AUTH-1` (Read-Only Context & Discovery):** Permits non-mutating tenant-scoped reads (`skill.sales.retrieve_customer`, `skill.sales.search_product`, `skill.sales.check_stock`, `skill.sales.check_price`, `skill.care.search_faq`, `skill.care.lookup_order` for verified customer, `skill.mkt.segment_audience`, `skill.mkt.audit_brand_compliance`, `skill.mkt.check_consent`).
- **`AUTH-2` (Guarded Advisory & Internal Drafting):** Permits evidence-bound product recommendations (`skill.sales.recommend_product`), LLM content generation (`skill.mkt.generate_content`), and Customer Care human escalation handoffs (`skill.care.escalate_to_human`).
- **`AUTH-3` (Supervised One-to-One Customer Reply):** Permits policy-checked, single-recipient customer replies (`skill.sales.send_message`) when backed by verified API-001 price/stock quotes, customer consent, and absence of human takeover locks.
- **`AUTH-4` (Explicit Human Approval Required):** Mandatory gate for multi-recipient or commercial-commitment effects, including Marketing campaign dispatch (`skill.mkt.dispatch_campaign`) and cart/order mutations. Execution pauses in `awaiting_approval` until an authorized human operator (`approval:decide`) approves the immutable payload digest.
- **`AUTH-5` (Restricted Executive Authority):** Reserved for owner-level governance; never granted to autonomous agents in `novamart-demo-v1`.

## Trust Boundary Invariants

Model outputs (`OpenAICompatibleLLMAdapter`) supply bounded typed hypotheses and grounded text formatting only and **never** assign `tenant_id`, `customer_id`, `skill_id`, `required_authority`, `effect_key`, unit prices, floor prices, or approval status.
