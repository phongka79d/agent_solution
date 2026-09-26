# API, Connectors, and Adapters Specification

Status: Runtime-backed P1B handoff slice plus target contracts for remaining API/connectors
System Component: API Gateway, Core Connectors (API-001..003), and Adapters (ADPT-TW-001, ADPT-GL-001..003)
Document Version: 1.0.0
Target Directory: `implement/06-api-and-connectors-spec.md`

> **Runtime delta — P1B Care handoffs.** R05 approval decisions and R18 reconciliation are implemented at
> the gateway as tenant-scoped durable queue boundaries. The API returns `202 QUEUED`; the worker owns
> lease-fenced policy recheck, approval claim, and provider-proof reconciliation resume. Authoritative provider
> proof is bound for API-001 / mock GET: confirmed success durably settles the reservation and replays the proven
> receipt without a second dispatch; confirmed absence settles FAILED, reopens the SAME effect key, and permits
> exactly one re-dispatch. Operator labels or receipts are not proof. Live external ERP connections, optional
> adapters, telemetry surfaces, and live database pilot verification remain target contracts or explicit fail-closed
> capabilities. Numeric latency, throughput and cost figures remain provisional pending ASM-002 and the NFR-009 benchmark.

---

## 1. OpenAPI 3.1 Specification for Core REST APIs

The platform exposes the foundational REST routes below under strict tenant isolation, with asynchronous durable execution. R05 and R18 are queue-first runtime paths; target-only routes retain their blueprint status until their owning implementation is bound.

**Idempotency contract (NFR-003, BR-005, BR-006) — applies to every mutating endpoint that carries an idempotency key (`idempotency_key`) or execution key (`effect_key`):**

1. **First delivery** — the effect is executed once; its receipt (`task_id` / `provider_reference` / execution record) is cached under `(tenant_id, effect_key)`.
2. **Identical replay** — a repeated request whose canonical payload is byte-identical returns the **cached receipt** with the original identifiers and status. The external effect is **not** executed a second time and the response is not an error.
3. **Payload mismatch** — the same key presented with a *different* canonical payload returns **HTTP 409 `IDEMPOTENCY_CONFLICT`**. A 409 is never returned for an identical replay.
4. Concurrent in-flight duplicates wait on the same key lock and then receive the cached receipt.

**Path convention.** The Core Engine Gateway serves every route under the base path **`/api/v1`**. Relative paths used throughout this specification (`/conversations`, `/approvals/{id}/decision`, …) are therefore absolute as `/api/v1/conversations`, `/api/v1/approvals/{id}/decision`. The Command Center UI and the Storefront Widget call exactly these absolute paths — there is no unprefixed or `/v1`-only variant.

**SCR-003 approval routing.** The single authoritative approval endpoint is `POST /api/v1/approvals/{id}/decision`. It accepts the five baseline SCR-003 actions — `APPROVE`, `REJECT`, `MODIFY`, `PAUSE`, `CANCEL` — and is the route the Command Center UI calls (see `07-human-command-center-ui.md` §4.3). There is no separate `/execute` route.

**SCR-005 conversation control routing.** The authoritative routes are `POST /api/v1/conversations/{id}/takeover` (operator takes over, per SCR-005), `POST /api/v1/conversations/{id}/takeover/heartbeat` (renews the operator lease while the takeover is active), and `POST /api/v1/conversations/{id}/resume` (operator returns the conversation to the agent, per SCR-005 "trả lại Agent"; the only explicit release path for the lease — lease expiry also returns control to the agent). Session identity is the `conversation_id`; there is no parallel `/sessions/{id}` resource and no separate DELETE/release route.

### 1.1. Gateway route registry (target and optional surfaces)

Beyond the eight REST routes specified in the OpenAPI document below, the Command Center UI and the Storefront Widget use the following target routes. They are part of the same `/api/v1` gateway surface and inherit its tenant isolation, authentication, and idempotency rules.

| Route | Transport | Purpose | Caller / authority |
|---|---|---|---|
| `GET /api/v1/telemetry/stream` | Server-Sent Events (HTTP/2) | Executive and operational telemetry stream consumed by SCR-001 and SCR-002 (`?metric=` selects the series, e.g. `revenue_attribution`) | Authenticated operator session, read-only (AUTH-0 equivalent) |
| `WS /api/v1/ws/stream` | WebSocket | Bidirectional operator channel: live conversation monitoring, Copilot draft delivery, lease/lock notifications for SCR-005 | Authenticated operator session |
| `POST /api/v1/storefront/stream` | HTTP with streamed (chunked) response | One Storefront Widget chat turn: binds the widget session to a conversation and streams the reply. Body is `PostMessageRequest` plus an optional `session_id` for first-turn binding; server-side it delegates to `POST /api/v1/conversations` + `POST /api/v1/conversations/{id}/messages`, inheriting their consent, channel, and idempotency rules. An identical replay of the same `idempotency_key` returns the cached receipt, not a second turn | First-party widget; AUTH-0..AUTH-3 per policy |
| `POST /api/v1/storefront/events` | HTTP | First-party storefront event ingestion (API-002, §3). Same envelope and same deduplication rule as `POST /api/v1/events` (`event_id` identical replay → cached receipt; same `event_id` with a different payload → `409 IDEMPOTENCY_CONFLICT`). The gateway derives `canonical_event` from the granular `event_type` (§3.0) | First-party widget / app |
| `POST /api/v1/operations/runs/{run_id}/retry` | HTTP | Operator-initiated re-dispatch of a **failed** run from SCR-002. Permitted only when the failure is verified side-effect-free (schema/validation failure, authority `DENY`, `FAIL_CLOSED`, or a provider rejection received before dispatch). The retry reuses the run's original `effect_key`, so BR-005/BR-006 still hold and no second external effect can be produced. A run whose external effect outcome is **unknown** (timeout after dispatch, provider ambiguity, missing acknowledgement) is refused with `409` and routed to reconciliation — an unknown outcome is never resolved with a blind retry | Authenticated operator session + tenant RBAC |

```yaml
openapi: 3.1.0
info:
  title: AI Agent Commerce Platform Core REST API
  version: 1.0.0
  description: Foundation APIs for conversation orchestration, durable task inspection, and event ingestion.
servers:
  # Base path /api/v1 is mandatory: the paths below are relative to it (§1 path convention).
  - url: https://api.platform.internal/api/v1
    description: Production Core Engine Gateway (base path /api/v1)
paths:
  /conversations:
    post:
      summary: Initialize or bind a conversation session
      operationId: createConversation
      security:
        - BearerAuth: []
        - TenantHeader: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/CreateConversationRequest'
      responses:
        '201':
          description: Conversation session created or bound
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ConversationSessionResponse'
        '400':
          $ref: '#/components/responses/400BadRequest'
        '401':
          $ref: '#/components/responses/401Unauthorized'
        '403':
          $ref: '#/components/responses/403Forbidden'

  /conversations/{id}/messages:
    post:
      summary: Send an inbound user message or consultation query
      operationId: postConversationMessage
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
          description: Unique conversation identifier
      security:
        - BearerAuth: []
        - TenantHeader: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/PostMessageRequest'
      responses:
        '202':
          description: >-
            Message accepted for asynchronous durable execution. On an identical replay of the same
            idempotency_key with a byte-identical payload, the cached receipt (original task_id) is
            returned and no new task is created. A 409 is reserved exclusively for the same key with a
            different payload.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/TaskAcceptedResponse'
        '400':
          $ref: '#/components/responses/400BadRequest'
        '409':
          $ref: '#/components/responses/409Conflict'
        '422':
          $ref: '#/components/responses/422Unprocessable'

  /tasks/{id}:
    get:
      summary: Query task lifecycle status and outcome
      operationId: getTaskStatus
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
          description: Durable task identifier (task_id)
      security:
        - BearerAuth: []
        - TenantHeader: []
      responses:
        '200':
          description: Current task execution state and output
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/TaskStateResponse'
        '404':
          $ref: '#/components/responses/404NotFound'

  /events:
    post:
      summary: Ingest external webhooks and operator decisions
      operationId: ingestPlatformEvent
      description: >-
        Idempotent on event_id. An identical replay of the same event_id returns the cached
        EventIngestionResponse; the same event_id with a different payload returns 409
        IDEMPOTENCY_CONFLICT.
      security:
        - WebhookHmacAuth: []
        - TenantHeader: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/PlatformEventEnvelope'
      responses:
        '202':
          description: Event accepted for processing, or cached receipt returned for an identical replay
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/EventIngestionResponse'
        '400':
          $ref: '#/components/responses/400BadRequest'
        '401':
          $ref: '#/components/responses/401Unauthorized'
        '409':
          $ref: '#/components/responses/409Conflict'

  /approvals/{id}/decision:
    post:
      summary: Submit human operator decision for a pending AUTH-4 approval (SCR-003 — Approve, Reject, Modify, Pause, Cancel)
      description: >-
        The single approval route used by the SCR-003 Approval Center. The gateway authenticates the operator,
        validates the reviewed digest and decision shape, and queues one durable resume event. It does not
        execute a provider call or mark the approval decided. The worker later claims the event under its lease
        fence, rechecks current policy/takeover/floor guards, and applies the decision transactionally. An
        identical canonical replay is accepted without a second write; a different event for the same task
        conflicts. The response is 202 QUEUED with the task and queue timestamp; PAUSE/CANCEL semantics are
        applied only by the guarded worker claim.
      operationId: submitApprovalDecision
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
          description: Pending approval identifier (approval_id)
      security:
        - BearerAuth: []
        - TenantHeader: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ApprovalDecisionRequest'
      responses:
        '202':
          description: >-
            Decision event accepted into the tenant-scoped durable queue. The response is QUEUED; the worker
            later performs the lease-fenced policy checks and approval/task transaction. No provider call or
            approval decision is committed by this HTTP request.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ApprovalDecisionResponse'
        '400':
          $ref: '#/components/responses/400BadRequest'
        '401':
          $ref: '#/components/responses/401Unauthorized'
        '403':
          $ref: '#/components/responses/403Forbidden'
        '404':
          $ref: '#/components/responses/404NotFound'
        '409':
          $ref: '#/components/responses/409Conflict'

  /conversations/{id}/takeover:
    post:
      summary: Human operator initiates takeover of an active conversation (SCR-005)
      description: >-
        Acquires the exclusive operator lease for the conversation. While held, outbound AI messages for the
        conversation are hard-locked and routed to the human operator; the agent may still produce internal
        AUTH-2 copilot drafts that are never sent to the customer. The lease is renewable via
        /conversations/{id}/takeover/heartbeat and ends on /conversations/{id}/resume or lease expiry.
        A second operator attempting takeover while the lease is held receives 409.
      operationId: takeoverConversation
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
          description: Conversation session identifier
      security:
        - BearerAuth: []
        - TenantHeader: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ConversationTakeoverRequest'
      responses:
        '200':
          description: Conversation successfully locked to human takeover mode
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ConversationTakeoverResponse'
        '400':
          $ref: '#/components/responses/400BadRequest'
        '401':
          $ref: '#/components/responses/401Unauthorized'
        '403':
          $ref: '#/components/responses/403Forbidden'
        '404':
          $ref: '#/components/responses/404NotFound'
        '409':
          $ref: '#/components/responses/409Conflict'

  /conversations/{id}/takeover/heartbeat:
    post:
      summary: Renew the operator takeover lease on a conversation (SCR-005)
      description: >-
        The take-over mutex is held under a short, renewable lease. While an operator is actively handling the
        conversation, the Command Center renews the lease on this route (the UI heartbeat runs every 30 s
        against a 60 s lease). The heartbeat is only valid for the operator who currently holds the lease;
        lease expiry or an explicit resume returns control to the agent. The lease is never unbounded, so a
        crashed operator tab cannot lock a customer conversation forever.
      operationId: heartbeatConversationTakeover
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
          description: Conversation session identifier
      security:
        - BearerAuth: []
        - TenantHeader: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ConversationTakeoverHeartbeatRequest'
      responses:
        '200':
          description: Lease renewed; conversation remains locked to the human operator
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ConversationTakeoverHeartbeatResponse'
        '401':
          $ref: '#/components/responses/401Unauthorized'
        '403':
          $ref: '#/components/responses/403Forbidden'
        '404':
          $ref: '#/components/responses/404NotFound'
        '409':
          $ref: '#/components/responses/409Conflict'

  /conversations/{id}/resume:
    post:
      summary: Return the conversation to the agent after human intervention (SCR-005 "return to agent")
      description: >-
        Releases the operator takeover lease and returns the conversation to autonomous agent control. Before
        autonomous replies resume, the platform re-validates consent, customer context, and any pending
        order/action state so that the hand-back is audited and safe. Only the operator holding the lease (or an
        authorized supervisor) may resume.
      operationId: resumeConversation
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
          description: Conversation session identifier
      security:
        - BearerAuth: []
        - TenantHeader: []
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/ConversationResumeRequest'
      responses:
        '200':
          description: Conversation returned to active agent processing
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ConversationResumeResponse'
        '400':
          $ref: '#/components/responses/400BadRequest'
        '401':
          $ref: '#/components/responses/401Unauthorized'
        '403':
          $ref: '#/components/responses/403Forbidden'
        '404':
          $ref: '#/components/responses/404NotFound'
        '409':
          $ref: '#/components/responses/409Conflict'

components:
  securitySchemes:
    BearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
    TenantHeader:
      type: apiKey
      name: X-Tenant-ID
      in: header
    WebhookHmacAuth:
      type: apiKey
      name: X-Signature-SHA256
      in: header

  responses:
    400BadRequest:
      description: Invalid request payload or parameter
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
    401Unauthorized:
      description: Authentication failed or token expired
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
    403Forbidden:
      description: Insufficient tenant or agent authority
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
    404NotFound:
      description: Requested entity not found
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
    409Conflict:
      description: >-
        Idempotency conflict (same key/event_id presented with a different payload), concurrent mutation, or a
        conversation control action (takeover/resume) that conflicts with the current lease holder. An identical
        replay is NOT a conflict: it returns the cached receipt with 2xx.
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'
    422Unprocessable:
      description: Business validation or policy rule failure
      content:
        application/json:
          schema:
            $ref: '#/components/schemas/ErrorResponse'

  schemas:
    CreateConversationRequest:
      type: object
      required: [channel, customer_identifier]
      properties:
        channel:
          type: string
          description: >-
            Communication channel. The SRS API-003 baseline set is WEB_CHAT (Web/App Chat), MESSENGER
            (Facebook), TIKTOK, ZALO, EMAIL and SMS. APP_CHAT, LINE, WHATSAPP and INSTAGRAM are supported as
            extension channels beyond the baseline minimum and remain subject to ASM-001.
          enum: [WEB_CHAT, APP_CHAT, MESSENGER, INSTAGRAM, TIKTOK, ZALO, EMAIL, SMS, LINE, WHATSAPP]
        customer_identifier:
          type: string
        metadata:
          type: object
          additionalProperties: true

    ConversationSessionResponse:
      type: object
      required: [conversation_id, session_token, status, created_at]
      properties:
        conversation_id:
          type: string
        session_token:
          type: string
        status:
          type: string
          description: >-
            ACTIVE = autonomous agent control (rendered as AI_CONTROLLED in SCR-005); HUMAN_TAKEOVER = an
            operator holds the takeover lease and AI outbound replies are suppressed; CLOSED = conversation
            ended. This is the authoritative status enum; the UI state names AI_CONTROLLED / HUMAN_TAKEOVER
            map onto it.
          enum: [ACTIVE, HUMAN_TAKEOVER, CLOSED]
        created_at:
          type: string
          format: date-time

    PostMessageRequest:
      type: object
      required: [message, idempotency_key]
      properties:
        module:
          type: string
          enum: [marketing, sales, support, auto]
          default: auto
        message:
          type: string
          maxLength: 4000
        idempotency_key:
          type: string
          maxLength: 128
        attachments:
          type: array
          items:
            type: string

    TaskAcceptedResponse:
      type: object
      required: [task_id, conversation_id, status, task_version, correlation_id]
      properties:
        task_id:
          type: string
        conversation_id:
          type: string
        status:
          type: string
          enum: [accepted, running, waiting, awaiting_human, completed, stopped, failed]
        task_version:
          type: integer
        correlation_id:
          type: string

    TaskStateResponse:
      type: object
      required: [task_id, status, task_version, correlation_id]
      properties:
        task_id:
          type: string
        task_version:
          type: integer
        status:
          type: string
          enum: [accepted, running, waiting, awaiting_human, completed, stopped, failed]
        answer:
          type: string
        sources:
          type: array
          items:
            type: object
            required: [source_record_id, source_version, source_file]
            properties:
              source_record_id: { type: string }
              source_version: { type: string }
              source_file: { type: string }
        actions:
          type: array
          items:
            type: object
            required: [operation, status, provider_reference]
            properties:
              operation: { type: string }
              status: { type: string }
              provider_reference: { type: string }
        evidence_reference:
          type: string
        correlation_id:
          type: string

    PlatformEventEnvelope:
      type: object
      required: [event_id, event_type, source, occurred_at, payload]
      properties:
        event_id:
          type: string
        event_type:
          type: string
        source:
          type: string
        occurred_at:
          type: string
          format: date-time
        payload:
          type: object

    EventIngestionResponse:
      type: object
      required: [event_id, correlation_id, status]
      properties:
        event_id:
          type: string
        correlation_id:
          type: string
        status:
          type: string
          enum: [QUEUED, IGNORED, PROCESSED]

    ErrorResponse:
      type: object
      required: [error_code, message, retryable, correlation_id]
      properties:
        error_code:
          type: string
          enum:
            - AUTHENTICATION_FAILED
            - CUSTOMER_UNVERIFIED
            - CAPABILITY_NOT_ENABLED
            - VALIDATION_FAILED
            - IDEMPOTENCY_CONFLICT
            - APPROVAL_REQUIRED
            - PROVIDER_TIMEOUT
            - PROVIDER_REJECTED
            - RATE_LIMITED
            - TASK_NOT_FOUND
        message:
          type: string
        retryable:
          type: boolean
        correlation_id:
          type: string

    ApprovalDecisionRequest:
      type: object
      required: [decision, operator_id, reason, expected_payload_sha256]
      properties:
        decision:
          type: string
          description: >-
            Baseline SCR-003 action set. APPROVE signs and releases the payload; REJECT terminates the task;
            MODIFY authorizes a normalized new action revision (see modified_payload) only after every guard
            passes: the revision re-runs the full validation set — schema, authority/policy, consent, floor
            provenance — receives its own payload digest and deterministic effect key, and is stored
            atomically with the task checkpoint when the claim is applied; the reviewed digest and the former
            approval record are never reused. PAUSE keeps the approval PENDING with is_paused=TRUE (rendered
            PAUSED; the task stays awaiting_human) and releases nothing; CANCEL irrevocably aborts the run,
            releasing only never-dispatched reservations — a reservation whose external outcome is unresolved
            stays RESERVED for reconciliation.
          enum: [APPROVE, REJECT, MODIFY, PAUSE, CANCEL]
        expected_payload_sha256:
          type: string
          description: >-
            The digest is required and verified server-side against the canonical stored payload inside the
            same transaction as the one-time claim; the decision is applied only when it still matches, and a
            mismatch means the approver reviewed a superseded payload and is refused with 409
            APPROVAL_STALE_PAYLOAD. The claim is additionally a server-side compare-and-set on the bound
            (tenant_id, run_id, effect_key) triple, so a second click or a replayed callback updates zero
            rows and is refused with 409 APPROVAL_NOT_CLAIMABLE (see 04 §4.2).
        operator_id:
          type: string
        reason:
          type: string
          description: Mandatory rationale; for REJECT a standardized rejection code is required.
        modified_payload:
          type: object
          description: Optional modified payload when decision is MODIFY
          additionalProperties: true

    ApprovalDecisionResponse:
      type: object
      required: [approval_id, task_id, status, queued_at, correlation_id]
      properties:
        approval_id:
          type: string
        task_id:
          type: string
        status:
          type: string
          description: The decision event is durably queued; the worker owns the later guarded approval claim.
          enum: [QUEUED]
        queued_at:
          type: string
          format: date-time
        correlation_id:
          type: string
    ConversationTakeoverRequest:
      type: object
      required: [operator_id, reason, takeover_mode]
      properties:
        operator_id:
          type: string
        reason:
          type: string
        takeover_mode:
          type: string
          enum: [FULL_CONTROL, CO_PILOT]

    ConversationTakeoverResponse:
      type: object
      required: [conversation_id, status, operator_id, taken_over_at]
      properties:
        conversation_id:
          type: string
        status:
          type: string
          enum: [HUMAN_TAKEOVER]
        operator_id:
          type: string
        taken_over_at:
          type: string
          format: date-time
        lease_expires_at:
          type: string
          format: date-time
          description: Moment at which the takeover lease expires unless renewed by the heartbeat route.

    ConversationTakeoverHeartbeatRequest:
      type: object
      required: [operator_id, extend_seconds]
      properties:
        operator_id:
          type: string
          description: Must match the operator currently holding the takeover lease.
        extend_seconds:
          type: integer
          minimum: 1
          maximum: 300
          description: Lease extension requested by the operator console (UI default 60 s, renewed every 30 s).

    ConversationTakeoverHeartbeatResponse:
      type: object
      required: [conversation_id, status, operator_id, lease_expires_at]
      properties:
        conversation_id:
          type: string
        status:
          type: string
          enum: [HUMAN_TAKEOVER]
        operator_id:
          type: string
        lease_expires_at:
          type: string
          format: date-time

    ConversationResumeRequest:
      type: object
      required: [operator_id]
      properties:
        operator_id:
          type: string
        handoff_summary:
          type: string
        next_agent_id:
          type: string

    ConversationResumeResponse:
      type: object
      required: [conversation_id, status, resumed_at]
      properties:
        conversation_id:
          type: string
        status:
          type: string
          enum: [ACTIVE]
        resumed_at:
          type: string
          format: date-time
```

