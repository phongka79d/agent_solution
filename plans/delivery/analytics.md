# Analytics and Business Outcomes

[Plan index](../README.md) · [Vietnamese easy-read flow](../plan-easy-read-flow.md)

Status: proposed design, not implemented functionality. Examples and targets are illustrative until agreed with a pilot customer.

<a id=section-20></a>

## Analytics

| Audience | Essential KPIs |
|---|---|
| Marketing | Leads, Qualified Leads, Cost per Lead (CPL), Cost per Qualified Lead |
| Sales | Opportunities, Meetings, Quotes, Conversion, Revenue |
| Support | AI Resolution Rate, Escalation Rate, Response Time, CSAT |
| Business | Revenue influenced by AI, Customer Acquisition Cost (CAC), LTV, Retention, Upsell Revenue |

Agree on event definitions, reporting periods, cohort rules, and denominators before launch.

- CPL = attributed campaign spend / captured leads; Cost per Qualified Lead uses qualified leads.
- Sales conversion uses a declared denominator, such as Won opportunities / closed opportunities.
- AI resolution counts confirmed resolutions without human resolution; monitor reopened cases separately.
- Revenue influenced by AI requires a recorded qualifying touch and a deduplicated order; it is attribution, not proof of incremental revenue.
- CAC includes the agreed acquisition costs. LTV is labeled estimated until sufficient realized customer history exists.

Unavailable data appears as unavailable, not zero. Pilot dashboards report only connected data; broader Marketing and retention reporting follows the roadmap.

## Measurement build packages

