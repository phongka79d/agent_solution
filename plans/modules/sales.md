# Sales Module

[Plan index](../README.md) · [Vietnamese easy-read flow](../plan-easy-read-flow.md)

Status: proposed design, not implemented functionality. Examples and targets are illustrative until agreed with a pilot customer.

<a id=section-7></a>

## Sales Agent

Purpose: move a qualified lead to a clear commercial outcome.

```text
Qualified Lead → Discovery → Need → Budget → Authority → Timeline
               → Product Recommendation → Demo / Quote → Follow-up
               → Won / Lost
```

Default opportunity state:

`New → Qualified → Demo → Proposal → Negotiation → Won/Lost`

Stages may be skipped only through configured transitions. Incomplete qualification returns to discovery or nurture; record unknown fields instead of inventing answers.

| Capability | Action or output |
|---|---|
| Qualification | Collect need, budget, authority, timeline, fit, and intent |
| Recommendation and pricing | Search the approved Product Catalog and explain suitable options |
| Meeting booking | Check availability, book a confirmed slot, and save the reference |
| Quotation | Create a quote from approved catalog data or prepare an approval request |
| CRM updates | Persist qualification, stage, owner, notes, and next action |
| Follow-up | Start or stop the appropriate workflow |
| Human handoff | Transfer high-value, complex, or exception deals with full context |

Example — a SaaS buyer:

1. Receive a qualified lead for a 30-user team.
2. Confirm the need, a USD 900 monthly budget, CEO approval, and a six-week timeline.
3. Retrieve the illustrative Business plan at USD 25 per user/month; 30 users cost USD 750/month before applicable taxes.
4. Book a demo and save the opportunity in CRM.
5. Prepare the approved quote, obtain any required human approval, and schedule follow-up.
6. Mark Won only after the configured authoritative confirmation; trigger onboarding.

Automated quotation and checkout are full-product capabilities. Their MVP boundaries are explicit in [MVP](../delivery/mvp-and-roadmap.md#section-21).

## Sales Module Operating Contract

Sales is independently selectable and may receive a new or unqualified direct company request, or an explicit handoff from Marketing. It owns the conversation while qualifying or progressing an opportunity; ownership is never shared concurrently with Support or a human queue.

### Inputs and company-owned data

| Input | Required data and source of truth |
|---|---|
| Customer context | Customer360 identity, verification state, contact, consent, conversation history, and prior owner |
| Company lead source | Form/CRM source, campaign fields, and company customer reference; missing attribution remains unknown |
| CRM | Contact/opportunity ID, stage, owner, notes, next action, and authoritative Won/Lost result |
| Qualification | Need, fit, budget, authority, timeline, product interest, and customer-confirmed unknowns |
| Product catalog | Product/version ID, approved price, currency, billing unit, availability, taxes/fees, and effective dates |
| Calendar | Provider availability, timezone, booking reference, and confirmed meeting status |
| Company policy | Stage transitions, discount limits, approval roles, quote terms, and permitted write fields |
| Optional Marketing handoff | Source, score, rule versions, consent evidence, and campaign history; Sales does not treat a score as a sale |

Read and write these records through approved company APIs and adapters described in [APIs and Integrations](../platform/api-and-integrations.md). The company application owns CRM, catalog, calendar, and commercial truth; do not use a prompt value or browser-supplied price as authority.

The Planned MVP does not require order, payment, checkout, refund, cancellation, or commerce connectors. Humans prepare and send quotations and confirm purchase; those later actions are optional full-product integrations.

### Actions and outputs

| Scope | Supported action | Output and boundary |
|---|---|---|
| Planned MVP | Ask and persist required qualification fields | Field values, unknowns, evidence, score, stage, owner, and next action |
| Planned MVP | Read the approved catalog and explain suitable options | Product/version references, assumptions, terms, and source timestamp |
| Planned MVP | Read availability and request a meeting | Confirmed booking reference, or an explicit unavailable/approval state |
| Planned MVP | Save permitted CRM updates | Provider-confirmed record reference; uncertain writes remain pending reconciliation |
| Planned MVP | Prepare inputs for a quote or approval packet | Draft context only; a human uses the company's configured quotation process |
| Full product, later | Generate/send a quote or use commerce adapters | Labeled proposed action, policy/approval gate, and provider confirmation required |
| Full product, later | Payment, cancellation, refund, or checkout execution | Human-approved, separately enabled connector; not MVP and never implied by an answer |

`Won`, payment, booking, and quote success are reported only when the corresponding company system returns a confirmed reference. A task marked `completed` can contain just an answer, not a commercial outcome.

### Main flow, decisions, and fallbacks

1. Verify caller access and customer identity before loading private account details; check communication/Marketing consent separately before outbound follow-up.
2. Load or create the permitted CRM contact/opportunity and required fields. Ask for missing information; record unknown instead of guessing.
3. Read current catalog data and revalidate version, price, availability, and terms before presenting an option.
4. Apply configured stage transitions. A request to skip a required stage returns to discovery or asks for approval.
5. For a demo, check the connected calendar and save the confirmed booking reference only after the provider responds.
6. Persist notes and next action with an idempotency key. Reconcile an uncertain write before retrying.
7. Transfer to a human for high-value, complex, policy-exception, or explicitly requested cases; pause AI until resumed.

| Exception | Safe fallback |
|---|---|
| Customer cannot be verified | Ask for the approved verification detail or hand off; expose no private account data |
| Catalog price or eligibility is missing/stale | State that it is unconfirmed, request a catalog refresh or human review, and do not quote it as final |
| Calendar unavailable or booking times out | Offer a human callback or approved alternatives; do not claim a booking |
| Discount exceeds policy | Create an approval request; do not promise the discount or alter catalog terms |
| Quote, payment, refund, or cancellation requested in MVP | Prepare context for a human and return `awaiting_human`; perform no commercial execution |
| Sales disabled | Preserve the lead in core records and return unsupported or a human queue item; do not silently route to a disabled action |
| Support disabled for a support-shaped request | Ask the Supervisor for an enabled destination or human handoff; Sales does not impersonate Support |

When Marketing is disabled, Sales still preserves source and campaign values supplied by the company's form or CRM; label attribution unavailable only when those fields are absent. Sales can accept a new or unqualified inquiry and use discovery to qualify it. When Sales transfers to Support, the prior owner is recorded and Support explicitly accepts ownership before Sales pauses.

### Configuration and acceptance scenarios

Configure enabled modules, required qualification fields, score rules, CRM/catalog/calendar mappings, stage transitions, owner queues, approval thresholds, quote templates, allowed write fields, language/tone, timeout/retry limits, and authoritative outcome events. Keep credentials in protected company-scoped connector storage; a delegated secret may be held by an AgentOS connector when required, with scope, rotation, and audit. Keep field ownership in the company systems.

Acceptance scenarios:

1. A qualified 30-user lead receives a current catalog recommendation, books an available slot, and creates one CRM update with confirmed references.
2. A lead lacks budget and authority; Sales records both as unknown, asks discovery questions, and does not invent values or advance the stage.
3. The CRM times out after a possible update; Sales reconciles by idempotency key and reports pending/confirmed rather than duplicating the opportunity.
4. A customer asks for a refund or an out-of-policy discount; Sales returns a human approval handoff and performs no refund, payment, or unauthorized price change.
5. Sales is disabled; an incoming `module: sales` request is explicitly rejected or queued for a human, with no silent cross-module action.