---

## 2. API-001 (ERP/POS Connector) Standard Interface DTOs

API-001 is the target authoritative System-of-Record boundary. Its read/write integrity requirements apply to existing client systems (SAP, Oracle NetSuite, 91APP, SHOPLINE, Cyberbiz); these vendor names are illustrative **provider choices that remain [UNCONFIRMED][ASM-001]** until the connector audit closes. No connector integrity has been demonstrated by this blueprint.

```typescript
/**
 * @file api-001-erp-dtos.ts
 * @description Formal Data Transfer Objects (DTOs) for API-001 (ERP/POS Connector).
 */

// ----------------------------------------------------------------------------
// 1. PRODUCT CATALOG SYNC DTO
// ----------------------------------------------------------------------------
export interface CatalogItemSyncDTO {
  readonly tenant_id: string;
  readonly product_id: string;
  readonly sku: string;
  readonly barcode?: string;
  readonly name: string;
  readonly description: string;
  readonly category_path: string[];
  readonly brand: string;
  readonly list_price: number;
  readonly cost_price: number;
  readonly currency: string;
  readonly is_active: boolean;
  readonly attributes: Record<string, string | number | boolean>;
  readonly updated_at: string;
}

// ----------------------------------------------------------------------------
// 2. REAL-TIME STOCK LOOKUP DTO
// ----------------------------------------------------------------------------
export interface StockLookupRequestDTO {
  readonly tenant_id: string;
  readonly sku_ids: string[];
  readonly target_warehouse_id?: string;
}

export interface WarehouseStockDetail {
  readonly warehouse_id: string;
  readonly warehouse_name: string;
  readonly physical_qty: number;
  readonly reserved_qty: number;
  readonly available_to_promise: number; // ATP = Physical - Reserved
}

export interface StockLookupResponseDTO {
  readonly tenant_id: string;
  readonly sku_id: string;
  readonly total_available_to_promise: number;
  readonly in_stock: boolean;
  readonly warehouse_breakdown: WarehouseStockDetail[];
  readonly snapshot_at: string;
}

// ----------------------------------------------------------------------------
// 3. PRICE LOOKUP & FLOOR EVALUATION DTO
// ----------------------------------------------------------------------------
export interface PriceLookupRequestDTO {
  readonly tenant_id: string;
  readonly sku_id: string;
  readonly customer_id?: string;
  readonly customer_tier?: string;
  readonly quantity: number;
}

export interface PriceLookupResponseDTO {
  readonly tenant_id: string;
  readonly sku_id: string;
  readonly original_list_price: number;
  readonly active_promotional_price?: number;
  readonly tier_discount_applied: number;
  /** Owner-approved, provenance-bearing floor; candidate field until `README.md` §8.1 is decided. */
  readonly mathematical_floor_price: number;
  readonly floor_price_source: string;
  readonly floor_price_synced_at: string;
  readonly currency: string;
  readonly tax_rate: number;
  readonly quote_token: string;
  readonly quote_expires_at: string;
}

// ----------------------------------------------------------------------------
// 4. DRAFT ORDER CREATION DTO
// ----------------------------------------------------------------------------
export interface DraftOrderLineItemDTO {
  readonly sku_id: string;
  readonly quantity: number;
  readonly agreed_unit_price: number;
  readonly quote_token: string;
}

export interface ShippingAddressDTO {
  readonly recipient_name: string;
  readonly phone: string;
  readonly postal_code: string;
  readonly city: string;
  readonly district: string;
  readonly address_line1: string;
  readonly cvs_store_id?: string; // 7-Eleven / FamilyMart Store ID
  readonly cvs_store_name?: string;
}

export interface CreateDraftOrderRequestDTO {
  readonly tenant_id: string;
  readonly effect_key: string; // BR-005 Idempotency Key
  readonly customer_id: string;
  readonly items: DraftOrderLineItemDTO[];
  readonly shipping_address: ShippingAddressDTO;
  readonly payment_method: 'CREDIT_CARD' | 'CVS_COD' | 'LINE_PAY' | 'STRIPE' | 'PAYPAL';
  readonly reservation_ttl_seconds: number; // Default 900 (15 min)
}

export interface CreateDraftOrderResponseDTO {
  readonly order_id: string;
  readonly erp_order_number: string;
  readonly subtotal: number;
  readonly tax_amount: number;
  readonly shipping_fee: number;
  readonly total_amount: number;
  readonly currency: string;
  readonly status: 'DRAFT_RESERVED' | 'PENDING_PAYMENT';
  readonly inventory_reservation_expires_at: string;
  readonly payment_gateway_url?: string;
  readonly created_at: string;
}

// ----------------------------------------------------------------------------
// 5. ORDER STATUS & FULFILLMENT DTO
// ----------------------------------------------------------------------------
export interface OrderStatusQueryDTO {
  readonly tenant_id: string;
  readonly order_id?: string;
  readonly erp_order_number?: string;
}

export interface OrderStatusResponseDTO {
  readonly order_id: string;
  readonly erp_order_number: string;
  readonly fulfillment_status: 'UNFULFILLED' | 'PARTIALLY_FULFILLED' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED';
  readonly payment_status: 'UNPAID' | 'AUTHORIZED' | 'PAID' | 'REFUNDED';
  readonly tracking_numbers: Array<{ carrier: string; tracking_number: string; tracking_url: string }>;
  readonly cancelled_at?: string;
  readonly updated_at: string;
}

// ----------------------------------------------------------------------------
// 6. CUSTOMER PROFILE LOOKUP DTO (API-001)
// ----------------------------------------------------------------------------
export interface CustomerProfileLookupRequestDTO {
  readonly tenant_id: string;
  readonly customer_id?: string;
  readonly phone?: string;
  readonly email?: string;
  readonly unified_business_no?: string; // Taiwan 8-digit GUI tax ID / 統一編號
}

export interface CustomerProfileLookupDTO {
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly name: string;
  readonly email?: string;
  readonly phone: string;
  readonly unified_business_no?: string; // B2B Tax ID
  readonly mobile_barcode_carrier?: string; // Taiwan Mobile Barcode 載具 (e.g., /AB12345)
  readonly citizen_digital_cert_id?: string; // Taiwan Citizen Digital Certificate (自然人憑證)
  readonly credit_status: 'NORMAL' | 'SUSPENDED' | 'EXCEEDED_LIMIT';
  readonly credit_limit: number;
  readonly available_credit: number;
  readonly customer_tier: 'STANDARD' | 'SILVER' | 'GOLD' | 'VIP';
  readonly loyalty_points: number;
  readonly is_blacklisted: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

// ----------------------------------------------------------------------------
// 7. CUSTOMER SALES HISTORY DTO (API-001)
// ----------------------------------------------------------------------------
export interface CustomerSalesHistoryRequestDTO {
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly lookback_months?: number; // Default 12 months
}

export interface HistoricalOrderSummaryRecord {
  readonly order_id: string;
  readonly erp_order_number: string;
  readonly order_date: string;
  readonly total_amount: number;
  readonly currency: string;
  readonly payment_status: 'PAID' | 'REFUNDED' | 'PARTIALLY_REFUNDED';
  readonly fulfillment_status: 'DELIVERED' | 'RETURNED' | 'CANCELLED';
  readonly invoice_number?: string; // Taiwan 8-digit GUI (e.g., "AB-12345678")
  readonly invoice_url?: string;
  readonly item_summary: string;
}

export interface CustomerSalesHistoryDTO {
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly currency: string;
  readonly lifetime_spend: number;
  readonly total_order_count: number;
  readonly completed_order_count: number;
  readonly returned_order_count: number;
  readonly average_order_value: number;
  readonly first_order_at: string;
  readonly last_order_at: string;
  readonly recent_orders: HistoricalOrderSummaryRecord[]; // Last 12-month order list with invoice links
}

// ----------------------------------------------------------------------------
// 8. TAIWAN ELECTRONIC GUI INVOICE DTO (API-001 / MOF Compliance)
// ----------------------------------------------------------------------------
export interface InvoiceLookupRequestDTO {
  readonly tenant_id: string;
  readonly order_id?: string;
  readonly gui_number?: string;
}

export interface InvoiceLookupDTO {
  readonly tenant_id: string;
  readonly order_id: string;
  readonly gui_number: string; // 8-digit Taiwan GUI number (e.g. "AB12345678")
  readonly invoice_date: string; // YYYY-MM-DD
  readonly invoice_time: string; // HH:mm:ss
  readonly seller_tax_id: string; // 8-digit Taiwan Company Tax ID
  readonly buyer_tax_id?: string; // 8-digit for B2B; omitted for B2C
  readonly buyer_name?: string;
  readonly carrier_type: 'MOBILE_BARCODE' | 'CITIZEN_DIGITAL' | 'DONATION' | 'PRINTED' | 'MEMBER';
  readonly carrier_id?: string; // e.g. "/1234567" for mobile barcode
  readonly donation_love_code?: string; // NPO Love Code (愛心碼 e.g. "8888")
  readonly sales_amount: number; // Untaxed amount
  readonly tax_type: 'TAXABLE' | 'ZERO_TAX' | 'DUTY_FREE';
  readonly tax_amount: number; // 5% VAT in Taiwan
  readonly total_amount: number; // sales_amount + tax_amount
  readonly status: 'ISSUED' | 'CANCELLED' | 'VOIDED';
  readonly gui_random_number: string; // 4-digit security random number (防偽隨機碼)
  readonly qr_code_left_aes: string; // MOF standardized 77-char Left QR Code (AES encrypted)
  readonly qr_code_right_aes: string; // MOF standardized Right QR Code
  readonly voided_reason?: string;
  readonly issued_at: string;
}

export interface InvoiceIssuanceRequestDTO {
  readonly tenant_id: string;
  readonly order_id: string;
  readonly buyer_tax_id?: string;
  readonly carrier_type: 'MOBILE_BARCODE' | 'CITIZEN_DIGITAL' | 'DONATION' | 'PRINTED' | 'MEMBER';
  readonly carrier_id?: string;
  readonly donation_love_code?: string;
  readonly items: Array<{
    readonly item_name: string;
    readonly quantity: number;
    readonly unit_price: number;
    readonly amount: number;
  }>;
  readonly sales_amount: number;
  readonly tax_amount: number;
  readonly total_amount: number;
}
```

