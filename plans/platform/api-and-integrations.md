# APIs, Integrations, Security, and Operations

[Plan index](../README.md) · [Vietnamese easy-read flow](../plan-easy-read-flow.md)

Status: proposed design, not implemented functionality. Examples and targets are illustrative until agreed with a pilot customer.

<a id=section-15></a>

## APIs and Enterprise Integrations

API-first means two directions of connection:

| Direction | Simple flow | Example |
|---|---|---|
| Company calls a module | Company application → AgentOS API → Enabled module → Result back to the application | Existing website sends a buyer's question to Sales and displays the answer |
| Module uses company data | Module / Workflow → Approved Skill → API Connector → Company application | Sales reads current prices and saves a qualified opportunity in the existing CRM |

Company systems can also send event notifications (webhooks), such as a submitted lead form or confirmed order. AgentOS normalizes these into workflow events; receiving an event is not proof that all triggered work has finished.

### Minimal proposed API

These are proposed contracts, not implemented endpoints. Document requests, responses, permissions, and errors in one OpenAPI specification before the pilot.

| Endpoint | Purpose | Result |
|---|---|---|
| `POST /v1/conversations` | Start or link a conversation using permitted company customer references | AgentOS conversation ID |
| `POST /v1/conversations/{id}/messages` | Submit a message with `module: marketing / sales / support / auto`; `auto` asks the Supervisor to route | `202 Accepted` and a task ID |
| `GET /v1/tasks/{id}` | Read task progress and available results | `accepted`, `running`, `completed`, `awaiting_human`, or `failed`; answer and confirmed action references when available |
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

The integration contract must distinguish customer verification from caller authentication, define field mappings and allowed reads/writes, carry a request/correlation ID, and return explicit errors for unsupported capabilities. Check each event's authenticated source and permitted event types before triggering workflows. Idempotency keys prevent repeat submissions from repeating actions; [Security, Reliability, and Operations](api-and-integrations.md#section-16) defines the shared security and recovery rules.

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

The caller is the company's authenticated backend. The customer is the person or account the work concerns. They are separate identities and must not be inferred from one another.

| Identity | Minimum contract | What it permits |
|---|---|---|
| Caller | Company-scoped backend credential, tenant binding, scopes, and an actor/service ID | Calling the API for that tenant and enabled modules |
| Customer | Company customer reference plus verified channel/account assertion, matched within the tenant | Loading the permitted Customer360 context and customer records |
| Event source | Authenticated registered source, unique source event ID scoped to the company/source, event type, and timestamp | Ingesting only the allowed event types for that source |
| Human actor | Recorded user ID and role for an approval, takeover, or resume decision | The specific decision or ownership change allowed by policy |

The API must not trust a tenant or customer ID supplied only as a request field. If the backend cannot prove the customer match, return an explicit unverified-identity result and restrict context to safe public/session data. Keep the caller credential on the company backend; the browser and mobile client never receive it. Security controls remain in [Security, Reliability, and Operations](api-and-integrations.md#section-16).

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
