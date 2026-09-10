# APIs, Integrations, Security, and Operations

[Plan index](../README.md) · [Vietnamese easy-read flow](../plan-easy-read-flow.md) · [Glossary](../glossary.md)

Status: proposed design, not implemented functionality. Examples and targets are illustrative until agreed with a pilot customer.

<a id=section-15></a>

## APIs and Enterprise Integrations

API-first means two directions of connection:

| Direction | Simple flow | Example |
|---|---|---|
| Company calls a module | Company application → AgentOS API → Enabled module → Result back to the application | Existing website sends a buyer's question to Sales and displays the answer |
| Module uses company data | Module / Workflow → Approved Skill → API Connector → Company application | Sales reads current prices and saves a qualified opportunity in the existing CRM |

Company systems can also send event notifications (webhooks), such as a submitted lead form or confirmed order. AgentOS normalizes these into workflow events; receiving an event is not proof that all triggered work has finished.

There are two supported ways to enter AgentOS:

1. **Company-backend call (recommended):** the company's server sends a request to the Module API. The browser or mobile app never holds the AgentOS credential.
2. **Verified channel connector:** a LINE/Facebook/WhatsApp/email connector receives the provider event, verifies it, adds the company's tenant identity, and forwards it. The connector is still an authenticated company-scoped caller; an unknown provider event is rejected.

Both paths end at the same request flow: authenticate caller → verify customer when private data is needed → check enabled module and current owner → run the module → return a task result. A **webhook** is only the delivery mechanism for an event; it is not proof that a business action succeeded.

### API flow in plain language

```text
1. The company's existing website/app receives a customer message.
2. The company's backend sends the message to AgentOS with its company credential.
3. AgentOS checks the company, the requested module, and the customer reference.
4. The Supervisor sends the request to Marketing, Sales, Support, or a human queue.
5. The selected module reads only the approved company data it needs.
6. AgentOS returns an immediate task ID; the work may continue after the request ends.
7. The company reads the task by polling or receives a server-to-server callback.
8. The company UI shows the answer and the real action status: waiting, human review, confirmed, stopped, or failed.
```

The **task ID** is a tracking number, not a success receipt. `202 Accepted` means “AgentOS has safely received the work.” It does not mean “the meeting is booked” or “the order is paid.” A **callback** is a message to the company's backend, separate from the message sent to the customer through LINE, email or the website. One owner must control each customer-channel send so a callback and a channel connector cannot send duplicate replies.

### Minimal proposed API

These are proposed contracts, not implemented endpoints. Document requests, responses, permissions, and errors in one OpenAPI specification before the pilot.

| Endpoint | Purpose | Result |
|---|---|---|
| `POST /v1/conversations` | Start or link a conversation using permitted company customer references | AgentOS conversation ID |
| `POST /v1/conversations/{id}/messages` | Submit a message with `module: marketing / sales / support / auto`; `auto` asks the Supervisor to route | `202 Accepted` and a task ID |
| `GET /v1/tasks/{id}` | Read task progress and available results | `accepted`, `running`, `waiting`, `awaiting_human`, `completed`, `stopped`, or `failed`; answer and confirmed action references when available |
| `POST /v1/events` | Receive a company business event with its source and unique event ID | Accepted event ID and correlation ID, plus task IDs for any queued work; otherwise an explicit error |

Example: the company's backend submits to `POST /v1/conversations/conv_01/messages`:

```json
{
  "module": "sales",
  "message": "We need a plan for 30 users. What is the price?"
}
```

The conversation already links to the permitted customer reference. AgentOS checks access, reads the connected catalog, and prepares a reply. The application polls the task result or receives a signed callback to its registered backend. `202 Accepted` means queued, not booked, sold, or resolved.

Callbacks carry `event_id`, `task_id`, `status`, `correlation_id`, and a result or error. Retry delivery within bounds; recipients deduplicate by event ID. `awaiting_human` is paused, not final. A `completed` task may contain only an answer; an action is successful only with a provider-confirmed result/reference.

Task status mapping is explicit: `accepted` means queued, `running` means a worker is active, `waiting` means a timer or external event is pending, `awaiting_human` means a named person must decide or take over, `completed` means the requested result was verified, `stopped` means a configured stop condition ended the work, and `failed` means the requested outcome was not established. A callback to the company backend is different from a customer-channel send: the callback reports task state; the connector that owns the customer channel sends the customer message once with an effect key and provider message ID.