---

## 3. API-002 (Event Ingestion) Stream Specification

API-002 ingests high-throughput digital events from Storefront Widgets and Native Mobile Apps directly into Kafka/Redis Streams. The p95 processing latency target (illustrative value: $< 200\text{ms}$) is **provisional pending the NFR-009 benchmark**.

### 3.0. Canonical event contract (SRS §15 API-002) and aliases

SRS API-002 defines exactly seven canonical events: **`session`, `product_view`, `search`, `click`, `add_to_cart`, `checkout`, `purchase`**. The stream payload keeps granular `event_type` values (needed for fine-grained analytics and the C360 timeline) but every event MUST also carry the derived `canonical_event` so downstream consumers can rely on the baseline set:

| Baseline canonical event | Granular `event_type` alias(es) emitted by this blueprint | Notes |
|---|---|---|
| `session` | `session.start`, `session.end` | Session lifecycle; `session.end` also closes the anonymous session window. |
| `product_view` | `product.view` | PDP/SKU detail view. |
| `search` | `search.query` | Query text + result count. |
| `click` | `element.click` | Generic UI element click (CTA, banner, nav, recommendation widget). |
| `add_to_cart` | `cart.add` | Cart addition. |
| `checkout` | `checkout.start` | Checkout funnel entry. |
| `purchase` | `order.placed` | Order confirmation from SoR. |
| — (extension) | `cart.remove` | **Not** part of the baseline canonical set; retained as an extension event for analytics only and never used as a purchase/abandonment trigger on its own. |

Events whose `event_type` has no canonical parent are marked `canonical_event: null` and treated as extension telemetry. The mapping is deterministic and versioned; a granular alias may never be silently re-pointed at a different canonical event. In storage, `customer_events.event_name` holds the canonical event — one of the seven baseline names, or the extension's `ext.<domain>.<name>` identity when `canonical_event` is null — while the original granular `event_type` and the alias-table version are retained in the stored `payload`; `source_event_id` is the dedupe key (`03` §1 Entity 4; §8.3 C-7).

```
                 [Storefront / App Webhook]
                             │
                             ▼
                 ┌───────────────────────┐
                 │  Edge API Gateway     │ ◄── TLS 1.3 Termination, Auth
                 └───────────┬───────────┘
                             │
                             ▼
                 ┌───────────────────────┐
                 │ Redis / Kafka Stream  │ ◄── Latency < 15ms
                 └───────────┬───────────┘
                             │
                             ▼
                 ┌───────────────────────┐
                 │ Stream Normalizer     │ ◄── Validates Schema, Hashes IP
                 └───────────┬───────────┘
                             │
            ┌────────────────┴────────────────┐
            ▼                                 ▼
┌───────────────────────┐         ┌───────────────────────┐
│ C360 Timeline Logger  │         │ Revenue Orchestrator  │
│ (PostgreSQL Partition)│         │ (Signal Trigger)      │
└───────────────────────┘         └───────────────────────┘
```

### 3.1. Unified Event Stream Envelope and Specific Schemas

```typescript
/**
 * @file api-002-event-stream.ts
 * @description Real-time Web/App Event Stream schemas.
 */

export interface BaseEventEnvelope<T = unknown> {
  readonly event_id: string;
  readonly tenant_id: string;
  readonly correlation_id: string;
  readonly customer_id?: string;
  readonly anonymous_id: string;
  readonly session_id: string;
  /**
   * Granular alias emitted by the widget/app. Retained for analytics; never the sole contract for
   * downstream canonical consumers (see §3.0 alias table).
   */
  readonly event_type:
    | 'session.start'
    | 'session.end'
    | 'product.view'
    | 'search.query'
    | 'element.click'
    | 'cart.add'
    | 'cart.remove'
    | 'checkout.start'
    | 'order.placed';
  /**
   * Baseline SRS §15 API-002 canonical event derived by the Stream Normalizer from event_type.
   * Extension events with no baseline parent carry null.
   */
  readonly canonical_event:
    | 'session'
    | 'product_view'
    | 'search'
    | 'click'
    | 'add_to_cart'
    | 'checkout'
    | 'purchase'
    | null;
  readonly occurred_at: string;
  readonly context: {
    readonly user_agent: string;
    readonly ip_hash: string; // Anonymized SHA-256(IP + salt)
    readonly locale: string;
    readonly page_url: string;
    readonly referrer?: string;
    readonly consent_granted: boolean;
  };
  readonly data: T;
}

// Specific Event Payloads
export interface EventProductViewData {
  readonly product_id: string;
  readonly sku: string;
  readonly category_id: string;
  readonly list_price: number;
  readonly currency: string;
  readonly dwell_time_seconds?: number;
}

export interface EventSearchQueryData {
  readonly query_text: string;
  readonly results_count: number;
  readonly filters_applied?: Record<string, string>;
}

export interface EventElementClickData {
  readonly element_id: string;
  readonly element_type: 'CTA_BUTTON' | 'BANNER' | 'NAV_LINK' | 'RECOM_WIDGET';
  readonly target_href?: string;
}

export interface EventCartMutationData {
  readonly cart_id: string;
  readonly sku_id: string;
  readonly delta_quantity: number;
  readonly unit_price: number;
  readonly total_cart_value: number;
}

export interface EventCheckoutStartData {
  readonly cart_id: string;
  readonly total_items: number;
  readonly cart_subtotal: number;
  readonly currency: string;
}

export interface EventOrderPlacedData {
  readonly order_id: string;
  readonly order_number: string;
  readonly grand_total: number;
  readonly payment_method: string;
  readonly item_count: number;
}
```

---

## 4. API-003 (Communication Connectors) Webhook Interfaces

### 4.0. Baseline channel contract

SRS API-003 requires a connector architecture covering **Facebook, TikTok, Zalo, Email, SMS and Web/App Chat**. All six are first-class members of this contract and of the `channel` enum on `POST /api/v1/conversations`:

| Baseline channel (SRS API-003) | Contract channel ID | Direction | Provider examples (illustrative — **[UNCONFIRMED][ASM-001]**) |
|---|---|---|---|
| Facebook | `MESSENGER` (and `INSTAGRAM` for the Meta family) | Bidirectional | Meta Send API / Graph webhooks |
| TikTok | `TIKTOK` | Bidirectional | TikTok Open Platform Messaging API |
| Zalo | `ZALO` | Bidirectional | Zalo OA OpenAPI / ZNS |
| Email | `EMAIL` | Mostly outbound, inbound replies via webhook | SendGrid / Mailgun / SMTP |
| SMS | `SMS` | Outbound, inbound via gateway webhook | Twilio / Chunghwa Telecom / SMS gateway |
| Web/App Chat | `WEB_CHAT`, `APP_CHAT` | Bidirectional (SSE/WSS) | First-party widget + platform API |

**Extension channels** beyond the baseline minimum: `LINE` (LINE OA) and `WHATSAPP` (WhatsApp Business Cloud API), plus the Global/Taiwan adapters in §5. These are optional, configurable additions — they are not required by the baseline and their availability is unconfirmed pending the ASM-001 connector audit.

API-003 standardizes bidirectional messaging across all the channels above; each channel MUST satisfy the inbound verification and outbound protocol contract below.

### 4.1. Channel Webhook Ingestion & Verification Specs

The provider names and provider-specific verification schemes in this table (Meta, TikTok, Zalo, SendGrid/Mailgun, Twilio/Chunghwa Telecom, LINE, WhatsApp) are **provider choices that remain [UNCONFIRMED][ASM-001]**; only the six baseline channel identities of SRS API-003 (Facebook, TikTok, Zalo, Email, SMS, Web/App Chat) are fixed by the requirement.

| Channel | Inbound Verification Scheme | Core Payload Extract | Outbound Protocol |
|---|---|---|---|
| **LINE OA** | `X-Line-Signature: HMAC-SHA256(body, channel_secret)` | `events[0].source.userId`, `message.text`, `replyToken` | LINE Messaging Push / Reply API |
| **WhatsApp** | `X-Hub-Signature-256: HMAC-SHA256(body, app_secret)` | `entry[0].changes[0].value.messages[0]` | WhatsApp Business Cloud API |
| **Messenger** | `X-Hub-Signature-256: HMAC-SHA256(body, app_secret)` | `entry[0].messaging[0].sender.id`, `message.text` | Meta Send API v19.0 |
| **TikTok** | `X-Tiktok-Signature: HMAC-SHA256(body, app_secret)` | `event: "im_message_receive"`, `sender_open_id` | TikTok Open Platform Messaging API |
| **Zalo OA** | `X-Zalo-Signature: HMAC-SHA256(app_id + body + secret)` | `event_name`, `sender.id`, `message.text` | Zalo OpenAPI / ZNS Service |
| **Email** | SendGrid / Mailgun Webhook Signature Verification | `sender`, `recipient`, `subject`, `stripped-text` | SMTP / SendGrid Transactional API |
| **SMS** | Twilio / Chunghwa Telecom Signature Digest | `From`, `To`, `Body`, `MessageSid` | SMS Gateway REST API |
| **Web Chat** | JWT Bearer Session Token + Origin Whitelist | `session_token`, `conversation_id`, `text` | WebSocket (WSS) / Server-Sent Events |

### 4.2. Concrete Webhook Signature Verification Engine

```typescript
/**
 * @file api-003-webhook-verifier.ts
 * @description Cryptographic webhook verification across all supported communication channels.
 */
import { createHmac, timingSafeEqual } from 'crypto';

export class ChannelWebhookVerifier {
  /**
   * Verifies LINE Messaging API signature.
   */
  public static verifyLineSignature(rawBody: string, signature: string, channelSecret: string): boolean {
    const hash = createHmac('sha256', channelSecret).update(rawBody).digest('base64');
    return this.safeCompare(hash, signature);
  }

  /**
   * Verifies Meta (WhatsApp, Messenger, Instagram) signature.
   */
  public static verifyMetaSignature(rawBody: string, headerSignature: string, appSecret: string): boolean {
    if (!headerSignature.startsWith('sha256=')) return false;
    const signature = headerSignature.substring(7);
    const hash = createHmac('sha256', appSecret).update(rawBody).digest('hex');
    return this.safeCompare(hash, signature);
  }

  /**
   * Verifies TikTok Open API webhook signature.
   */
  public static verifyTikTokSignature(rawBody: string, signature: string, appSecret: string): boolean {
    const hash = createHmac('sha256', appSecret).update(rawBody).digest('hex');
    return this.safeCompare(hash, signature);
  }

  /**
   * Verifies Zalo OA webhook signature.
   */
  public static verifyZaloSignature(appId: string, rawBody: string, signature: string, secretKey: string): boolean {
    const rawString = `${appId}${rawBody}${secretKey}`;
    const hash = createHmac('sha256', secretKey).update(rawString).digest('hex');
    return this.safeCompare(hash, signature);
  }

  private static safeCompare(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'utf-8');
    const bufB = Buffer.from(b, 'utf-8');
    if (bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }
}
```

---

## 5. Plug-and-Play Adapters Specification

> **Optional extension layer.** Everything in §5 is **beyond the SRS API-003 baseline** (Facebook, TikTok,
> Zalo, Email, SMS, Web/App Chat). The Taiwan (ADPT-TW-*) and Global (ADPT-GL-*) adapters are configurable,
> tenant-opt-in proposals: provider contracts, fees, quotas, and regulatory behaviour are **illustrative and
> unconfirmed** until the ASM-001 connector audit locks them. None of them is implemented.

---

### 5.1. ADPT-TW-001: Taiwan Localization Adapter (optional extension)

ADPT-TW-001 encapsulates Taiwanese commerce specifics: LINE OA, LINE Pay, ECPay / NewebPay, and CVS COD (超商取貨付款) electronic convenience store mapping (7-Eleven / FamilyMart).

#### 5.1.1. Safe Cross-Origin `postMessage` Bridge for CVS COD E-Map

When a user selects a convenience store, the Storefront Widget (running in Shadow DOM $< 20\text{ KB}$) opens the 3rd-party logistics map via an iframe or popup. The map completes and transmits back the selected store info (`cvs_store_id`, `cvs_store_name`, `cvs_address`) using `window.postMessage`.

**Origin contract (both directions).** Inbound messages are accepted only when `event.origin` is an exact member of the partner whitelist below (never a prefix or wildcard match). Outbound messages — including the open/close commands and the nonce handshake the widget sends to the E-Map frame — are posted with the **exact partner origin as `targetOrigin`**; `'*'` is never used as a `targetOrigin`, in this bridge or in the Storefront Widget's host-page bridge (`07-human-command-center-ui.md` §7.3).

```
┌────────────────────────────────────────────────────────────────────────┐
│ Host E-Commerce Storefront (Parent Window)                             │
│                                                                        │
│   ┌──────────────────────────────────────────────────────────────┐     │
│   │ Shadow DOM Storefront Widget (< 20 KB)                       │     │
│   │                                                              │     │
│   │  1. Generates cryptographic session nonce token              │     │
│   │  2. Launches Modal iframe/popup with E-Map URL               │     │
│   │                                                              │     │
│   │   ┌──────────────────────────────────────────────────────┐   │     │
│   │   │ Iframe / Popup Window (ECPay / Logistics E-Map)      │   │     │
│   │   │                                                      │   │     │
│   │   │ Customer picks 7-Eleven or FamilyMart store          │   │     │
│   │   │ Clicks "Confirm Store Selection"                     │   │     │
│   │   │ Dispatches window.postMessage()                      │   │     │
│   │   └──────────────────────────┬───────────────────────────┘   │     │
│   │                              │ postMessage                   │     │
│   │                              ▼                               │     │
│   │  3. Validates event.origin against partner whitelist         │     │
│   │  4. Validates nonce token & schema integrity                 │     │
│   │  5. Ingests store_id, closes modal, notifies Core Engine     │     │
│   └──────────────────────────────────────────────────────────────┘     │
└────────────────────────────────────────────────────────────────────────┘
```

#### Concrete PostMessage Bridge Implementation

