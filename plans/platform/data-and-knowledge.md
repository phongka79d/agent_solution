# Customer Data, Knowledge, and Product Catalog

[Plan index](../README.md) · [Vietnamese easy-read flow](../plan-easy-read-flow.md)

Status: proposed design, not implemented functionality. Examples and targets are illustrative until agreed with a pilot customer.

<a id=section-11></a>

## Customer360

Customer360 is **the modules' shared customer view**, not just chat memory and not a replacement CRM. Store the links and permitted context needed for the work; a company does not have to migrate its whole database into AgentOS.

| Record group | What it stores or links |
|---|---|
| Identity and contact | Customer/account IDs, verified channel identities, email, phone, company, consent, preferences |
| Acquisition | Lead source, campaign touches, product interest, lead score, qualification |
| Conversations | Messages, summaries, handoffs, active owner, next action |
| Commercial | Opportunities, quotes, orders, subscriptions, customer value |
| Service and growth | Tickets, resolution history, renewal status, churn/adoption indicators, upsell signals |

Illustrative assembled profile: source-record references and permitted snapshots, not a required copy of the company's records.

```yaml
customer:
  tenant_id: tenant_demo
  id: cust_123
  identity: {crm_id: crm_456, line_id: line_example, verified: true}
  contact: {name: An Nguyen, email: an@example.com}
  preferences: {channel: line, marketing_consent: true}
  lifecycle: {stage: active_customer, source: facebook, campaign: saas_q3}
  product_interest: [business_plan]
  lead_score: 82
  qualification: {users: 30, budget_monthly_usd: 900, timeline_weeks: 6}
  conversations:
    - {id: conv_01, summary: "30 users; CEO approves upgrades."}
  opportunity: {id: opp_01, stage: won}
  quotes: [quote_01]
  orders: [order_01]
  subscription: {id: sub_01, status: active}
  tickets: [ticket_01]
  customer_value: {revenue_to_date: 750, currency: USD}
  upsell_signals:
    - {type: additional_users, quantity: 50, source: ticket_01}
```

Link a trusted channel/account ID to the customer within the same tenant. Verify ambiguous email/phone matches before linking or merging; an order ID alone is not identity proof.

The company owns its data. Agree which system holds the authoritative value for each field:

| System | Authoritative records |
|---|---|
| Company app / CRM | Customer accounts, contacts, leads, opportunities, assigned owners |
| Catalog / Commerce / Billing | Product terms, prices, availability, orders, subscriptions, payments |
| Ticketing | Cases, assignments, case status |
| Channel / Ad providers | Delivery status, campaign details, spend |
| AgentOS | Customer links, AgentOS conversations/handoffs, workflow/configuration state, audit, approved derived scores |

Synchronize references and outcomes without silently overwriting source values. Retrieve current operational data through company APIs, or use an agreed cache with source IDs and freshness timestamps; recheck critical values before acting.

<a id=section-12></a>

## Knowledge and Agent Context

| Knowledge source | Use |
|---|---|
| Approved product and sales material | Product explanations, comparisons, onboarding |
| FAQ and troubleshooting guides | Routine support and resolution steps |
| Policies and service documentation | Approved customer explanations, delivery terms, SLA information |
| Internal playbooks | Staff-only guidance, restricted by role |

Retrieval flow: `Question → Tenant/permission filter → Search → Current approved sources → Grounded answer`.

Connect to approved company document sources where available; a controlled document upload/import is the fallback. This gives modules access to approved information, not permission to train a shared model on customer data.

Each knowledge item has an owner, version, approval status, effective/expiry dates, and visibility. Exclude outdated or unauthorized sources. Use live catalog data for prices and eligibility; descriptive documents cannot override executable business rules.

Build a bounded context bundle:

`Recent messages + Summary + Verified facts + Active workflow + Relevant business records + Retrieved sources`

Keep references to supporting sources. If identity, retrieval evidence, tool results, or policy certainty are insufficient, clarify or escalate. Do not treat a model's self-reported confidence as proof of correctness.

<a id=section-18></a>

## Product Catalog

Sales must retrieve products and current approved commercial terms from the Product Catalog. This is a common interface over the company's existing catalog API or an agreed synchronized source, not a requirement to maintain a second product system. If the company has no catalog service, a controlled product import is the initial fallback.

```yaml
product:
  id: business_plan
  name: Business
  category: saas
  price: {amount: 25, currency: USD, unit: user_per_month}
  description: Shared workspace for growing teams
  eligibility: {min_users: 10, max_users: 100}
  promotion: {id: null, discount_percent: 0}
```

Recommendation flow:

`Customer Need → Search Catalog → Filter → Recommend`

Filter by requirements, budget, eligibility, availability, and effective promotion rules. Explain the fit and trade-offs; do not invent an option when none qualifies.

Maintain product/version IDs, currency, billing units, applicable taxes/fees, availability, and effective dates in production data. Revalidate terms before issuing a quote and save a price/version snapshot. Exceptions go through [Human-in-the-loop](workflows-and-handoffs.md#section-14).

## Minimal linked-record contract

Preserve source-system ownership while making permitted facts usable across modules. Do not require copies of whole customer, commerce, or ticket databases.

| Element | Minimum information | Rule |
|---|---|---|
| Customer link | Company ID, internal customer ID, source system and source customer ID | All lookups and links stay inside the authenticated company |
| Identity evidence | Verified account/channel reference, method, verification time | A claimed email, phone or order number alone does not prove access |
| Conversation | Company/customer references, source channel, current owner, summary | Retain enough context for handoff under the agreed retention policy |
| Business reference | Source system, record type/ID, source version where available | Retrieve live facts or approved snapshots; do not claim ownership of source values |
| Snapshot/evidence | Value, source, retrieval time, permission scope | Recheck freshness and access before use; critical actions need current confirmed terms |
| Consent | Purpose, channel, status, source, recorded time | A lead score cannot substitute for permission to send messages |
| Derived signal | Score or interest, contributing evidence, rules/config version | Keep derived conclusions separate from source facts |

Illustrative product evidence stored with a recommendation:

```yaml
product_evidence:
  company_ref: company_demo
  source_system: approved_catalog
  source_record_id: business_plan
  source_version: catalog_v7
  retrieved_at: "2026-09-10T09:00:00+07:00"
  purpose: recommendation
  currency: USD
  unit: user_per_month
```

This is provenance, not a purchase, quote approval, or guarantee that a price remains valid later.

## Knowledge and source changes

| Change | Required platform behavior |
|---|---|
| New guide uploaded | Keep it unavailable to Agents until an accountable owner approves it |
| Document revised or expired | Retrieve the current approved version; exclude superseded/expired material |
| Source access revoked | Stop retrieval and invalidate affected cached access/search entries under the deletion/retention policy |
| Product price/availability changes | Refresh through the connector and revalidate before a commercial action |
| Conflicting customer fields | Apply the agreed field owner and record the conflict; do not silently merge or overwrite |
| Company deletion/export request | Apply the agreed policy across stored context, files, derived indexes and audit retention |

## Data-quality and access tests

1. Company A's message cannot retrieve Company B's profile, documents, product terms or task history.
2. An unverified customer gets public guidance, not another customer's order or account details.
3. A removed or unapproved document cannot ground a new answer even if it previously appeared in search.
4. A product recommendation carries source/version or retrieval evidence; stale or missing prices are not invented.
5. A duplicate identity match stays unresolved until verified; receiving another message does not auto-merge it.

Connection and error contracts are in [APIs and integrations](api-and-integrations.md); product-specific behavior is in [Sales](../modules/sales.md).