The integration contract must distinguish customer verification from caller authentication, define field mappings and allowed reads/writes, carry a request/correlation ID, and return explicit errors for unsupported capabilities. Check each event's authenticated source and permitted event types before triggering workflows. Idempotency keys prevent repeat submissions from repeating actions; [Security, Reliability, and Operations](api-and-integrations.md#section-16) defines the shared security and recovery rules.

Human decisions use the same authenticated event ingress from an approved operator console or connected company system. Event types such as `human.approval`, `human.takeover`, `human.resume`, and `human.reject` include the run/task ID, actor ID, decision, reason and an idempotency key. The receiving owner is recorded before a paused task can resume; a customer message received while a human owns the conversation is queued for that owner rather than answered by AI.

### Connected applications

| Category | Purpose |
|---|---|
| CRM | Contacts, qualification, opportunities, ownership, sales outcomes |
| LINE | Customer messages and channel identity |
| WhatsApp | Customer messages and channel identity |
| Facebook | Messenger, lead forms, and source attribution |
| Email | Conversations and permitted follow-up |
| Calendar | Availability, booking, cancellation/rescheduling |
| Payment | Approved payment links and confirmed payment/refund status |
| E-commerce | Catalog/availability, orders, delivery, subscriptions where supported |
| Ticketing | Cases, assignment, status, resolution |
| Ads | Campaign/source metadata, spend, and permitted outcome feedback |
| Company-owned applications | Existing web/mobile backends, portals, custom CRM, product, or order APIs |

Each reusable API connector (adapter) handles provider-specific authentication, field mapping, API details, and event normalization. These details stay outside agent prompts. Prefer the company's application APIs over direct database access; never give an Agent unrestricted database credentials. If no suitable API exists, scope a controlled import or a company-owned API bridge before enabling that capability.

Start with one pilot company's backend, one CRM, one catalog source, and one calendar provider. Reuse supported connectors. Additional channels, including Instagram, SMS, mobile chat, and voice, are later adapters; internal alerts can use the operator console or connected messaging tools.

<a id=section-16></a>

## Security, Reliability, and Operations

| Area | Minimum design requirement |
|---|---|
| Tenant and data ownership | Tenant owns its data; enforce isolation in records, retrieval, files, queues, and analytics; configure retention/export/deletion |
| Access control | Role- and field-level permissions; least-privilege tools; assigned-deal/case access; admin MFA; enterprise SSO when required |
| API access | Company-scoped service credentials stay on the backend, never in browser/mobile code; derive tenant access from verified credentials, not a request field; check module, conversation, task, and customer access on every request |
| Data and credentials | Encrypt in transit/at rest; protect and rotate secrets; verify webhooks; redact sensitive logs |
| Event and callback security | Verify signatures and replay windows; deduplicate event IDs; restrict callback and connector destinations to registered, approved endpoints |
| Company data use | Send only necessary permitted data to model providers under agreed terms; no cross-company sharing or training reuse without explicit authorization |
| Agent guardrails | Treat messages, documents, and tool output as untrusted input; prevent instructions in content from granting permissions; validate outbound responses |
| Action authorization | Check identity, tenant, tool schema, policy, approval, and rate limits at execution time |
| Delivery reliability | Timeouts, bounded retries, idempotency keys, durable events, and dead-letter/manual exception queues |
| Partial failure | Reconcile uncertain outcomes before retrying; compensate only through an authorized action |
| Audit | Record actor, tenant/customer/conversation, action, policy/config version, approval, result, timestamp, and correlation ID |
| Observability | Track latency, tool/workflow failures, queue health, retrieval gaps, incidents, token usage, and cost per interaction |

Use roles such as Owner, Administrator, Marketing/Sales/Support Manager, assigned Sales/Support staff, and read-only Analyst.

Never tell a customer that a booking, quote, payment, or ticket succeeded until the relevant system confirms it. If a provider times out after possibly accepting a write, look up the result before retrying.

## Implementation contracts (full-product target)