```typescript
/**
 * @file cvs-emap-postmessage-bridge.ts
 * @description Secure PostMessage listener for Taiwan CVS E-Map integration.
 */

export interface CVSEMapPayload {
  readonly cvs_type: 'SEVEN_ELEVEN' | 'FAMILY_MART';
  readonly store_id: string;
  readonly store_name: string;
  readonly store_address: string;
  readonly nonce: string;
}

export class CVSEMapBridge {
  private static readonly WHITELISTED_ORIGINS = new Set([
    'https://logistics.ecpay.com.tw',
    'https://map.newebpay.com',
    'https://emap.pres-exact.com.tw', // 7-Eleven
    'https://fmretail.famiport.com.tw', // FamilyMart
  ]);

  private activeNonce: string | null = null;
  private onStoreSelectedCallback: ((data: CVSEMapPayload) => void) | null = null;

  public initSession(onSuccess: (data: CVSEMapPayload) => void): string {
    this.activeNonce = crypto.randomUUID();
    this.onStoreSelectedCallback = onSuccess;
    window.addEventListener('message', this.handleMessage.bind(this), false);
    return this.activeNonce;
  }

  private handleMessage(event: MessageEvent): void {
    // 1. Strict Origin Whitelist Verification
    if (!CVSEMapBridge.WHITELISTED_ORIGINS.has(event.origin)) {
      console.warn(`[SECURITY] Blocked unwhitelisted postMessage origin: ${event.origin}`);
      return;
    }

    // 2. Validate Message Structure
    const data = event.data as Partial<CVSEMapPayload>;
    if (!data || typeof data !== 'object') return;

    // 3. Verify Nonce to Prevent Replay Attacks
    if (data.nonce !== this.activeNonce) {
      console.error('[SECURITY] Nonce mismatch in CVS E-Map postMessage');
      return;
    }

    // 4. Validate Mandatory Fields
    if (!data.store_id || !data.store_name || !data.store_address) {
      console.error('[VALIDATION] Incomplete CVS store payload');
      return;
    }

    // 5. Success Callback & Clean Up
    if (this.onStoreSelectedCallback) {
      this.onStoreSelectedCallback(data as CVSEMapPayload);
    }
    this.destroy();
  }

  public destroy(): void {
    window.removeEventListener('message', this.handleMessage.bind(this));
    this.activeNonce = null;
    this.onStoreSelectedCallback = null;
  }
}
```

#### 5.1.2. ADPT-TW-002: LINE OA Push Quota Cost Guard

LINE Official Account charges per push message above monthly contract tiers in Taiwan and Japan. Uncontrolled broadcast pushes trigger substantial commercial overage penalties. `LineOACostGuard` enforces automated quota protection:
- **80% Consumption Threshold**: Emits proactive monitoring warning alerts to operator console.
- **100% Quota Exhaustion**: Strictly blocks proactive broadcast push messages. If a free `replyToken` is valid (within 60-second inbound response window), traffic routes to free `replyMessage` API; otherwise, traffic is forced into Web Chat widget fallback.

```typescript
/**
 * @file adpt-tw-002-line-oa-cost-guard.ts
 * @description Monitors and enforces LINE Official Account push message quotas per tenant billing cycle.
 */

export interface LineOAQuotaStatus {
  readonly tenant_id: string;
  readonly billing_cycle_month: string; // e.g., "2026-09"
  readonly plan_type: 'LIGHT' | 'STANDARD' | 'ENTERPRISE_CUSTOM';
  readonly monthly_push_quota: number;
  readonly push_messages_consumed: number;
  readonly consumption_ratio: number; // e.g., 0.85 (85%)
  readonly status: 'NORMAL' | 'WARNING_THRESHOLD' | 'QUOTA_EXHAUSTED';
  readonly last_reset_at: string;
  readonly next_reset_at: string;
}

export interface LinePushEligibilityResult {
  readonly can_dispatch: boolean;
  readonly dispatch_channel: 'LINE_PUSH_API' | 'LINE_REPLY_API' | 'FALLBACK_WEB_CHAT';
  readonly is_free_tier_action: boolean;
  readonly reason?: string;
  readonly quota_status: LineOAQuotaStatus;
}

export class LineOACostGuard {
  private static readonly WARNING_THRESHOLD = 0.80; // 80% quota warning
  private static readonly HARD_BLOCK_THRESHOLD = 1.00; // 100% hard block on push

  private readonly quotaStore: Map<string, LineOAQuotaStatus> = new Map();

  /**
   * Initializes or updates a tenant's LINE OA subscription quota.
   */
  public registerTenantPlan(
    tenantId: string,
    billingCycleMonth: string,
    planType: 'LIGHT' | 'STANDARD' | 'ENTERPRISE_CUSTOM',
    monthlyQuota: number
  ): LineOAQuotaStatus {
    const status: LineOAQuotaStatus = {
      tenant_id: tenantId,
      billing_cycle_month: billingCycleMonth,
      plan_type: planType,
      monthly_push_quota: monthlyQuota,
      push_messages_consumed: 0,
      consumption_ratio: 0,
      status: 'NORMAL',
      last_reset_at: new Date().toISOString(),
      next_reset_at: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString(),
    };
    this.quotaStore.set(tenantId, status);
    return status;
  }

  /**
   * Evaluates if an outbound message can be dispatched via paid LINE Push API or must use free fallback.
   * 
   * Rule 1: If replyToken is available (within 60s of user webhook), always use free replyMessage API.
   * Rule 2: If quota < 80%, allow paid Push API without restriction.
   * Rule 3: If 80% <= quota < 100%, allow Push API but emit WARNING_THRESHOLD alert.
   * Rule 4: If quota >= 100%, BLOCK proactive Push API. If replyToken exists, route to free reply API;
   *         otherwise fallback to Web Chat widget invitation.
   */
  public async evaluatePushEligibility(
    tenantId: string,
    replyTokenAvailable: boolean
  ): Promise<LinePushEligibilityResult> {
    const quota = await this.getQuotaStatus(tenantId);

    // Free replyToken takes precedence (zero billing cost)
    if (replyTokenAvailable) {
      return {
        can_dispatch: true,
        dispatch_channel: 'LINE_REPLY_API',
        is_free_tier_action: true,
        quota_status: quota,
      };
    }

    // Quota exhausted (100% threshold reached)
    if (quota.consumption_ratio >= LineOACostGuard.HARD_BLOCK_THRESHOLD) {
      return {
        can_dispatch: false,
        dispatch_channel: 'FALLBACK_WEB_CHAT',
        is_free_tier_action: false,
        reason: `LINE_QUOTA_EXHAUSTED: Tenant ${tenantId} reached 100% push quota (${quota.push_messages_consumed}/${quota.monthly_push_quota}). Proactive push blocked.`,
        quota_status: quota,
      };
    }

    // Within quota (or warning threshold between 80% and 100%)
    return {
      can_dispatch: true,
      dispatch_channel: 'LINE_PUSH_API',
      is_free_tier_action: false,
      reason: quota.consumption_ratio >= LineOACostGuard.WARNING_THRESHOLD
        ? `LINE_QUOTA_WARNING: Tenant ${tenantId} at ${(quota.consumption_ratio * 100).toFixed(1)}% push quota.`
        : undefined,
      quota_status: quota,
    };
  }

  /**
   * Atomically records consumed push messages after successful dispatch.
   */
  public async recordPushMessage(tenantId: string, count: number = 1): Promise<LineOAQuotaStatus> {
    const current = await this.getQuotaStatus(tenantId);
    const updatedConsumed = current.push_messages_consumed + count;
    const ratio = current.monthly_push_quota > 0 ? updatedConsumed / current.monthly_push_quota : 1.0;

    let status: LineOAQuotaStatus['status'] = 'NORMAL';
    if (ratio >= LineOACostGuard.HARD_BLOCK_THRESHOLD) {
      status = 'QUOTA_EXHAUSTED';
    } else if (ratio >= LineOACostGuard.WARNING_THRESHOLD) {
      status = 'WARNING_THRESHOLD';
    }

    const updated: LineOAQuotaStatus = {
      ...current,
      push_messages_consumed: updatedConsumed,
      consumption_ratio: Number(ratio.toFixed(4)),
      status,
    };

    this.quotaStore.set(tenantId, updated);
    return updated;
  }

  /**
   * Retrieves current billing cycle quota status for a tenant.
   */
  public async getQuotaStatus(tenantId: string): Promise<LineOAQuotaStatus> {
    const existing = this.quotaStore.get(tenantId);
    if (!existing) {
      // Default to standard 1,000 free pushes if unconfigured
      return {
        tenant_id: tenantId,
        billing_cycle_month: new Date().toISOString().substring(0, 7),
        plan_type: 'LIGHT',
        monthly_push_quota: 1000,
        push_messages_consumed: 0,
        consumption_ratio: 0,
        status: 'NORMAL',
        last_reset_at: new Date().toISOString(),
        next_reset_at: new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).toISOString(),
      };
    }
    return existing;
  }
}
```

---

### 5.2. ADPT-GL-001..003: Global Plug-and-Play Adapters

#### 5.2.1. ADPT-GL-001: WhatsApp 24h Session Window Guard

In Meta's WhatsApp Cloud API, businesses can reply with free-form text only within 24 hours of the customer's last inbound message ("Session Window"). Beyond 24 hours, the system strictly forbids free-form messages (`AUTH-5`) and enforces Meta pre-approved Message Templates (Utility/Marketing) with billing attribution.

```typescript
/**
 * @file adpt-gl-001-whatsapp-window-guard.ts
 * @description Enforces WhatsApp 24-hour customer service window vs paid template boundary.
 */

export class WhatsAppSessionWindowGuard {
  private static readonly TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

  /**
   * Asserts whether a message can be dispatched as free-form text or requires paid template.
   */
  public static evaluateDispatchPolicy(lastInboundTimestampIso: string): {
    can_send_free_form: boolean;
    required_mode: 'FREE_FORM_TEXT' | 'PAID_TEMPLATE_REQUIRED';
    window_remaining_minutes: number;
  } {
    const lastInboundTime = new Date(lastInboundTimestampIso).getTime();
    const elapsed = Date.now() - lastInboundTime;
    const remainingMs = WhatsAppSessionWindowGuard.TWENTY_FOUR_HOURS_MS - elapsed;

    if (remainingMs > 0) {
      return {
        can_send_free_form: true,
        required_mode: 'FREE_FORM_TEXT',
        window_remaining_minutes: Math.floor(remainingMs / 60000),
      };
    }

    return {
      can_send_free_form: false,
      required_mode: 'PAID_TEMPLATE_REQUIRED',
      window_remaining_minutes: 0,
    };
  }
}
```

#### 5.2.2. ADPT-GL-002: Multi-Currency Gateway with Time-Locked FX Buffer `[OPTIONAL-EXTENSION][UNCONFIRMED][ASM-001]`

This is an isolated platform-derived FX candidate, not a selected floor model or a production quote path (README §8.1; `08` §3.3). Business/Finance must approve the buffer and lock window under ASM-003; neither has a platform default. Rate source, rounding and floor provenance remain `[OWNER-DECISION-REQUIRED]`. Under the ERP/policy-service model the adapter instead validates the source-supplied quote/floor. No calculation below substitutes for an owner-approved, provenance-bearing floor decision.

##### Mathematical Safeguard Formulation
- Let $P_{base}$ be the unit price in the tenant's domestic ledger base currency (e.g., TWD).
- Let $P_{floor}$ be the non-negotiable floor price boundary in base currency (`BR-001`, `BR-002`).
- Let $R_{spot}$ be the spot exchange rate defined as domestic base currency per 1 unit of target foreign currency ($\frac{\text{Base}}{\text{Foreign}}$, e.g., $32.0\text{ TWD / USD}$).
- Let $B$ be an explicitly owner-approved FX safety buffer fraction, $0 \le B < 1$; no default or policy range is fixed here.
- The guaranteed rate protecting the seller against foreign currency depreciation is:
  $$R_{guaranteed} = R_{spot} \times (1 - B)$$
- The foreign currency price quoted to the buyer is calculated as:
  $$P_{foreign} = \frac{P_{base}}{R_{guaranteed}} = \frac{P_{base}}{R_{spot} \times (1 - B)}$$
- **Floor Invariant Proof**: When the customer pays $P_{foreign}$, the minimum base currency yield received upon settlement at rate $R_{settlement} \ge R_{guaranteed}$ satisfies:
  $$\text{ConvertedBase} = P_{foreign} \times R_{settlement} \ge P_{foreign} \times R_{guaranteed} = \left(\frac{P_{base}}{R_{guaranteed}}\right) \times R_{guaranteed} = P_{base} \ge P_{floor}$$
  This conditional arithmetic assumes the stated settlement-rate bound and does not prove that a provider guarantees that rate. Rounding and provider settlement evidence must be verified before dispatch; this is `[NOT-RUNTIME-EVIDENCE]`.

```typescript
/**
 * @file adpt-gl-002-fx-safeguard.ts
 * @description Multi-currency FX Safety Buffer protecting mathematical floor price P_floor.
 */

export interface TimeLockedFXQuote {
  readonly quote_id: string;
  readonly base_currency: string;
  readonly target_currency: string;
  readonly spot_rate: number; // Base currency units per 1 unit of foreign currency
  readonly buffer_percent: number; // explicit owner-approved fraction; no default
  readonly guaranteed_rate: number; // spot_rate * (1 - buffer_percent)
  readonly expires_at: number; // Timestamp ms
}

export class FXSafeguardEngine {
  /**
   * Generates a time-locked FX quote with safety margin.
   */
  public static createLockedQuote(
    baseCurrency: string,
    targetCurrency: string,
    liveSpotRate: number,
    approvedBuffer: number,
    approvedTtlMs: number
  ): TimeLockedFXQuote {
    if (!Number.isFinite(liveSpotRate) || liveSpotRate <= 0
      || !Number.isFinite(approvedBuffer) || approvedBuffer < 0 || approvedBuffer >= 1
      || !Number.isSafeInteger(approvedTtlMs) || approvedTtlMs <= 0) {
      throw new Error('P_FLOOR_UNAVAILABLE: explicit valid FX policy inputs are required.');
    }
    const quote_id = `fx_${crypto.randomUUID()}`;
    const guaranteed_rate = liveSpotRate * (1 - approvedBuffer);

    return {
      quote_id,
      base_currency: baseCurrency,
      target_currency: targetCurrency,
      spot_rate: liveSpotRate,
      buffer_percent: approvedBuffer,
      guaranteed_rate: Number(guaranteed_rate.toFixed(6)),
      expires_at: Date.now() + approvedTtlMs,
    };
  }

  /**
   * Calculates foreign price quoted to international customer with safety buffer.
   * Formula: ForeignPrice = BasePrice / guaranteed_rate
   * where guaranteed_rate = spot_rate * (1 - buffer_percent)
   */
  public static calculateForeignPrice(
    basePrice: number,
    lockedQuote: TimeLockedFXQuote
  ): number {
    if (!this.isQuoteValid(lockedQuote)) {
      throw new Error('FX_QUOTE_EXPIRED: Exchange rate guarantee expired; re-pricing required.');
    }
    const foreignPrice = basePrice / lockedQuote.guaranteed_rate;
    return Number(foreignPrice.toFixed(2));
  }

  /**
   * Validates if quote is still valid or has expired.
   */
  public static isQuoteValid(quote: TimeLockedFXQuote): boolean {
    return Date.now() < quote.expires_at;
  }

  /**
   * Asserts that converted foreign currency price does not breach base P_floor.
   * Formula: ConvertedBase = foreignPrice * guaranteed_rate >= baseFloorPrice
   */
  public static assertPriceAboveFloor(
    foreignPrice: number,
    baseFloorPrice: number,
    lockedQuote: TimeLockedFXQuote
  ): void {
    if (!this.isQuoteValid(lockedQuote)) {
      throw new Error('FX_QUOTE_EXPIRED: Exchange rate guarantee expired; re-pricing required.');
    }

    // Convert foreign offer back to base using guaranteed rate
    const convertedBaseAmount = foreignPrice * lockedQuote.guaranteed_rate;
    if (convertedBaseAmount < baseFloorPrice) {
      throw new Error(
        `ERR_FLOOR_PRICE_VIOLATION: Converted amount ${convertedBaseAmount.toFixed(2)} ${lockedQuote.base_currency} < P_floor ${baseFloorPrice} ${lockedQuote.base_currency}`
      );
    }
  }
}
```