Build the measurement path alongside the MVP flow. These are acceptance gates, not implementation-time promises. Follow the [API and integration contract](../platform/api-and-integrations.md#apis-and-enterprise-integrations) and the [deployment bundle rules](../product-and-packaging.md#product-packaging-and-deployment).

| Package | Dependency | Evidence |
|---|---|---|
| Event envelope | Authenticated tenant and correlation IDs | Sample events carry `event_id`, `occurred_at`, source, actor, tenant, and config version |
| Ingest and dedupe | Web/LINE API, webhook verification, idempotency | Replayed event produces one fact and one audit outcome |
| Outcome mapping | One CRM, catalog, and calendar with field owners | Lead, qualification, opportunity, booking, handoff, and support states reconcile to source records |
| Metric layer | Approved numerator, denominator, cohort, and timezone | Recomputed sample report matches hand-checked records |
| Availability and ownership | Source permissions, freshness check, named metric owner | Dashboard labels available, partial, stale, or unavailable with a reason |
| Pilot QA | Fixed test set and rollback path | Every MVP journey emits expected events without cross-tenant rows |

### Event contract and ownership

Use immutable facts for what happened; derive rates from facts rather than from agent text. `event_id` is unique at the source, `correlation_id` links related work, and `occurred_at` is the business timestamp. `received_at` is transport time and must not replace it.

| Event | Source of record | Minimum fact | Event/metric owner |
|---|---|---|---|
| `lead.captured` | Existing web backend or LINE connector | Lead reference, channel, consent, source | CRM/Sales Ops |
| `message.received` / `message.sent` | Web/LINE API | Conversation, channel, timestamps, delivery result | Integration owner |
| `qualification.completed` | AgentOS qualification record | Required-field version, outcome, reviewer/agent | Sales Ops |
| `opportunity.updated` | Company CRM | Opportunity, stage, owner, value, stage timestamp | CRM owner |
| `booking.confirmed` | Company calendar | Booking ID, slot, timezone, confirmation timestamp | Calendar owner |
| `followup.sent` / `followup.stopped` | AgentOS workflow plus channel | Sequence, reason, consent, delivery result | Workflow owner |
| `handoff.created` / `handoff.resolved` | Human queue or CRM | Owner, reason, pause/resume, resolution | Support/Sales manager |
| `support.resolved` / `support.reopened` | Support queue or CRM | Resolution actor, confirmation, reopen flag | Support manager |
| `order.confirmed` | Company order/CRM system | Order ID, amount, customer, confirmation | Finance/RevOps |

### Metric dictionary

For each reporting window, use the business timezone and a half-open interval `[start, end)`. Count each canonical entity ID once, use the latest confirmed terminal state at cutoff, and publish `n`, exclusions, and source freshness beside every rate.

| Metric | Numerator / denominator | Source and availability | Owner |
|---|---|---|---|
| Captured leads | Distinct `lead.captured` / not applicable | Web/LINE or CRM; MVP when lead IDs exist | CRM/Sales Ops |
| Qualification completion | Completed required sets in window / eligible qualification starts in window; one per lead or conversation | AgentOS + conversation events; MVP | Sales Ops |
| Qualified-lead rate | Qualified leads in cohort / captured leads in cohort; one canonical lead each | AgentOS/CRM; unavailable if either count is missing | Sales Ops |
| Opportunity conversion | Won opportunities closed in window / closed opportunities in window; one final CRM outcome per opportunity | CRM stages; MVP only with stable Won/Lost mapping | Revenue Ops |
| Booking conversion | Confirmed bookings in window / eligible booking offers observed in window; define repeat-offer rule | Calendar + Sales offer events; state the offer rule | Sales Ops |
| AI resolution rate | Cases with final confirmed AI-only resolution in window / eligible support cases finally closed in window; one terminal outcome per case | Support queue/CRM; pending or reopened coverage reported separately | Support manager |
| Escalation rate | Eligible cases handed to a human by observation cutoff / eligible cases opened in the same declared cohort; count each case once | Handoff events + support queue; exclude test cases and report still-pending cases | Support manager |
| First-response time | Median elapsed seconds from inbound to first delivered reply over eligible observed conversations with both events in window; report `n` separately | Web/LINE timestamps; stale if delivery timestamps lag | Operations |
| Revenue influenced by AI | Sum confirmed order amounts for deduplicated orders with a qualifying AI touch in window; denominator is not applicable to the amount total | CRM/order + C360 touch; attribution only, later-phase | RevOps/Finance |
| CAC | Agreed acquisition spend / new customers in cohort | Ads/finance + CRM; later-phase and unavailable without spend | Finance |
| LTV | Realized or labeled-estimated customer value / customers in cohort | Billing/CRM; estimated until history is sufficient | Finance |

For AI resolution, pending/open cases and cases with an unresolved reopen at cutoff stay outside the denominator and appear as coverage. A reopened case enters the denominator only after final closure; assign at most one final outcome (AI-only only when no human resolution occurred) and report reopened count/rate separately.

For influenced revenue, deduplicate within each company by canonical `order_id`, include only confirmed orders whose qualifying AI touch precedes the order within the declared lookback, and never sum currencies. Report each source currency separately or use a recorded conversion rate; apply the agreed gross/net and adjustment policy. This is an attribution total, not incremental revenue or causal lift.

### Availability, ownership, and pilot decisions

- `Available` means the approved source is connected, required fields are present, freshness is within the agreed window, and the owner has accepted the mapping.
- `Partial` means some rows or fields are missing; show coverage and excluded counts beside the metric.
- `Stale` means the source is connected but past its freshness rule; show the last refresh and do not silently reuse it as current.
- `Unavailable` means no approved source, permission, required field, or accountable owner exists; render unavailable, never zero.
- The source owner keeps the system-of-record value correct; the metric owner approves meaning, denominator, observation window, and exceptions; the pipeline owner maintains delivery and dedupe.
- The dashboard owner publishes freshness, coverage, and definition versions; the business sponsor approves baseline and pilot targets.
- Before pilot, decide the identity key, duplicate rule, timezone, attribution lookback, CRM stage mapping, support-resolution confirmation, and booking-offer denominator.
- For later-stage Marketing/retention reporting only, optionally decide spend source for CAC, order source for influenced revenue, LTV cohort window, retention definition, retention period, and metric-change authority; none is an MVP prerequisite.

### Pilot prerequisites

- Name a source owner, metric owner, pipeline owner, dashboard owner, and business sponsor.
- Provide test access to the existing web backend, LINE connector, CRM, catalog, and calendar.
- Approve consent, identity matching, test-company isolation, data-retention, and redaction rules; this is privacy governance, not a retention KPI decision.
- Provide a baseline extract with record counts, timestamps, stages, and known gaps.
- Run the same event and metric checks for two isolated test-company configurations on one build.
- Sign the event dictionary, denominator rules, freshness thresholds, and unavailable-data display.
- Keep Marketing, custom ML, and causal-lift metrics out of the MVP acceptance set.

MVP reporting is limited to connected Sales and basic Support events from the existing web backend/LINE API, one CRM/catalog/calendar, one follow-up, and human handoff. Full Marketing, custom ML, and causal-lift claims remain roadmap work.