These examples refine the four proposed endpoints above; they do not add a required public endpoint or provider. The connector envelope is a full-product target. MVP enables only the sources and actions named in [MVP](../delivery/mvp-and-roadmap.md#section-21).

### Caller, customer, and event identity

The caller is the company's authenticated backend or a verified company-scoped channel connector. The customer is the person or account the work concerns. They are separate identities and must not be inferred from one another.

| Identity | Minimum contract | What it permits |
|---|---|---|
| Caller | Company-scoped backend credential, tenant binding, scopes, and an actor/service ID | Calling the API for that tenant and enabled modules |
| Customer | Company customer reference plus verified channel/account assertion, matched within the tenant | Loading the permitted Customer360 context and customer records |
| Event source | Authenticated registered source, unique source event ID scoped to the company/source, event type, and timestamp | Ingesting only the allowed event types for that source |
| Human actor | Recorded user ID and role for an approval, takeover, or resume decision | The specific decision or ownership change allowed by policy |

The API must not trust a tenant or customer ID supplied only as a request field. If the backend cannot prove the customer match, return an explicit unverified-identity result and restrict context to safe public/session data. Keep the caller credential on the company backend; the browser and mobile client never receive it. Security controls remain in [Security, Reliability, and Operations](api-and-integrations.md#section-16).

### Identifiers and versions

Use the same names everywhere so a business owner can trace one question without confusing a source version with a task state.

| Field | Meaning | Where it appears |
|---|---|---|
| `tenant_id` / `company_ref` | The isolated company account | Caller, task, event, audit and analytics |
| `customer_id` + `source_record_id` | AgentOS link plus the company's original record ID | Customer360, connector request and handoff |
| `conversation_id` | One customer conversation in the selected channel | Messages, task, handoff and callback |
| `task_id` | One asynchronous AgentOS job | API response, polling and callback |
| `run_id` | One workflow instance created from a trigger | Workflow, audit and retry record |
| `event_id` | One immutable event from a company/provider source | Webhook, dedupe and analytics fact |
| `correlation_id` | Joins related requests, tasks, connector calls and outcomes | Logs, callbacks, audit and reports |
| `configuration_version` | Rules and enabled-module settings used for the run | Task/run/audit and deployment bundle |
| `source_version` | Version of the company catalog/document/data read | Answer evidence and connector result |
| `task_version` | Monotonic state update number for polling/callback ordering | Task and callback |
| `effect_key` | Stable key for one external side effect | Connector call and retry/reconciliation |

The company can use a different external ID format, but the mapping must be stored. `task_version` is not a configuration or source version; changing a configuration creates a new bundle/version for later runs and never rewrites an old audit record.

### Request and response examples (illustrative headers use the existing company-backend authentication contract)

```text
Authorization: Bearer <company-backend-token>
Idempotency-Key: msg_7f1
X-Correlation-ID: corr_9a2
```

Start or link a conversation (`POST /v1/conversations`). The company backend has validated the session/customer match and passes a registered assertion reference; AgentOS validates that assertion. Request:
```json
{"customer":{"source":"crm","reference":"crm_456","identity_assertion_ref":"sess_789"},"channel":"company_web","correlation_id":"corr_9a2"}
```
Response (201 Created):
```json
{"conversation_id":"conv_01","customer_id":"cust_123","identity_status":"verified"}
```
Submit work to a selected or automatically routed module (`POST /v1/conversations/{id}/messages`). Request:
```json
{"module":"sales","message":"We need a plan for 30 users. What is the price?"}
```
Response (202 Accepted):
```json
{"task_id":"task_01","conversation_id":"conv_01","status":"accepted","correlation_id":"corr_9a2"}
```
Read the authoritative task record (`GET /v1/tasks/{id}`). A result is not implied by `202`. Response:
```json
{"task_id":"task_01","version":3,"status":"completed","answer":"...","actions":[{"type":"catalog_read","source_ref":"catalog_v3"}],"correlation_id":"corr_9a2"}
```
Receive a business event from a registered company source (`POST /v1/events`). Request:
```json
{"event_id":"crm_evt_88","type":"lead.qualified","source":"crm","customer_ref":"crm_456","occurred_at":"2026-09-10T09:00:00Z"}
```
Response (202 Accepted):
```json
{"event_id":"crm_evt_88","correlation_id":"corr_evt_88","task_ids":["task_02"]}
```

### Minimum connector capability map

Each row is an allowlisted capability mapping, not a direct database grant. Read and write permissions are configured independently and use the authoritative system identified in [Customer360](data-and-knowledge.md#section-11).

| Existing system | Minimum read | Minimum write (only when enabled and authorized) |
|---|---|---|
| CRM | Customer, lead, opportunity, owner, stage | Qualification fields, notes, owner, opportunity outcome |
| Catalog / commerce | Product, current terms, eligibility, availability, order status | Approved quote/order/subscription request or outcome |
| Calendar | Free/busy and booking status | Create, cancel, or reschedule a booking with confirmed reference |
| Ticketing | Case, assignment, status, resolution history | Case, note, assignment, or status update |
| Channel / email | Thread, verified channel identity, delivery status | Send a permitted reply or follow-up |
| Payment | Payment-link and payment/refund status | Request an approved payment or refund action; never claim success before confirmation |
| Company-owned app | Explicit fields and operations agreed with the company | Only the mapped operations with a verified result |

An unmapped field or operation fails closed with `CAPABILITY_NOT_ENABLED`; an agent cannot turn a read into a write by changing its prompt. MVP normally uses CRM reads/writes, catalog reads, one calendar path, and permitted messaging; later product phases may enable other rows after their acceptance evidence passes.

Every connector call uses a small common envelope:

| Field | Purpose |
|---|---|
| `operation_id` | One traceable connector attempt |
| `effect_key` | Stable business action key used to prevent duplicate side effects |
| `operation` | Allowlisted read/write name, such as `crm.update_qualification` |
| `source_record` | Company system and record ID being read or changed |
| `status` | `confirmed`, `rejected`, or `uncertain` |
| `provider_reference` | Source-system ID or confirmation code when confirmed |
| `reconciliation_key` | Lookup key used after timeout before retry |
| `correlation_id` | Links the connector result to the task and conversation |

An HTTP response such as `200` or `202` from a provider is transport information, not automatically a confirmed business result. The connector translates the provider response into this envelope and the Workflow decides whether the task may advance.

### Task delivery, callbacks, and recovery

The task record is durable and authoritative. `accepted` means stored for work, `running` means execution is active, `awaiting_human` means paused for an identified owner or approval, `completed` means the requested answer or action was validated, and `failed` means the overall requested outcome was not established. A failed task still reports each action as `confirmed`, `rejected`, or `uncertain`; uncertain external effects require reconciliation before replay.

Callbacks are at-least-once notifications. Every transition carries a stable callback `event_id` scoped to the authenticated company/source, the `task_id`, a monotonic task version, status, correlation ID, and either a result or error. A recipient stores the scoped event ID (and task version), applies a transition once, and acknowledges a duplicate without repeating side effects. Callback ordering is checked by task version; an older callback cannot move a task backward.

```json
{"event_id":"cb_04","task_id":"task_02","version":1,
 "status":"awaiting_human","correlation_id":"corr_evt_88",
 "owner":"sales_manager","result":null}
```

If a callback is late or unavailable, the company polls `GET /v1/tasks/{id}` with bounded backoff. Polling returns the same durable status and version, so switching from callback to polling does not create a second run. A task left in `running` after a worker timeout is reconciled with the source system before any write is retried. `awaiting_human` remains pending until a recorded decision; it is never reported as completed merely because delivery succeeded.

### Explicit failures and acceptance checks

Failures use a stable code, human-readable message, `retryable`, correlation ID, and safe details. Typical codes are `AUTHENTICATION_FAILED`, `CUSTOMER_UNVERIFIED`, `CAPABILITY_NOT_ENABLED`, `VALIDATION_FAILED`, `APPROVAL_REQUIRED`, `PROVIDER_TIMEOUT`, `PROVIDER_REJECTED`, `RATE_LIMITED`, and `TASK_NOT_FOUND`. The caller can distinguish a retry, a customer clarification, and a human handoff without parsing prose.

Scope request idempotency to the authenticated company and operation/conversation. Reusing a key with a different payload is an explicit conflict, not a new action or an unrelated cached result.

Before pilot sign-off, test that:

- the same company-scoped message idempotency key returns the same task and causes one action;
- a duplicate event ID within the authenticated company/source returns the original correlation/task IDs and queues one workflow; the same string from another company/source is independent;
- a duplicate callback is acknowledged without a second write, and an older version is ignored;
- a missing callback is recovered by polling: terminal `failed` is visible and non-terminal `awaiting_human` remains pending;
- an unverified customer, disabled capability, malformed payload, and wrong-tenant reference fail explicitly;
- a provider timeout reconciles an uncertain write before retrying and never reports an unconfirmed success;
- an approval-required task stays `awaiting_human` with its accountable owner;
- a task result contains source references for material answers and confirmed references for completed actions.

For a duplicate event, keep one immutable event fact per authenticated company + source + event ID. If the same key arrives with a different payload hash or event type, return an explicit conflict and do not run a second workflow. One accepted fact may fan out to several configured workflows, each with its own run ID; a waiting run resumes from its saved step instead of creating a new run.