#### 5.2.3. ADPT-GL-003: Multi-Region Compliance & Automated DSAR Endpoint

ADPT-GL-003 supports partitioning across AWS Frankfurt (`eu-central-1` GDPR), AWS US East (`us-east-1` CCPA/CPRA), and AWS Singapore (`ap-southeast-1` APAC PDPA). It exposes a standardized Data Subject Access Request (DSAR) interface:

```typescript
/**
 * @file adpt-gl-003-dsar-spec.ts
 * @description Automated Data Subject Access Request (DSAR) interface for GDPR/CCPA.
 */

export interface DSARRequest {
  readonly request_id: string;
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly request_type: 'EXPORT_DATA' | 'DELETE_DATA_FORGOTTEN' | 'REVOKE_CONSENT';
  readonly jurisdiction: 'GDPR' | 'CCPA' | 'TAIWAN_PDPA' | 'SINGAPORE_PDPA';
  readonly verification_signature: string;
  readonly requested_at: string;
}

export interface DSARResponse {
  readonly request_id: string;
  readonly status: 'COMPLETED' | 'SCHEDULED_FOR_PURGE';
  readonly export_archive_url?: string;
  readonly purge_effective_date?: string;
  readonly audit_evidence_hash: string;
}
```

---

## 6. Domain-Specific Commerce Connectors & DTOs (optional vertical extensions)

> **Extension notice.** The EV Mobility (DOM-MOB-*) and FMCG (DOM-FMCG-*) connectors below are optional
> vertical proposals outside the SRS API-001..003 baseline. Their fields, thresholds (e.g. the 20 % CVS
> non-pickup rule) and regulatory assumptions are **illustrative and configurable per tenant**, and are
> unconfirmed until the ASM-001 connector audit and the owning business unit lock them.

Specialized business domains require tailored schema contracts to capture localized industry processes while remaining decoupled from generic ERP layers.

```typescript
/**
 * @file domain-connectors-dtos.ts
 * @description Domain-specific DTOs for EV Mobility O2O and FMCG Retail.
 */

// ----------------------------------------------------------------------------
// 6.1. EV MOBILITY O2O CONNECTORS (DOM-MOB-001..003)
// ----------------------------------------------------------------------------

/**
 * DOM-MOB-001: 3-Tier Subsidy Calculation DTO
 * Calculates central government, environmental protection, and local municipal subsidies in Taiwan.
 */
export interface EVSubsidyCalculationRequestDTO {
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly vehicle_sku_id: string;
  readonly residency_city: string; // e.g., "Taipei City", "Taichung City"
  readonly residency_district: string; // e.g., "Xinyi District"
  readonly has_scrap_ice_vehicle: boolean; // Scrap Internal Combustion Engine vehicle trade-in (汰舊換新)
  readonly scrap_vehicle_manufacture_year?: number;
  readonly is_low_income_household?: boolean;
}

export interface EVSubsidyTierBreakdown {
  readonly tier_name: 'CENTRAL_MOEA' | 'CENTRAL_MOENV' | 'MUNICIPAL_LOCAL' | 'SCRAP_ICE_BONUS';
  readonly authority_name: string; // e.g., "經濟部產業發展署", "環境部", "臺北市政府環保局"
  readonly amount: number; // Subsidy amount in TWD
  readonly qualification_status: 'QUALIFIED' | 'DISQUALIFIED' | 'PENDING_DOCUMENTATION';
  readonly condition_description: string;
}

export interface EVSubsidyCalculationResponseDTO {
  readonly vehicle_sku_id: string;
  readonly vehicle_name: string;
  readonly list_price_twd: number;
  readonly total_subsidy_amount_twd: number;
  readonly final_out_of_pocket_price_twd: number;
  readonly subsidy_tiers: EVSubsidyTierBreakdown[];
  readonly required_proof_documents: string[]; // e.g., ["戶籍謄本", "舊車行照與報廢證明"]
  readonly calculation_snapshot_id: string;
  readonly valid_until: string;
}

/**
 * DOM-MOB-002: Battery Swap Station Finder DTO
 * Locates nearest battery swap stations (Gogoro Network, Ionex) with real-time slot and charge telemetry.
 */
export interface BatterySwapStationQueryDTO {
  readonly tenant_id: string;
  readonly user_latitude: number;
  readonly user_longitude: number;
  readonly search_radius_meters: number; // Default 5000 (5km)
  readonly network_provider?: 'GOGORO_NETWORK' | 'IONEX' | 'ALL';
  readonly min_available_batteries?: number; // Filter for stations with >= N fully charged packs
}

export interface BatterySwapStationRecord {
  readonly station_id: string;
  readonly network_provider: 'GOGORO_NETWORK' | 'IONEX';
  readonly station_name: string;
  readonly address: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly distance_meters: number;
  readonly total_slots: number;
  readonly fully_charged_batteries_available: number;
  readonly operational_status: 'ONLINE' | 'MAINTENANCE' | 'OFFLINE';
  readonly navigation_deep_link: string; // Google Maps / Apple Maps URI
}

export interface BatterySwapStationResponseDTO {
  readonly user_latitude: number;
  readonly user_longitude: number;
  readonly total_stations_found: number;
  readonly stations: BatterySwapStationRecord[];
  readonly query_timestamp: string;
}

/**
 * DOM-MOB-003: Test-Ride Booking & Showroom Deposit DTO
 * Handles driver license verification, showroom slot reservations, and deposit pre-authorizations.
 */
export interface TestRideBookingRequestDTO {
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly customer_name: string;
  readonly customer_phone: string;
  readonly vehicle_sku_id: string;
  readonly showroom_branch_id: string;
  readonly reservation_slot_start: string; // ISO-8601 UTC
  readonly reservation_slot_end: string;
  readonly driver_license_category: 'TAIWAN_REGULAR_HEAVY_MOTORCYCLE' | 'TAIWAN_LIGHT_MOTORCYCLE' | 'INTERNATIONAL_PERMIT';
  readonly driver_license_number_hash: string;
  readonly liability_waiver_agreed: boolean;
  readonly deposit_preauth_token?: string; // Tokenized Stripe/LinePay pre-auth for VIP test rides
}

export interface TestRideBookingResponseDTO {
  readonly booking_id: string;
  readonly customer_id: string;
  readonly vehicle_sku_id: string;
  readonly vehicle_name: string;
  readonly showroom_branch_name: string;
  readonly showroom_address: string;
  readonly reservation_slot_start: string;
  readonly reservation_slot_end: string;
  readonly booking_status: 'CONFIRMED' | 'PENDING_BRANCH_VERIFICATION' | 'CANCELLED';
  readonly checkin_qr_code_payload: string; // For physical store scanner
  readonly deposit_amount_twd: number;
  readonly deposit_status: 'PRE_AUTHORIZED' | 'WAIVED' | 'CAPTURED';
  readonly created_at: string;
}

// ----------------------------------------------------------------------------
// 6.2. FMCG SUBSCRIPTION & FRAUD PREVENTION CONNECTORS (DOM-FMCG-002..003)
// ----------------------------------------------------------------------------

/**
 * DOM-FMCG-002: Periodic Subscription (定期購) DTO
 * Supports automated recurring replenishment with customizable cycles and pause/skip policies.
 */
export interface PeriodicSubscriptionCreateDTO {
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly sku_id: string;
  readonly quantity_per_cycle: number;
  readonly unit_subscription_price: number; // Discounted subscription price
  readonly frequency: 'WEEKLY' | 'BI_WEEKLY' | 'MONTHLY' | 'BI_MONTHLY' | 'QUARTERLY';
  readonly recurring_payment_token: string; // Tokenized payment authorization (Stripe/ECPay/LinePay)
  readonly preferred_delivery_weekday?: 1 | 2 | 3 | 4 | 5 | 6 | 7; // Monday=1 ... Sunday=7
  readonly shipping_address: ShippingAddressDTO;
  readonly minimum_commitment_cycles: number; // e.g., 3 cycles minimum before cancellation allowed
  readonly auto_renewal: boolean;
}

export interface PeriodicSubscriptionRecordDTO {
  readonly subscription_id: string;
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly sku_id: string;
  readonly frequency: 'WEEKLY' | 'BI_WEEKLY' | 'MONTHLY' | 'BI_MONTHLY' | 'QUARTERLY';
  readonly status: 'ACTIVE' | 'PAUSED' | 'CANCELLED' | 'PAYMENT_FAILED';
  readonly completed_cycles: number;
  readonly remaining_commitment_cycles: number;
  readonly next_billing_date: string;
  readonly next_delivery_estimated_date: string;
  readonly discount_rate_percent: number; // e.g. 15% off regular list price
  readonly allow_skip_next: boolean;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * DOM-FMCG-003: CVS COD Return Fraud & Blacklist Risk Flag DTO
 * Protects merchants against repeated uncollected convenience store packages (超商未取貨).
 */
export interface CVSCODFraudEvaluationRequestDTO {
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly phone: string;
  readonly order_total_amount: number;
  readonly cvs_store_id: string;
  readonly target_sku_ids: string[];
}

export interface CVSCODFraudEvaluationResponseDTO {
  readonly customer_id: string;
  readonly phone_masked: string;
  readonly historical_cod_order_count: number;
  readonly non_pickup_count: number; // Number of uncollected parcels returned
  readonly non_pickup_rate: number; // e.g., 0.25 (25% non-pickup rate)
  readonly risk_score: number; // 0 to 100 (100 = highest fraud risk)
  readonly risk_tier: 'LOW' | 'MEDIUM' | 'HIGH' | 'BLACKLISTED';
  readonly allow_cvs_cod: boolean; // False if non-pickup rate > 20% or blacklist
  readonly max_allowed_cod_amount: number; // 0 if disallowed, else capped (e.g. 2000 TWD)
  readonly restriction_action: 'NONE' | 'CAP_AMOUNT' | 'REQUIRE_PREPAYMENT' | 'HARD_BLOCK';
  readonly reason?: string;
  readonly evaluated_at: string;
}
```

---

## 7. End-to-End Connector Testing Matrix

All latency figures in this matrix are **provisional design targets pending the NFR-009 benchmark**; the
matrix defines the behaviour to assert, not a measured SLA.

| Suite ID | Subsystem | Test Objective | Pass Criteria |
|---|---|---|---|
| `TC-CON-001` | Core REST APIs | Submit consultation message via `/api/v1/conversations/{id}/messages`. | Returns `202 Accepted` with valid `task_id` and `correlation_id` (target $< 50\text{ms}$, provisional). |
| `TC-CON-002` | API-001 ERP | Execute real-time stock lookup under high concurrency. | Returns ATP counts per warehouse (target $< 200\text{ms}$, provisional); fail closed on timeout. |
| `TC-CON-003` | API-002 Stream | Ingest $10,000$ telemetry events into event stream. | End-to-end ingestion and C360 Timeline write completes (target p95 $< 200\text{ms}$, provisional). |
| `TC-CON-004` | API-003 Webhook | Inbound message with tampered HMAC signature. | Gateway rejects with `401 Unauthorized` before invoking agents. |
| `TC-CON-005` | ADPT-TW-001 | CVS E-Map `postMessage` bridge with unwhitelisted origin. | PostMessage listener discards event; logs `[SECURITY]` warning. |
| `TC-CON-006` | ADPT-TW-002 | Line OA push dispatched when monthly quota reaches 100%. | Hard block triggers; rejects push and falls back to Web Chat / reply token. |
| `TC-CON-007` | ADPT-GL-001 | Attempt sending free-form WhatsApp message at 25 hours. | WhatsApp Guard rejects free-form; forces pre-approved template. |
| `TC-CON-008` | ADPT-GL-002 | FX rate changes by $-5\%$ during checkout session. | Locked quote rate buffer holds; prevents conversion breach of $P_{floor}$. |
| `TC-CON-009` | Core Gateway | Operator submits each SCR-003 decision via `/api/v1/approvals/{id}/decision`. | Every decision returns `202 QUEUED` with `task_id` and `queued_at`; the worker later claims the event and applies the guarded transition. An identical replay is accepted without a second write; a different event conflicts; no other approval route exists. |
| `TC-CON-010` | DOM Connectors | Evaluate FMCG customer with $> 20\%$ CVS non-pickup rate (DOM-FMCG-003). | `allow_cvs_cod` returns `false`, forces `REQUIRE_PREPAYMENT` action. |
| `TC-CON-011` | Core Gateway | Replay the same `idempotency_key`/`effect_key`: (a) byte-identical payload, (b) mutated payload. | (a) returns the cached receipt with the original `task_id` and executes no second external effect; (b) returns `409 IDEMPOTENCY_CONFLICT`. |
| `TC-CON-012` | SCR-005 Control | Operator takes over, heartbeats, then resumes the conversation. | Takeover locks AI outbound replies; heartbeat extends `lease_expires_at`; resume returns status `ACTIVE` (agent control) and releases the lease. |

## 8. Complete `/api/v1` Route Inventory and Wire Contract `[SRS-MUST][SRS §15, §18 / API-001..003]`

This section is the **single authoritative target route inventory** for the implementation pack. It supersedes the per-family summary that previously stood here and the "eight REST routes" wording of §1.1: the OpenAPI document in §1 declares eight of the seventeen baseline operations (the four core routes, the approval decision, and the three conversation-control routes), and §1.1's five additional rows plus the four Command Center reads complete the set. Every row below is a **target contract**; no gateway, endpoint, or adapter exists today, and none of these routes can be served by this repository.

### 8.0 Count, scope, and conventions

**Baseline target operations: 18.** The count is deliberately explicit and is the reference number for the rest of the pack. Seven are reads or streams — R03, R09, R10, and R14–R17 — and eleven drive state:

| Count group | # | Operations |
|---|---|---|
| Conversation/task/event core | 4 | R01 `POST /conversations`; R02 `POST /conversations/{conversation_id}/messages`; R03 `GET /tasks/{task_id}`; R04 `POST /events` |
| Approval and reconciliation decisions | 2 | R05 `POST /approvals/{approval_id}/decision`; R18 `POST /operations/runs/{run_id}/reconciliation` |
| Conversation control | 3 | R06 `POST /conversations/{id}/takeover`; R07 `POST /conversations/{id}/takeover/heartbeat`; R08 `POST /conversations/{id}/resume` |
| Realtime | 2 | R09 `GET /telemetry/stream` (SSE); R10 `WS /ws/stream` (WebSocket) |
| Storefront | 2 | R11 `POST /storefront/stream`; R12 `POST /storefront/events` |
| Operator retry | 1 | R13 `POST /operations/runs/{run_id}/retry` |
| Command Center reads | 4 | R14 `GET /approvals?status=PENDING`; R15 `GET /customers/{customer_id}/timeline`; R16 `GET /runs`; R17 `GET /telemetry/kpi-snapshot` |
| **Total** | **18** | |

Counted **separately** from the baseline (never silently folded into the 18, never treated as aliases):

| Surface class | Count | Detail |
|---|---|---|
| Supplemental SCR-003 detail read | 1 operation | `GET /api/v1/approvals/{approval_id}` (§8.2.1) — required by SCR-003 to render the evidence card and to capture the reviewed payload digest |
| Browser/OAuth callback surfaces owned by `01` | 2 paths | `LINE_LOGIN_CALLBACK_URL` and `CVS_EMAP_CALLBACK_URL` defaults in the `01` §8 Configuration Catalog (`/api/v1/auth/line/callback`, `/api/v1/shipping/cvs/callback`); redirect/OAuth endpoints, not JSON gateway operations |
| Provider webhook ingress | 0 gateway route paths templated | §4.1 templates **verification schemes and payload extracts**, not per-provider gateway paths; provider deliveries reach the platform through R04 or the channel adapter ingress and remain `[OPTIONAL-EXTENSION][UNCONFIRMED][ASM-001]` |

