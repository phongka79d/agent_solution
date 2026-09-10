# Marketing Module

[Plan index](../README.md) · [Vietnamese easy-read flow](../plan-easy-read-flow.md)

Status: proposed design, not implemented functionality. Examples and targets are illustrative until agreed with a pilot customer.

<a id=section-6></a>

## Marketing Agent

Purpose: turn campaign engagement into qualified demand with a traceable source.

```text
Campaign → Traffic → Lead Capture → Customer360 → Lead Scoring
         → Nurture → Qualified Lead → Sales Handoff
```

Already-ready leads can skip nurture.

| Capability | Concrete action |
|---|---|
| Campaign content | Draft approved ad, landing-page, email, and social content |
| Capture and attribution | Save contact, campaign/source identifiers, product interest, and consent |
| Segmentation and scoring | Group leads by fit, interest, behavior, and readiness |
| Nurture and reactivation | Deliver useful content, track engagement, and revisit eligible inactive leads |
| Sales handoff | Pass qualification evidence, campaign history, and recommended next action |

Start with configurable rules, not ML. Example scoring inputs include form submission, pricing engagement, budget, timeline, and demo requests. Cap and deduplicate behavioral contributions; missing qualification fields still need confirmation.

Example: Facebook Ad → landing page → product question → lead captured → pricing viewed three times → combined configured score = 82 → qualification requirements satisfied → Sales handoff.

The score includes prior fit and engagement signals; three page views alone do not imply a score of 82. Contact eligibility is governed separately by the outreach rules in [Workflow Engine](../platform/workflows-and-handoffs.md#section-13).

## Marketing Module Operating Contract

Marketing is independently selectable. Its flow starts after the company has run an ad or campaign and a customer clicks through or submits an inquiry. AgentOS receives the company's event; it does not replace Meta, Google, Facebook, or another ad platform.

In the Sales-first MVP, Marketing is not enabled as an active module. Core may retain a company-supplied inquiry and source event for traceability, but no campaign management or campaign automation, nurture send, ad operation, or ML action runs. The labels below make later Marketing behavior explicit.

### Inputs and company-owned data

| Input | Required data and source of truth |
|---|---|
| Inquiry event | Authenticated event ID, permitted source, submitted fields, timestamp, channel, and company customer reference when available |
| Campaign attribution | Campaign, ad, landing-page, UTM, and form identifiers supplied by the company; unknown values remain unattributed |
| Customer context | Customer360 identity, contact details, consent status, and existing conversation from the company's permitted APIs |
| Fit data | Product interest, company size, budget, timeline, authority, and answers already confirmed by the customer |
| Engagement data | Company-provided events such as pricing views or demo requests, with event time and deduplication key |
| Product and policy data | Approved catalog, claims, language, outreach, and escalation rules; company systems remain authoritative |

Use the API contracts and connector boundaries in [APIs and Integrations](../platform/api-and-integrations.md) and the records defined in [Customer Data and Knowledge](../platform/data-and-knowledge.md). Do not read a company's database directly or infer a customer identity from an untrusted form field. Marketing consent controls outbound nurture and reactivation; it is separate from event authentication/access and is not required to answer a valid inbound public question or inquiry.

### Actions and outputs

| Scope | Supported action | Output and boundary |
|---|---|---|
| Core / MVP boundary | Normalize a submitted inquiry and save attribution | Lead reference, source evidence, consent state, and correlation ID; no active Marketing workflow |
| Full product, later | Apply configured rules-based fit and engagement scoring | Score, rule versions, missing fields, and recommended next step; no ML claim |
| Full product, later | Prepare a Sales handoff when Sales is enabled and criteria pass | Qualification evidence, campaign history, owner transfer request, and task status |
| Full product, later | Draft ad, landing-page, or email copy | Human-reviewable draft only; never publish, bid, target, or spend |
| Full product, later | Nurture, reactivation, or audience recommendations | Consent-checked proposal or queued workflow; a human approves activation and spend |
| Full product, roadmap | Predictive lead or budget recommendations | Clearly labeled prediction/recommendation; validated data and human decision required |

Every result names the active conversation owner, source records, configuration version, and next action. Marketing may suggest a Sales handoff, but it cannot claim revenue, a booking, or a sale without a confirmed company-system result.

### Main flow, decisions, and fallbacks

When Marketing is enabled in a later phase:

1. Authenticate the event source and permissions before accepting it; reject an unknown or unauthenticated source (audit rejection metadata only), then deduplicate valid event IDs.
2. Match the permitted customer reference; on ambiguity, keep the lead unmerged and request human review.
3. Save campaign/source fields and consent. Missing Marketing consent blocks outreach, not an allowed inbound response, and does not erase a valid inquiry.
4. Load approved fit, catalog, and engagement data. Missing fields stay unknown and can trigger a clarification task.
5. Compute the configured score with caps and explain the contributing rules.
6. If criteria pass and Sales is enabled, request an explicit owner transfer with the evidence attached.
7. If Sales is disabled, create a human queue item and return `awaiting_human`; do not start a Sales workflow or promise follow-up.

| Exception | Safe fallback |
|---|---|
| API timeout or uncertain write | Reconcile the source record before retrying; return the last confirmed state |
| Duplicate inquiry or webhook | Return the existing lead/task reference without adding a second lead |
| Opt-out or revoked consent | Stop scheduled outreach and record the suppression event |
| Unknown or unauthenticated event source | Reject the event; do not store it as an accepted lead, while retaining minimal audit metadata |
| Valid event with missing campaign attribution | Preserve the inquiry and mark attribution unknown; do not invent a source |
| Marketing disabled | Core keeps the event; an explicit Marketing request returns unsupported or goes to a human, with no score, draft, or send |

Only one module owns a conversation at a time. When ownership transfers to Sales or a human, Marketing pauses pending outreach and resumes only through an explicit workflow decision. See [Workflows and Human Handoffs](../platform/workflows-and-handoffs.md) for pause, transfer, and resume rules.

### Configuration and acceptance scenarios

Configure enabled-module flags, campaign and event mappings, scoring rules and caps, qualification thresholds, consent and suppression rules, draft approval roles, handoff fields, queue routing, language/tone, and retention/audit settings. Keep credentials in protected company-scoped connector storage; a delegated secret may be held by an AgentOS connector when required, with scope, rotation, and audit.

Acceptance scenarios:

1. A company ad sends a customer to a form; the submitted inquiry creates one attributed lead with consent and a traceable task, without any AgentOS ad-platform action.
2. An unknown event source is rejected without an accepted lead; a separately authenticated webhook delivered twice still produces one lead and one handoff result.
3. A valid inbound inquiry arrives without Marketing consent; it can receive an allowed response, no outbound outreach is scheduled, and the suppression reason is visible.
4. Sales is disabled; Marketing preserves the inquiry and returns a human-owned queue item rather than calling a Sales action.
5. A copy draft is requested; the output is labeled `draft`, requires approval, and cannot publish or change campaign spend.
