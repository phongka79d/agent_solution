# NovaMart demo knowledge — engineering notes

Internal implementation notes that used to sit inside the approved customer-facing corpus
(`packages/second-brain/demo/novamart/**`). They are **not** part of the approved knowledge base and
MUST NOT be re-introduced into `customer-care/`, `product/`, or `policy/` documents. The corpus lint
(`packages/second-brain/src/corpus-lint.test.ts`) fails if any of these identifiers reappear in those
namespaces.

## Skill identifiers

| Corpus area | Skill id | Purpose |
|---|---|---|
| Care | `skill.care.search_faq` | Match approved FAQ entries |
| Care | `skill.care.lookup_order` | Verified order status lookup |
| Care | `skill.care.escalate_to_human` | Create an auditable human handoff |
| Sales | `skill.sales.retrieve_customer` | Load Customer360 context |
| Sales | `skill.sales.search_product` | Catalog search via API-001 |
| Sales | `skill.sales.check_stock` | Live available-to-promise stock |
| Sales | `skill.sales.check_price` | Signed price + floor quote |
| Sales | `skill.sales.recommend_product` | Evidence-bound recommendation |
| Sales | `skill.sales.send_message` | One-to-one guarded reply |
| Sales | `skill.sales.create_cart` / `skill.sales.create_order` | Explicit-confirmation mutations |
| Marketing | `skill.mkt.segment_audience` | Build the `inactive90` segment |
| Marketing | `skill.mkt.generate_content` | LLM email drafting (`Core.LLMContentEngine`) |
| Marketing | `skill.mkt.audit_brand_compliance` | MKT-04 deterministic screening |
| Marketing | `skill.mkt.check_consent` | Re-verify EMAIL_HTML consent |
| Marketing | `skill.mkt.dispatch_campaign` | AUTH-4-gated dispatch |

## Authority tiers

- `AUTH-0` disabled / read-zero (default for new tenant shells)
- `AUTH-1` read-only context and discovery
- `AUTH-2` guarded advisory and internal drafting
- `AUTH-3` supervised one-to-one customer reply
- `AUTH-4` explicit human approval required
- `AUTH-5` restricted executive authority (never granted to autonomous agents)

Enforcement points: `RevenueOrchestrator`, `PolicyEnforcementPoint` (PEP), `DomainPolicyEngine`.

## Company permissions

`campaign:draft`, `campaign:create`, `conversation:takeover`, `conversation:reply`, `customer:read`,
`run:read`, `run:retry`, `run:reconcile`, `telemetry:read`, `approval:read`, `approval:decide`,
`platform:admin`.

## Agent and route codes

- Agents: MKT-01…MKT-05 (Marketing), CS-01/CS-02 (Care), ASM-003 (audience cap).
- Care takeover lease routes: R06 (claim), R07 (heartbeat), R08 (resume).
- Care lifecycle codes: `awaiting_human`, `CONVERSATION_LOCKED`,
  `CARE_ONBOARDING_ITINERARY_UNBOUND`.
- Sales-to-Care handoff binding: `handoff.sales_to_care` (intentionally unbound pending owner decision).

## Connectors and adapters

- `API-001` commerce connector: `/prices/lookup`, `/catalog/products`, `/orders/status`; demo pack
  `MOCK_ERP_DEMO_PACK=novamart`; mutation authority refused without approval.
- `API-003.CommunicationConnector`: channel dispatch.
- `SecondBrain.FAQEngine`, `SalesAgentRuntime`, `CareAgentRuntime`, `OpenAICompatibleLLMAdapter`.

## Provenance and policy fields

- Frontmatter provenance: `source_version: novamart-demo-v1`, `owner: novamart-demo-operator`,
  `tenant_id: 99999999-9999-4999-8999-999999999999`, `synthetic: true`,
  `approved_at: 2026-09-28T00:00:00Z`.
- Pricing internals: `P_floor = list_price`, `cost_of_goods` (0.70 × list price),
  `minimum_margin_rate` (0.10), `max_discount_vnd = 0`, `P_FLOOR_UNAVAILABLE`.
- Customer/business fields: `budget_vnd`, `available_qty`, `unit_price`, `DEMO_AS_OF`,
  `verified_at IS NOT NULL`, `customer_id`.
- Demo credentials/audience: `DEMO_COMPANY_ADMIN_EMAIL`/`DEMO_COMPANY_ADMIN_PASSWORD`,
  `DEMO_PLATFORM_ADMIN_EMAIL`/`DEMO_PLATFORM_ADMIN_PASSWORD`, `DEMO_MODE=true`, `EMAIL_HTML`
  consent (`email_marketing_consent`), `HYPOTHESIS` vs `FACT` classification.