**Conventions that apply to every operation below**

- **Base path:** `/api/v1` only. There is no unprefixed and no `/v1`-only variant in the implementation contract; the `/v1` wording in `plans/` is recorded in the `README.md` §9 propagation register.
- **Tenant binding:** `tenant_id` is resolved server-side from the authenticated session/credential and the RLS context (NFR-006, `03` §2). A body/query/header `tenant_id` is a routing hint at most and is never the isolation factor; a mismatch is refused, never merged.
- **Error envelope:** `{ error_code, message, retryable, correlation_id, details? }` (`ErrorResponse`, §1). Business-rule codes are owned by `08` §8 (`P_FLOOR_UNAVAILABLE`, `ERR_FLOOR_PRICE_VIOLATION`, `AUTHORITATIVE_SOURCE_UNAVAILABLE`, `CONSENT_REQUIRED`, …); the `ErrorResponse.error_code` enum in §1 is an illustrative subset that implementation MUST extend to the `08` vocabulary rather than re-spell.
- **Success is never claimed without proof:** a route returns `202`/`200` plus a durable `task_id`/receipt; it never returns "sent"/"executed" for an effect whose provider receipt is absent. Indeterminate external outcomes are `UNKNOWN` and reconcile by `effect_key` (`04` §4.4).
- **Audit and evidence:** every operation writes an `agentos.audit_records` row (`08` §4.1); any operation that can produce an external effect additionally references an `agentos.evidence_records` row (BR-010, NFR-002). Reads write the audit row and no evidence row.
- **Pagination:** cursor-based for every collection (`cursor`, `limit`); no page numbers, no offsets. `limit` defaults/maxima are `[PROVISIONAL][ASM-002]` and MUST NOT be treated as policy.

### 8.1 Baseline operations — per-route wire contract

Each row states auth/tenant binding, concrete request and response schema, the state transition it drives, idempotency behaviour, pagination, the error set, and the audit/evidence obligation.

**8.1.1 Conversation, task, approval, and conversation-control operations (R01–R08)**

| # | Auth & tenant binding | Request schema | Success response | State transition | Idempotency | Pagination | Errors | Audit & evidence |
|---|---|---|---|---|---|---|---|---|
| R01 | Channel session credential (widget/app) or operator session; tenant from the authenticated session; unknown `customer_identifier` never resolves an identity by itself (`04` §5) | `CreateConversationRequest` (§1): `channel` ∈ API-003 baseline `WEB_CHAT`/`MESSENGER`/`TIKTOK`/`ZALO`/`EMAIL`/`SMS` (+ extension values), `customer_identifier`, optional `metadata` | `201 ConversationSessionResponse`: `conversation_id`, `session_token`, `status`, `created_at` | Inserts an `agentos.conversations` row (`state = 'open'` → wire `ACTIVE`); returns the existing conversation when the `(tenant, channel, external_thread_id)` binding already exists (`uq_conversations_tenant_thread`) | `POST` is a bind-or-create on the unique thread binding, not a duplicate-creating mutation; no `idempotency_key` field | n/a | `400 VALIDATION_FAILED`, `401 AUTHENTICATION_FAILED`, `403 CAPABILITY_NOT_ENABLED` (channel/module not enabled for the tenant) | Audit row with the resolved channel and conversation id; no evidence row (no external effect) |
| R02 | Session-bound caller holding the conversation, or an operator session that currently holds the takeover lease (R06); tenant from session | `PostMessageRequest` (§1): `message` (≤ 4000), required `idempotency_key`, optional `module` (`marketing`/`sales`/`support`/`auto`), optional `attachments` | `202 TaskAcceptedResponse`: `task_id`, `conversation_id`, `status` ∈ `accepted`/`running`/`waiting`/`awaiting_human`/`completed`/`stopped`/`failed`, `task_version`, `correlation_id` | Creates or resumes a durable run (`platform_durable_tasks`); a message while the lease is held by another operator is refused `409` (Conversation Locked by Human Operator, `07` §6.2) | Required. Identical replay of the same `idempotency_key` + byte-identical payload → cached receipt (same `task_id`), no second turn; same key + different payload → `409 IDEMPOTENCY_CONFLICT` (NFR-003, BR-005/BR-006) | n/a | `400`, `409`, `401`, `403`, `422` (policy/validation failure, e.g. `CONSENT_REQUIRED` for outreach on a non-consented subject) | Audit row per message turn; evidence row only when the run produces an external effect (later step) |
| R03 | Session-bound caller or operator with read permission; tenant from session | Path `task_id`; no body | `200 TaskStateResponse`: `task_id`, `task_version`, `status`, optional `answer`, `sources[]` (`source_record_id`, `source_version`, `source_file`), `actions[]` (`operation`, `status`, `provider_reference`), `evidence_reference`, `correlation_id` | None (read). `status` is the durable task state; `awaiting_human` means an approval is pending | n/a | n/a | `404 TASK_NOT_FOUND`, `401`, `403` | Read audit row; `evidence_reference` surfaces the `evidence_records` row when one exists |
| R04 | Signed connector/provider boundary or authenticated platform producer (`WebhookHmacAuth` `X-Signature-SHA256` + tenant binding); signature verified before any agent routing | `PlatformEventEnvelope`: `event_id`, `event_type`, `source`, `occurred_at`, `payload` | `202 EventIngestionResponse`: `event_id`, `correlation_id`, `status` ∈ `QUEUED`/`IGNORED`/`PROCESSED` | Append to `customer_events`/stream; may dispatch a signal that starts a run | Required on `event_id`: identical replay → cached receipt; same `event_id` with a different payload → `409 IDEMPOTENCY_CONFLICT` | n/a | `400`, `401` (signature/TLS failure), `409` | Audit row per delivery with signature verdict; evidence only for downstream effects |
| R05 | Operator session with decision permission for the tenant; approval must be bound to the identical `(tenant_id, run_id, effect_key)` triple (`04` §4.2) | `ApprovalDecisionRequest`: `decision` ∈ `APPROVE`/`REJECT`/`MODIFY`/`PAUSE`/`CANCEL`, `operator_id`, `reason` (mandatory; standardized code for `REJECT`), required `expected_payload_sha256`, `modified_payload` (MODIFY only) | `202 ApprovalDecisionResponse`: `approval_id`, `task_id`, `status = QUEUED`, `queued_at`, `correlation_id` | Queues one canonical `human.*` event in `state_payload.resume_event`; returns `202 QUEUED` with `queued_at`. The worker later rechecks policy/takeover/floor and atomically claims task → action → approval under a worker lease fence. The approval remains PENDING until that guarded worker claim. | Identical canonical event replay returns the queued `202` receipt; a conflicting event returns `409 APPROVAL_EVENT_CONFLICT`; an approval already decided/claimed or with mismatched binding returns `409 APPROVAL_NOT_CLAIMABLE` (exact-bound single-use semantics); no provider call occurs at queue time | n/a | `400`, `401`, `403`, `404`, `409` | Audit row records the accepted queue request; the worker claim records the decision and execution evidence |
| R06 | Operator session with takeover permission for the tenant; the conversation must belong to that tenant | `ConversationTakeoverRequest`: `operator_id`, `reason`, `takeover_mode` (`FULL_CONTROL`/`CO_PILOT`; see the enum conflict in §8.3) | `200 ConversationTakeoverResponse`: `conversation_id`, `status = HUMAN_TAKEOVER`, `operator_id`, `taken_over_at`, `lease_expires_at` | Acquires `tenant:{tid}:session:{conversation_id}:takeover_lock` and moves the conversation to the human-held state (`state='paused_takeover'` → wire `HUMAN_TAKEOVER`); a second operator receives `409` | Lease acquisition is a single-key compare-and-set (`SET NX`); the same operator re-issuing takeover renews rather than stacks a lock | n/a | `400`, `401`, `403`, `404`, `409` (lease held) | Audit row with operator, mode, and lease TTL; evidence row not required (no external effect until the operator sends) |
| R07 | Only the operator currently holding the lease; tenant from session | `ConversationTakeoverHeartbeatRequest`: `operator_id`, `extend_seconds` (1–300) | `200 ConversationTakeoverHeartbeatResponse`: `conversation_id`, `status = HUMAN_TAKEOVER`, `operator_id`, `lease_expires_at` | Extends, never creates: renews the existing lease only. Heartbeat does not send a message and does not alter message ownership | Renewal is idempotent in effect (renewing twice yields one lease with a later expiry) | n/a | `401`, `403`, `404`, `409` (lease expired or held by another operator) | Audit row per renewal with `lease_expires_at`; no evidence row |
| R08 | The lease-holding operator or an authorized supervisor; tenant from session | `ConversationResumeRequest`: `operator_id`, optional `handoff_summary`, optional `next_agent_id` | `200 ConversationResumeResponse`: `conversation_id`, `status = ACTIVE`, `resumed_at` | Owner-checked release of the lease (`state='open'` → wire `ACTIVE`) after re-validating consent, context, and pending order state (`07` §6.2) | Release is owner-checked and idempotent: a repeat when no lease is held returns the same terminal `ACTIVE` state or `409` if another operator holds it — never a double release | n/a | `400`, `401`, `403`, `404` | Audit row with handoff summary; evidence row only if the hand-back itself dispatches an external effect |

**8.1.2 Realtime, storefront, and operator-retry operations (R09–R13)**

| # | Auth & tenant binding | Request schema | Response schema | State transition | Idempotency | Pagination | Errors | Audit & evidence |
|---|---|---|---|---|---|---|---|---|
| R09 | Operator session, read-only; the stream is filtered to the session tenant | Query: `metric` (e.g. `revenue_attribution`) or `channel` (e.g. `run_updates`), optional `cursor`/`Last-Event-ID` for resume (target frame contract and event names: `07` §10) | `text/event-stream`; each frame carries `id`, `event`, `data` with a tenant-scoped payload | None (read) | Replay by cursor is idempotent: the client de-duplicates on the frame `id`; a dropped connection resumes from the last acknowledged `id` | n/a (cursor resume, not page listing) | `401`, `403`; mid-stream failures surface as a `stream.error` frame followed by reconnect guidance | Stream subscription/reconnect audit row; no evidence row |
| R10 | Operator session bound to the tenant and operator id; handshake rejects an unauthenticated or cross-tenant subscription | Commands and subscriptions over the socket (message ownership, Copilot draft delivery, lease notifications: `07` §10) | Server events (`run.updated`, `approval.pending`, `conversation.message`, `takeover.heartbeat`, …) | None directly; R10 never mutates state — control actions go through R06/R07/R08 | Commands carry an explicit command id; a replayed command is de-duplicated, never applied twice | n/a | `401`/`403` at handshake; `stream.error` event for in-band failures | Connection and command audit rows; no evidence row |
| R11 | First-party storefront widget with a browser-safe, tenant-scoped token; tenant from the token, never from the body | `PostMessageRequest` plus optional `session_id` for first-turn binding; server-side delegates to R01 + R02 | Streamed (chunked) reply text for one chat turn; identical `idempotency_key` replay returns the cached receipt instead of a second turn | Creates/binds the conversation, then starts a durable run (same as R01 + R02) | Required, delegated to R02; a repeated turn never produces two outbound messages | n/a | `400`, `401`, `409`, `422` (including `CONSENT_REQUIRED` and the fail-closed price/authority refusals) | Audit row per turn; no client-side policy/price decision is ever accepted as evidence |
| R12 | First-party widget/app origin with the same browser-safe token; tenant bound from the token | `PlatformEventEnvelope` (the same envelope as R04: `event_id`, `event_type`, `source`, `occurred_at`, `payload`) plus an optional `session_id` for anonymous binding; the stream normalizer maps it into the §3.1 stream envelope (`context`, `data`, derived `canonical_event`) before writing `customer_events` and the C360 projection | `202 EventIngestionResponse` (`QUEUED`/`IGNORED`/`PROCESSED`) | Append to `customer_events` and the C360 projection | Required on `event_id`: identical replay → cached receipt; same `event_id`, different payload → `409 IDEMPOTENCY_CONFLICT` | n/a | `400`, `401`, `409` | Audit row per event batch; no evidence row |
| R13 | Operator session with retry permission for the tenant | Path `run_id`; optional body carrying the operator id and reason | `202` `TaskAcceptedResponse` for the re-queued run, or `409` when the run is not retryable | Re-queues a **failed** run whose failure is verified side-effect-free (schema/validation failure, authority `DENY`, `FAIL_CLOSED`, pre-dispatch provider rejection) | Reuses the run's original `effect_key`, so the reservation still makes the retry at-most-once (BR-005/BR-006); retrying an already-requeued run is a no-op, not a second dispatch | n/a | `400`, `403`, `404`, `409` (UNKNOWN/indeterminate outcome → reconciliation only, never a blind retry) | Audit row with operator id and failure class; evidence row only if the retried attempt reaches an external effect |
| R18 | Authenticated operator with reconciliation permission; tenant from session | Path `run_id`; body `{ resolution: PROVIDER_CONFIRMED_SUCCEEDED | PROVIDER_CONFIRMED_ABSENT | ESCALATE_MANUALLY, receipt?, reason }` | `202` accepted resolution event | Queues one `human.reconcile` event on a `waiting` task, preserving the complete checkpoint and clearing a stale execution lease; `ESCALATE_MANUALLY` is consumed safely and remains `waiting`. The worker resolves provider-confirmed resolutions via authoritative provider proof (API-001/mock GET): confirmed success settles the reservation and replays the provider receipt without a second dispatch; confirmed absence settles FAILED, reopens the same effect key, and permits exactly one re-dispatch. Operator labels/receipts are ignored as proof; indeterminate or unavailable provider proof fails closed, retaining the event and keeping the task `waiting`. | Same run/task event is idempotent by canonical content; a different queued event conflicts | n/a | `400`, `403`, `404`, `409` | Audit row records operator, resolution and receipt presence; operator receipts are never treated as provider proof |

**8.1.3 Command Center read operations (R14–R17)**

All four are read-only, tenant-scoped projections: they never bypass RLS or operator scope, they never write business state, and each writes exactly one audit row.

| # | Auth & tenant binding | Request (query) | Response schema | Source of truth | Idempotency & pagination | Missing/partial data | Errors | Audit |
|---|---|---|---|---|---|---|---|---|
| R14 | Operator with read permission; tenant from session | `status=PENDING` (only supported filter in the baseline), optional `cursor`, `limit` | Approval queue projection: `approval_id`, `run_id`, `action_id`, `effect_key`, `payload`, `reason`, `status`, `is_paused`, `decided_by`, `decided_at`, `decision_notes`, `created_at`, plus the computed `payload_sha256` used as the decision precondition (`03` §1 DOMAIN 5 `approval_queue`; §8.2.1). Because the view is exactly the `PENDING` projection, a paused-but-undecided item appears once as `status='PENDING'` with `is_paused=TRUE` (rendered as `PAUSED`); a stored `decision='EXPIRED'` row would leave the view, but no automated expiry writes that value until an owner-approved TTL source exists — the expiry/decided rendering and its missing-data rule are defined in §8.3 C-5 | `agentos.approval_queue` view over `approvals`; there is no second queue table | Read-only; cursor pagination; oldest-first ordering | A tenant with no PENDING rows returns an empty list, never a fabricated item; an item whose `expires_at` source is not instrumented renders without a countdown (§8.3 C-5) | `400` (unsupported filter), `401`, `403` | Read audit row |
| R15 | Operator **and** a verified customer binding for the requested customer; tenant from session; a cross-tenant or unverified private lookup is refused (`04` §5 identity verdicts) | Path `customer_id`; optional `cursor`, `limit`, `from`, `to` | Timeline projection: ordered entries carrying `occurred_at`, `source_record_id`, canonical stage/event name, evidence classification (`FACT`/`SIGNAL`/`HYPOTHESIS`/`DECISION`/`ACTION`), evidence reference (`03` §8 ten-stage projection; `07` §9 `SCR-004` row) | `customer_events` + conversation/order/CRM projections rebuilt through the `03` ten-stage mapping | Read-only; cursor pagination ordered by `(occurred_at, source_record_id, event_id)`; late events are appended, not rewritten | Gaps are returned as explicit gaps (stage with no events), never as empty-success; a stage with no source returns `NO_DATA` with a reason | `400`, `401`, `403`, `404` | Read audit row; the identity verdict that authorized the read is recorded |
| R16 | Operator with read permission; tenant from session | optional `cursor`, `limit`, `agent_id`, `state`, `status`, `from`, `to` | Run list/detail projection from the durable task plus the per-step operational log: `run_id`, `state`, `task_version`, `current_step`, `retry_count`, `last_error_class`, per-step `skill`, `tool`, `authority`, `approval`, `action`, `execution_status` ∈ `pending`/`executing`/`success`/`failed`/`denied`/`aborted`, `evidence`, `outcome`, `latency_ms`, `cost`, `error`, `started_at`, `completed_at` (`platform_durable_tasks`, `agent_run_logs`). `state` returns the **stored** `task_lifecycle_state` vocabulary (`queued`/`running`/`waiting`/`awaiting_human`/`completed`/`stopped`/`failed`, `03` §1); the wire value `accepted` used by R02/R03 is the projection of stored `queued` (§8.3 C-8) | `agentos.platform_durable_tasks` + `agentos.agent_run_logs` (append-only; one terminal row per step) | Read-only; cursor pagination; filters are server-side and tenant-scoped | Unmeasured latency/cost columns render as "not measured" rather than `0`; a run whose outcome is still observing renders as pending attribution | `400`, `401`, `403` | Read audit row |
| R17 | Operator with read permission; tenant from session | optional `window` (e.g. `24h`, `30d`), `timezone` (IANA), `cursor`, `limit` | SCR-001 metric snapshot: the ten baseline indicators, each with `value`, `source_status` (`LIVE`/`STALE`/`NO_DATA`/`NOT_INSTRUMENTED`/`UNAVAILABLE`), `observed_at`, `window`, `timezone`, `provisional` flag (`07` §9 `SCR-001` row) | `07` dashboard projection over the telemetry/attribution sources; window and timezone are explicit in the response | Read-only; snapshot is idempotent for a fixed `(tenant, window, timezone, observed_at)`; cursor is for paged series, not for the snapshot itself | A metric with no upstream source returns `NOT_INSTRUMENTED`; a metric with an instrumented but empty window returns `NO_DATA` with reason; a stale value carries its `observed_at` and is labelled stale — never rendered as zero success | `400` (invalid window/timezone), `401`, `403`, `503` (`METRICS_UNAVAILABLE`, cached values remain labelled stale) | Read audit row |

### 8.2 Supplemental operations and non-baseline surfaces (counted separately)

**8.2.1 `GET /api/v1/approvals/{approval_id}` — SCR-003 approval detail read (1 supplemental operation)**

- **Why it exists:** SCR-003 MUST render the approval evidence card and MUST capture the digest of the payload the approver actually reviewed before submitting a decision. The list route R14 returns summaries; the detail read returns the single item plus `payload_sha256` and the reviewer-visible fields (`effect_key`, `reason`, `run_id`, `action_id`, `created_at`, `expires_at` when instrumented).
- **Auth/tenant:** the same operator read permission as R14; the item must belong to the session tenant (a cross-tenant read returns `404`, not a redacted success).
- **Derivation, not a new store:** `payload_sha256` is computed server-side from the canonical `approvals.payload` with the same RFC 8785 + SHA-256 rule used for `evidence_records.payload_sha256` (§1; `04` §6). No new column and no second approval store is introduced by this read.
- **Field-level authorization:** privileged payload fields and the signature context are omitted for a role whose decision list is empty (a viewer may read the item's existence and status without the privileged payload); the response for such a role is a redacted projection, never a different object type.
- **Errors:** `401`, `403`, `404`; no `409` (the read never mutates).
- **Traceability note:** this operation is evidenced by the governance specification `testcases/sources/governance.py:2426` (`viewer_read` → `GET /api/v1/approvals/APV-CAMP-15`). It is **outside the 18** so that the baseline count stays exactly as published; it is not an alias of R14 and it does not replace it.

**8.2.2 Inbound provider webhooks (optional, ASM-001, 0 baseline gateway paths)**

§4.1 templates the **verification scheme and payload extract** for each channel (LINE `X-Line-Signature`, Meta `X-Hub-Signature-256`, TikTok, Zalo, Email, SMS, Web Chat JWT+origin), but this specification deliberately templates **no per-provider gateway path**. Provider deliveries therefore have exactly two target ingress shapes:

1. **Platform event ingress (R04)** — the provider or a tenant-side relay posts the provider payload as a `PlatformEventEnvelope` with an HMAC signature; canonical derivation and deduplication are those of §3.0.
2. **Channel adapter ingress** — when a provider mandates a dedicated callback URL, the path is `[OPTIONAL-EXTENSION][UNCONFIRMED][ASM-001]` and MUST be enumerated only after the ASM-001 connector audit locks the provider list, its API surface, and its callback requirements.

R04 is already counted once within the 18 baseline operations; using it for provider delivery adds no route. Dedicated per-provider callback paths are outside that count and may be specified only after ASM-001 closes. Signature verification (§4.2), consent, quota, and receipt handling are mandatory on both ingress shapes.

**8.2.3 Browser/OAuth callback surfaces owned by `01`**

`01`'s configuration catalog defines `LINE_LOGIN_CALLBACK_URL` (`/api/v1/auth/line/callback`) and `CVS_EMAP_CALLBACK_URL` (`/api/v1/shipping/cvs/callback`) as local placeholder values. They are browser redirect/OAuth-return surfaces owned by `01` and are **not** JSON gateway operations; `06` does not define their payloads, and their production hostnames remain `[UNCONFIRMED][ASM-001]`.

### 8.3 Route and wire-shape conflicts, aliases, and propagation

These items are **known divergences between layers**, recorded here rather than silently resolved. Per the authority order in `README.md` §5, this implementation contract governs until the owning layer is updated and regenerated; `README.md` §9 carries the pack-level propagation register.

| # | Conflict | Evidence | Owner / resolution path | Interim rule (what implementation does today) |
|---|---|---|---|---|
| C-1 | Testcase sources use alternative spellings for three Command Center reads: `/api/v1/telemetry/executive` (vs R17), `/api/v1/agents/operations` (vs R16), `/api/v1/customers/{customer_id}/360` (vs R15) | `testcases/sources/governance.py:1588`, `:1622`, `:1651`, `:1682`; `:1714`; `:1970`, `:2030-2032` | Owner: testcase source owner. `README.md` §9 states testcases are downstream propagation targets, never route authority: update the source module and regenerate; never hand-edit generated output | R15–R17 spellings are authoritative in this pack; the fixture spellings MUST NOT be implemented as parallel aliases. The other fixture hits — `POST /api/v1/approvals/{id}/execute` and `PATCH /api/v1/tasks/{id}` (`governance.py:2553-2555`) — are **intentional must-reject negatives**, not routes to add: `/execute` and task-state editing do not exist (§1) |
| C-2 | `takeover_mode` wire value: the governance specification sends `HUMAN_ACTIVE`; OpenAPI §1 declares `FULL_CONTROL`/`CO_PILOT`, and `07`'s hook sends `FULL_CONTROL` verbatim | §1 `ConversationTakeoverRequest`; `testcases/sources/governance.py:2063`; `07` §6.4 hook | Owner: testcase source owner (propagation debt, same class as C-1) | The enum stays `FULL_CONTROL`/`CO_PILOT`; the console may *display* the human-held mode as "HUMAN_ACTIVE" wording, but no `HUMAN_ACTIVE` value is accepted on the wire (unknown values are rejected `400`) |
| C-3 | Conversation status vocabulary — resolved as a deliberate projection: wire `ACTIVE`/`HUMAN_TAKEOVER`/`CLOSED` (§1) vs stored `conversations.state` `'open'`/`'paused_takeover'`/`'closed'` (`03` §1 Entity 11) | §1 `ConversationSessionResponse`; `03` §1 Entity 11 and §9.1 wire projections; the governance fixture asserts the wire value (`testcases/sources/governance.py:2067`) | Resolved: `03` (persistence) with `06` (wire) — the stored↔wire mapping is the documented projection in `03` §9.1, not an open conflict | The wire enum stays authoritative for the API, the UI, and the fixtures; implementation MUST map (`ACTIVE` ↔ `open`, `HUMAN_TAKEOVER` ↔ `paused_takeover`, `CLOSED` ↔ `closed`) and MUST NOT store the wire value verbatim. The projection adds no stored enum values |
| C-4 | Takeover lease TTL — resolved: the wire contract and `03`'s Redis key registry agree on the bounded, renewable takeover lease | `03` §3 key registry (60 s TTL, renewed every 30 s, `extend_seconds` 1–300); §1 heartbeat schema; `07` §6.2 | Resolved: `03` key registry with `06`/`07` wire | The takeover lease is **60 s, renewed every 30 s**, with `extend_seconds` 1–300. The `TTL/3` renewal rule applies only to the durable-task worker lease `tenant:{tid}:task:{run_id}:lease` (`03` §3), never to the takeover lease; the takeover renewal cadence is a console/config default, not an authorization |
| C-5 | Approval expiry, pause vocabulary, and queue-first decision contract: the `approval_queue` view exposes no `expires_at` column, `approvals.decision` allows stored value `EXPIRED` with no owner-approved TTL source, Pause keeps `decision='PENDING'` with `is_paused=TRUE`, and R05 returns queue-first `202 QUEUED` rather than synchronous decision states | `03` §1 DOMAIN 5 and §1 Entity 24; §1 `ApprovalDecisionResponse`; `testcases/sources/governance.py` GOV-APV-EXPIRY fixture; `04` §4.2 | Owner: `03`/Product (owner-approved TTL policy and `expires_at` source) with `04`/`06` — queue-first wire contract aligned | **Queue-first wire alignment (fixed):** R05 returns HTTP `202 ApprovalDecisionResponse` (`{ approval_id, task_id, status: 'QUEUED', queued_at, correlation_id }`) for every valid decision (`APPROVE`, `MODIFY`, `REJECT`, `PAUSE`, `CANCEL`), queueing exactly one durable `state_payload.resume_event` onto the task. It never commits synchronous decision states (`APPROVED`, `PAUSED`, etc.) directly. Identical canonical replays return `202 QUEUED` with the cached receipt; conflicting decision events return `409` (`APPROVAL_EVENT_CONFLICT` / `IDEMPOTENCY_CONFLICT`); an approval already decided/claimed or whose exact `(tenant_id, run_id, effect_key)` binding does not match updates zero rows and returns `409 APPROVAL_NOT_CLAIMABLE` (exact-bound single-use semantics). **Read mapping (R14 over `approval_queue` view):** `decision='PENDING'` + `is_paused=FALSE` renders as undecided `AWAITING_HUMAN` / `PENDING`; `decision='PENDING'` + `is_paused=TRUE` renders as `PAUSED`; a decided row leaves the queue view. `EXPIRED` remains a stored vocabulary value, but nothing writes it automatically: no owner-approved TTL source is instrumented and no hardcoded interval may be applied. The console renders no countdown and no 'expired' verdict until an owner-approved TTL source exists, and never infers expiry from an unverified clock. |
| C-6 | Route prefix wording: `plans/` uses `/v1` | `README.md` §9 propagation register | Owner: plan owner | `/api/v1` is the single implementation prefix; no second route is created |
| C-7 | Stored event vocabulary — resolved: `customer_events.event_name` holds the canonical event (the SRS §15 API-002 seven baseline events, or the `ext.<domain>.<name>` extension form); the original granular `event_type` and alias version are retained in `payload` | `03` §1 Entity 4; §3.0; SRS §15 API-002 | Resolved: `03` (column semantics) with `06` (wire vocabulary) | **Mapping (canonical):** `customer_events.event_name` stores the canonical event — one of the seven baseline names, or `ext.<domain>.<name>` when `canonical_event` is null — while the original granular `event_type` and the alias-table version are retained in `payload`; `source_event_id` is the dedupe key. The versioned alias table in §3.0 remains the only mapping authority |
| C-8 | Initial durable-state naming: `03`'s `task_lifecycle_state` has `queued` and no `accepted`, while §1's `TaskAcceptedResponse`/`TaskStateResponse` return `accepted` | `03` §1 and §9.1 wire projections; §1 schemas; `04` §4.2 writes storage values directly | Owner: `03` with `06`/`04` | One projection, stated once: wire `accepted` ↔ stored `queued`; all other values are identical (`running`, `waiting`, `awaiting_human`, `completed`, `stopped`, `failed`). R16 returns the stored vocabulary (§8.1.3); R02/R03 return the wire vocabulary. No third spelling is introduced |

### 8.4 Price-floor guardrail at the connector boundary `[OWNER-DECISION-REQUIRED]`

The connector boundary is where a price-bearing proposal would acquire its numbers, so the floor rule is stated here explicitly (owner sections: `README.md` §8.1, `08` §7.3):

- **Hard rule.** No price-bearing dispatch may leave the adapter boundary without an **owner-approved, provenance-bearing floor decision**. A price/quote response that lacks the floor decision, its approving owner, or its provenance fails closed with the `08` §8 BR-001 code; the connector never derives, rounds, or infers a floor locally, and no numeric default may be invented (`NFR-008`, BR-001, BR-003).
- **Candidate fields, not a canonical contract.** `PriceLookupResponseDTO` (§2) currently carries `mathematical_floor_price`, `floor_price_source`, and `floor_price_synced_at`. Those names are candidates: the authoritative-provenance model (ERP/policy service supplies `floor_price` + provenance; the platform validates presence, freshness, tenant binding, and signature) and the platform-derived model (the platform computes the floor from owner-approved policy inputs) remain **competing proposals**.
- **Unresolved dimensions.** Ownership, formula/margin mode, rounding, currency, staleness window, and provenance format are `[OWNER-DECISION-REQUIRED]` between the Solution Architect and Business/Finance (`README.md` §8.1). The local calculations referenced at `implement/04:409-410`, `03:178-182`, `08:736-739`, and `plans/delivery/analytics.md:207` are competing candidates, not a canonical formula, and this document does not select one.
- **Capability vs safety.** A tenant disabling the discount/subsidy capability simply does not use that optional action class; it does **not** allow a price-bearing proposal that uses the capability to bypass the floor decision. The phrase "`P_floor` if enabled" MUST NOT appear without this distinction.
- **Approval is not a policy bypass.** An approval authorizes exactly one action bound to `(tenant_id, run_id, effect_key)` and never raises authority. An invalid agent grant is rejected **before** any AUTH-4 queue item is created, and the prerequisites this section names — floor provenance, authoritative source availability, consent, verified identity — cannot be approved away by an operator decision: an `AUTH-4` approval releases a compliant action, it never manufactures compliance. A `PAUSE` keeps the approval `PENDING` and releases nothing.

## 9. API-001, API-002, and API-003 Boundary Rules `[SRS-MUST][SRS §15 / API-001..003]`

The three connectors share one boundary discipline: **the platform reads through permissions and writes through controlled actions.** No component of the AI platform talks to a system of record's database, and a provider's word is never replaced by an assumption.

### 9.1 API-001 (ERP/POS) — read scope, mutation scope, and source-of-record ownership

| Rule | Target behaviour | Failure / error | Evidence obligation |
|---|---|---|---|
| Distinct read and mutation permissions | Every read entity in SRS API-001 (`product`, `SKU`, `price`, `inventory`, `customer`, `order`, `invoice`, `sales history`) is individually permissioned per tenant and per caller role; a role that may not read `customer` cannot obtain it through a different route | `403` (authority/permission), never a silently redacted numeric field | Read audit row naming the permission that authorized the call |
| Mutations only through controlled actions | Writes are limited to the controlled action set (draft order, reservation, invoice issuance, refund/compensation requests); each mutation carries an `effect_key` and is reserved before dispatch (`04` §4.4) | `403`/`422`; an unregistered mutation is a hard failure, never a local fallback | Evidence row with the provider receipt; no receipt ⇒ no success claim |
| System of record for price, inventory, order, receipt | ERP/Commerce remains the authority for price, inventory, order state, and receipts (SRS §2.1). The platform mirrors values with provenance and freshness and never recomputes them (BR-001, BR-003) | Missing/stale/unprovenanced values → fail closed (`AUTHORITATIVE_SOURCE_UNAVAILABLE`, `P_FLOOR_UNAVAILABLE` in `08` §8) | Mirror rows carry source id/version and sync time; the evidence row references the provider response |
| Floor provenance at the boundary | A price-bearing response is usable only with the owner-approved, provenance-bearing floor decision of §8.4 | Refusal is the documented outcome; no numeric default and no local formula may substitute | The refusal itself is audited (BR-010) so a fail-closed path is visible, not silent |
| Private customer data is identity-gated | Customer profile and sales-history reads require the tenant's permission **and** a trusted identity context (`04` §5 verdicts); a payload-asserted phone/email/tax id never resolves a customer | `403`, or an empty/`UNRESOLVED`-safe answer; a cross-tenant id returns `404` | The identity verdict that authorized the read is audited |
| Provider outcomes are preserved verbatim | Success, provider rejection, and indeterminate outcomes are stored distinctly; an indeterminate outcome is never normalized into success or a provable no-op | `UNKNOWN` parks the task in `waiting` and reconciles by `effect_key` (`04` §4.4) — never a blind retry | The reservation row plus the provider body/HTTP status are retained as evidence |
| No direct database access | The AI layer reaches API-001 only through the adapter port (package boundaries and forbidden imports in `02` §5); no skill, agent, or orchestrator component opens an ERP database connection | A direct-connection attempt is a build/lint boundary violation, not a runtime fallback | Package-ownership check in `02` §5; no runtime evidence required for a static rule |

### 9.2 API-002 (Web/App events) — canonical baseline, extensions, and stream semantics

| Rule | Target behaviour | Failure / error | Evidence obligation |
|---|---|---|---|
| Exactly seven baseline canonical events | `session`, `product_view`, `search`, `click`, `add_to_cart`, `checkout`, `purchase` (SRS §15 API-002) are the canonical set; every accepted web/app event carries the derived `canonical_event` | An event whose `event_type` has no baseline parent is accepted as extension telemetry with `canonical_event: null`, never re-labelled into a baseline event | Ingestion audit row with the derived canonical value |
| Extensions stay extensions | `cart.remove` remains an analytics-only extension and is never a purchase or abandonment trigger by itself; delivery, support, review, and repurchase evidence reach the ten-stage timeline through their own source records and the `03` §8 projection mapping — they are **not** forced into the seven canonical names | A skill that requires a baseline event refuses when only an extension event exists; it does not infer one | The skill's own evidence row records which source record was used |
| Deterministic alias mapping | The alias table in §3.0 is versioned: a granular alias may never be silently re-pointed at a different canonical event | A mapping change is a version bump plus a migration note, never a hot edit | Alias version recorded in the stored `payload` and with the ingestion audit row |
| Deduplication | `event_id` plus the canonical payload is the deduplication key: identical replay returns the cached receipt; the same `event_id` with a different payload is `409 IDEMPOTENCY_CONFLICT` | Never a double-counted conversion, never a silent overwrite | Cached receipt reference in the audit row |
| Ordering and late events | Ordering is `(occurred_at, source_record_id, event_id)`; late events are retained and re-projected, and a late `purchase` still attributes to its original run | Out-of-order arrival changes no stored ordering key and never rewrites history | Projection rebuild is idempotent; a replay produces no duplicate projection row |
| Replay safety | Replaying a window of events (connector retry, backfill) is idempotent end to end: the C360 projection and any triggered run are both deduplicated | A replay that would re-trigger a run is refused by the same `event_id`/`effect_key` rules | Replay audit row plus the unchanged projection row identity |
| Events carry no authority | An event payload can never raise authority, consent, price, or policy (`BR-008`, `BR-009`); `context.consent_granted` is context, not a consent record | A skill that needs consent reads the consent store, not the event | Consent version cited in the skill's evidence row |

### 9.3 API-003 (Communications) — baseline channels, inbound, outbound, and mutex

| Rule | Target behaviour | Failure / error | Evidence obligation |
|---|---|---|---|
| Six baseline channels | Facebook (Messenger), TikTok, Zalo, Email, SMS, Web/App Chat are first-class (SRS §15 API-003); `channel` values and adapter bindings are per §4.0 | An unconfigured channel is `403 CAPABILITY_NOT_ENABLED`, never a silent route to another channel | Channel/connector id recorded on the conversation and the evidence row |
| Inbound verification before agents | Every inbound delivery is verified for tenant binding, TLS, provider signature, replay window, and schema before any agent or skill sees it (§4.2) | `401` on signature/TLS failure or a signature timestamp outside the freshness/replay window; an identical replay returns the cached acknowledgement and is never a `409`; the same `event_id`/delivery id with a different payload is `409 IDEMPOTENCY_CONFLICT`; agents are never invoked before verification completes | Audit row with the signature verdict and the provider message id |
| Outbound consent and suppression | Marketing-class outbound requires a valid, current consent record (BR-004); opt-outs and suppression lists are checked immediately before send; transactional replies follow the channel's own window and template rules | `422 CONSENT_REQUIRED` (marketing) / suppression short-circuit recorded as suppressed, not failed | Consent/suppression version referenced in the evidence row alongside the provider receipt |
| One responder per conversation | The session mutex (`tenant:{tid}:session:{sid}:mutex`) admits exactly one responder; a human lease (R06) suppresses agent outbound entirely | `409` for a contended dispatch; the losing writer never sends | The mutex/lease holder is recorded on the dispatch audit row |
| Provider receipts | Outbound message ids, delivery acknowledgements, and provider errors are stored as received; a missing receipt is never recorded as delivered | Indeterminate send → `UNKNOWN`, parked and reconciled by `effect_key` | Evidence row carries the provider message id or the truthful failure |
| Quota and rate limits | Per-channel quota is checked before a proactive/broadcast send; quota exhaustion blocks the proactive class and falls back only to contract-permitted paths (e.g. a free reply window) | Quota refusal is a suppressed/blocked outcome with an alert, not a retried storm | Quota state and the refusal reason are audited; the LINE 80 %/100 % guard (§5.1.2) is an `[OPTIONAL-EXTENSION]` example of this rule |
| Provider unavailable | An unavailable or unconfigured provider fails closed: the action is refused or parked for reconciliation; the platform never silently substitutes a different channel or an unverified address | `503`/reconciliation path, with the reason surfaced to the operator | The outage is audited and appears as an abnormal event in `07` SCR-001 |
| Extension channels are gated | LINE, WhatsApp, Instagram, payment rails, and the Taiwan/Global adapters are `[OPTIONAL-EXTENSION][UNCONFIRMED][ASM-001]`; each is individually enable-able and individually disable-able per tenant | A disabled adapter refuses with `CAPABILITY_NOT_ENABLED` and holds no queued work | Adapter enablement state is part of the tenant configuration audit record |

## 10. Adapter Boundary, Dependencies, Rollout, and Verification Scenarios `[BLUEPRINT][SRS §15, §19 / NFR-003, NFR-008]`

### 10.1 Interface versus provider

Adapter **interfaces** are canonical and owned by this document; provider **names** (SAP, Oracle NetSuite, 91APP, SHOPLINE, Cyberbiz, Meta, TikTok, Zalo, SendGrid, Mailgun, Twilio, LINE, WhatsApp, ECPay, NewebPay) are candidates that remain `[UNCONFIRMED][ASM-001]`. Every adapter, mandatory or optional, MUST verify in this order before dispatch: tenant binding → transport (TLS/signature) → schema → authority/verdict → business rules (consent, floor provenance, inventory) → idempotency reservation → dispatch. A provider timeout after dispatch becomes `UNKNOWN` and reconciles by `effect_key`; optional adapters (`ADPT-TW`, `ADPT-GL`) that are unavailable, unconfigured, or disabled fail closed and hold no queued work.

### 10.2 Dependencies and rollout prerequisites

| Dependency | Needed for | Status today |
|---|---|---|
| Canonical contracts (`04` orchestrator types, `05` skill registry, `03` persistence) | Every route in §8 — request/response shapes are derived from these owners | Specification only |
| PEP and authority verdicts (`08`) | R05–R08, R13 and every skill dispatch | Specification only |
| Identity resolution (`04` §5) | R15 and every customer-scoped read/write | Specification only |
| RLS and tenant context (`03` §2) | Every route's tenant binding | Specification only |
| Redis mutex/lease registry (`03` §3) | R06–R08 | Specification only; takeover lease TTL resolved in `03` §3 (60 s TTL, renewed every 30 s) |
| Provider account audit | Any inbound/outbound channel beyond the mock | `[UNCONFIRMED][ASM-001]` |
| Gate P0 build | Anything in §8 | Not started |

Rollout order for the connector layer mirrors the gates: P0 (contracts, connector framework, mock adapters) → P1 (one real Care channel end to end) → P2 (real `AI action → order → revenue` via the SoR) → P3 (one human-approved marketing channel with attribution evidence). Until a gate's real evidence exists, no route in §8 may be described as production behaviour.

### 10.3 Verification scenarios

All of the following are `[NOT-RUNTIME-EVIDENCE]` until executed against a built gateway; the pass criteria define target behaviour, not an observed result. `TC-CON-*` identifiers refer to the matrix in §7.

| # | Scenario | Expected assertion |
|---|---|---|
| V-01 | Malformed or unsigned inbound webhook (R04, R12, §4.2) | `401` before any agent routing; nothing is queued; audit row records the verdict (`TC-CON-004`) |
| V-02 | Replayed event with identical payload, then with a mutated payload (R04, R12) | Identical replay returns the cached receipt and one projection row; mutated payload returns `409 IDEMPOTENCY_CONFLICT` |
| V-03 | Tenant mismatch on a read and on a decision (R14, R15, R05) | Cross-tenant read/write is refused; the decision attempt does not mutate the foreign item |
| V-04 | Duplicate `idempotency_key` with a changed payload (R02, R11) | `409`; no second outbound turn; the original receipt is unchanged (`TC-CON-011`) |
| V-05 | API-001 read outside permission, then a mutation outside the controlled action set | `403` in both cases; no partial data and no local fallback write |
| V-06 | API-002 canonical mapping: each granular alias, plus an extension event | Each alias yields its documented canonical value; `canonical_event: null` for extensions; no extension is coerced into a baseline event |
| V-07 | Late event replay and full-window replay (R12) | Late events land in order by `(occurred_at, source_record_id, event_id)`; replay creates no duplicate projection row and no duplicate run |
| V-08 | API-003 opt-out suppression and missing-consent marketing send | Suppression recorded as suppressed; marketing send refused `422 CONSENT_REQUIRED`; no provider call |
| V-09 | Provider timeout after dispatch (outbound message, order mutation) | Task parks in `waiting`, reservation stays open, reconciliation by `effect_key`; nothing is recorded as delivered |
| V-10 | Disabled/absent optional adapter (LINE, WhatsApp, Taiwan/Global) | `403 CAPABILITY_NOT_ENABLED`; no substitute channel and no queued work |
| V-11 | Approval durability: queue replay/conflict, stale digest, wrong operator, MODIFY revalidation, AUTH-5 case (R05) | The first decision queues one event; an identical replay does not write again; a different event returns `409`; the worker claim rechecks lease/binding/digest/policy, applies MODIFY atomically with a new revision, and an `AUTH-5` verdict never creates a queue item (`TC-CON-009`) |
| V-12 | Takeover race, heartbeat, crash, resume (R06–R08) | Exactly one lease holder; heartbeat extends only the holder's lease; a crashed console's lease expires and the agent resumes; resume is the only explicit release path — lease expiry also returns control to the agent (`TC-CON-012`) |
| V-13 | Retry a `FAIL_CLOSED`/`DENY` failure, then a `UNKNOWN` run (R13) | The first re-queues under the same `effect_key`; the second is refused `409` and routed to reconciliation |
| V-14 | Command Center reads with an empty tenant and with a partial source (R14–R17) | Explicit empty/`NO_DATA`/`NOT_INSTRUMENTED`/stale labels with reasons; never a fabricated zero or a fabricated approval |
| V-15 | SSE drop mid-stream with a `Last-Event-ID`/`cursor` resume (R09) | The client resumes from the cursor, duplicates are dropped by frame id, and no frame is replayed as a new business event |

### 10.4 Route acceptance boundary and compatibility rules `[BLUEPRINT][SRS §15, §18, §19 / NFR-003, NFR-006, NFR-008]`

The 18 baseline operations are the complete counted gateway surface. Eleven drive state — R01, R02, R04–R08, R11–R13, and R18 (conversation/task/event creation, approval, takeover control, retries, and reconciliation) — and seven are reads or streams: R03 (durable task read), R09–R10 (read-model streams), and R14–R17 (the four Command Center projections). The supplemental approval detail read and any provider callback are separate surfaces with their own owner and count; neither may be introduced as an alias for a baseline route. Every route binds tenant identity from the authenticated session before loading private data, applies the route's operator or customer permission, and writes the audit record before returning a claimed success.

Compatibility is projection-only, never a second business contract. `accepted` is the R02/R03 wire acknowledgement for stored `queued`; stored task states otherwise pass through unchanged. Conversation wire states map to the `03` persistence states, and `PAUSED` is rendered from a PENDING approval with `is_paused = TRUE`, not from a new stored approval decision value. On idempotency-keyed ingestion and effect routes, an identical replay returns the original receipt; a changed payload under the same key returns `409 IDEMPOTENCY_CONFLICT`. R05 queues one canonical decision event and returns `QUEUED`; the worker claim later applies APPROVED/MODIFIED/REJECTED/PAUSE/CANCELLED semantics after its guards. R18 queues `human.reconcile`; manual escalation is consumed into `waiting`, while provider-confirmed outcomes are verified against the authoritative provider boundary (bound via API-001 / mock GET: confirmed success settles and replays; confirmed absence settles FAILED and reopens the same effect key for re-dispatch).

The route layer never derives price floors, grants authority, manufactures consent or identity, retries an indeterminate effect, or treats a client-provided tenant/customer/operator assertion as proof. R05 and R18 have runtime-backed queue boundaries with worker-side lease and version fencing; provider proof is bound for API-001 / mock GET reconciliation; optional adapters, real external ERP connections, and live database pilot verification retain truthful `NO_DATA`/`UNAVAILABLE`/fail-closed behavior until their owning boundaries exist.

Gate P1 remains open until live PostgreSQL/RLS, DB-backed Care pilots, Docker services, approved knowledge corpus, and real System-of-Record (SoR) evidence exist. Offline test harnesses verify local code paths only and do not close the gate.
