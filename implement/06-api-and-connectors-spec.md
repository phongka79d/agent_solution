# API, Connectors, and Adapters Specification

Status: Target Blueprint Specification (Gate P0) — **not an implemented system**
System Component: API Gateway, Core Connectors (API-001..003), and Adapters (ADPT-TW-001, ADPT-GL-001..003)
Document Version: 1.0.0
Target Directory: `implement/06-api-and-connectors-spec.md`

> **BLUEPRINT STATUS — Gate P0 target design, not an inventory of existing files.**
> The OpenAPI document, DTOs, webhook handlers, retry logic, and adapter classes below are **target
> contracts for the Gate P0 (Foundation) build** (SRS AI-REV-SRS-001 §24). No gateway, endpoint, connector,
> or adapter currently exists in this repository, and no request below can be served today. Paths, payloads,
> field names, and status codes are design proposals. Numeric latency, throughput, and cost figures are
> **provisional design targets pending ASM-002 and the NFR-009 benchmark**, and connector/provider
> availability remains **[UNCONFIRMED][ASM-001]**.

---

## 1. OpenAPI 3.1 Specification for Core REST APIs

The target platform exposes four foundational REST endpoints governed by strict tenant isolation, cryptographic idempotency, and asynchronous durable task execution.

**Idempotency contract (NFR-003, BR-005, BR-006) — applies to every mutating endpoint that carries an idempotency key (`idempotency_key`) or execution key (`effect_key`):**

1. **First delivery** — the effect is executed once; its receipt (`task_id` / `provider_reference` / execution record) is cached under `(tenant_id, effect_key)`.
2. **Identical replay** — a repeated request whose canonical payload is byte-identical returns the **cached receipt** with the original identifiers and status. The external effect is **not** executed a second time and the response is not an error.
3. **Payload mismatch** — the same key presented with a *different* canonical payload returns **HTTP 409 `IDEMPOTENCY_CONFLICT`**. A 409 is never returned for an identical replay.
4. Concurrent in-flight duplicates wait on the same key lock and then receive the cached receipt.

**Path convention.** The Core Engine Gateway serves every route under the base path **`/api/v1`**. Relative paths used throughout this specification (`/conversations`, `/approvals/{id}/decision`, …) are therefore absolute as `/api/v1/conversations`, `/api/v1/approvals/{id}/decision`. The Command Center UI and the Storefront Widget call exactly these absolute paths — there is no unprefixed or `/v1`-only variant.

**SCR-003 approval routing.** The single authoritative approval endpoint is `POST /api/v1/approvals/{id}/decision`. It accepts the five baseline SCR-003 actions — `APPROVE`, `REJECT`, `MODIFY`, `PAUSE`, `CANCEL` — and is the route the Command Center UI calls (see `07-human-command-center-ui.md` §4.3). There is no separate `/execute` route.

**SCR-005 conversation control routing.** The authoritative routes are `POST /api/v1/conversations/{id}/takeover` (operator takes over, per SCR-005), `POST /api/v1/conversations/{id}/takeover/heartbeat` (renews the operator lease while the takeover is active), and `POST /api/v1/conversations/{id}/resume` (operator returns the conversation to the agent, per SCR-005 "trả lại Agent"; this is also the only release path for the lease). Session identity is the `conversation_id`; there is no parallel `/sessions/{id}` resource and no separate DELETE/release route.

### 1.1. Gateway route registry (blueprint — none of these routes exists today)

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
        The single approval route used by the SCR-003 Approval Center. decision=APPROVE releases the signed
        payload for execution; REJECT terminates the task; MODIFY replaces the payload and re-validates it
        before approval; PAUSE freezes the workflow without aborting it; CANCEL irrevocably aborts the run and
        releases held reservations. PAUSE and CANCEL are first-class decisions, not task-state edits.
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
        '200':
          description: Decision accepted and orchestrated task resumed (APPROVED/MODIFIED), frozen (PAUSED), or terminated (REJECTED/CANCELLED)
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
      required: [decision, operator_id, reason]
      properties:
        decision:
          type: string
          description: >-
            Baseline SCR-003 action set. APPROVE signs and releases the payload; REJECT terminates the task;
            MODIFY replaces the payload (see modified_payload) and re-validates it before approval; PAUSE
            freezes the durable workflow without aborting it; CANCEL irrevocably aborts the run and releases
            held reservations.
          enum: [APPROVE, REJECT, MODIFY, PAUSE, CANCEL]
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
      required: [approval_id, task_id, status, decided_at, correlation_id]
      properties:
        approval_id:
          type: string
        task_id:
          type: string
        status:
          type: string
          description: >-
            APPROVED / MODIFIED release the task back to execution; PAUSED holds the task in a durable paused
            state; REJECTED / CANCELLED terminate it.
          enum: [APPROVED, REJECTED, MODIFIED, PAUSED, CANCELLED]
        decided_at:
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

API-001 represents the authoritative System of Record connection. It guarantees read/write integrity with existing client systems (SAP, Oracle NetSuite, 91APP, SHOPLINE, Cyberbiz) — these vendor names are illustrative **provider choices that remain [UNCONFIRMED][ASM-001]** until the production connector audit closes.

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
  readonly final_unit_price: number;
  readonly mathematical_floor_price: number; // P_floor boundary (BR-001, BR-002)
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

Events whose `event_type` has no canonical parent are marked `canonical_event: null` and treated as extension telemetry. The mapping is deterministic and versioned; a granular alias may never be silently re-pointed at a different canonical event.

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

#### 5.2.2. ADPT-GL-002: Multi-Currency Gateway with Time-Locked FX Buffer

When transacting cross-border in multi-currency (USD, EUR, JPY, GBP, TWD), real-time FX fluctuations could erode operating margins and breach the mathematical floor price $P_{floor}$. ADPT-GL-002 enforces a 15–30 minute Time-Locked FX Snapshot combined with a mandatory $1.5\% \text{ to } 2.0\%$ FX Safety Buffer.

##### Mathematical Safeguard Formulation
- Let $P_{base}$ be the unit price in the tenant's domestic ledger base currency (e.g., TWD).
- Let $P_{floor}$ be the non-negotiable floor price boundary in base currency (`BR-001`, `BR-002`).
- Let $R_{spot}$ be the spot exchange rate defined as domestic base currency per 1 unit of target foreign currency ($\frac{\text{Base}}{\text{Foreign}}$, e.g., $32.0\text{ TWD / USD}$).
- Let $B$ be the FX volatility safety buffer fraction ($B \in [0.015, 0.020]$, default $0.0175$).
- The guaranteed rate protecting the seller against foreign currency depreciation is:
  $$R_{guaranteed} = R_{spot} \times (1 - B)$$
- The foreign currency price quoted to the buyer is calculated as:
  $$P_{foreign} = \frac{P_{base}}{R_{guaranteed}} = \frac{P_{base}}{R_{spot} \times (1 - B)}$$
- **Floor Invariant Proof**: When the customer pays $P_{foreign}$, the minimum base currency yield received upon settlement at rate $R_{settlement} \ge R_{guaranteed}$ satisfies:
  $$\text{ConvertedBase} = P_{foreign} \times R_{settlement} \ge P_{foreign} \times R_{guaranteed} = \left(\frac{P_{base}}{R_{guaranteed}}\right) \times R_{guaranteed} = P_{base} \ge P_{floor}$$
  This guarantees that margin erosion never breaches $P_{floor}$ for adverse currency slippage up to $B \times 100\%$.

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
  readonly buffer_percent: number; // e.g., 0.0175 (1.75%)
  readonly guaranteed_rate: number; // spot_rate * (1 - buffer_percent)
  readonly expires_at: number; // Timestamp ms
}

export class FXSafeguardEngine {
  private static readonly QUOTE_TTL_MS = 20 * 60 * 1000; // 20 minutes lock
  private static readonly DEFAULT_BUFFER = 0.0175; // 1.75% safety buffer

  /**
   * Generates a time-locked FX quote with safety margin.
   */
  public static createLockedQuote(
    baseCurrency: string,
    targetCurrency: string,
    liveSpotRate: number
  ): TimeLockedFXQuote {
    const quote_id = `fx_${crypto.randomUUID()}`;
    const guaranteed_rate = liveSpotRate * (1 - this.DEFAULT_BUFFER);

    return {
      quote_id,
      base_currency: baseCurrency,
      target_currency: targetCurrency,
      spot_rate: liveSpotRate,
      buffer_percent: this.DEFAULT_BUFFER,
      guaranteed_rate: Number(guaranteed_rate.toFixed(6)),
      expires_at: Date.now() + this.QUOTE_TTL_MS,
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
        `FLOOR_PRICE_BREACH: Converted amount ${convertedBaseAmount.toFixed(2)} ${lockedQuote.base_currency} < P_floor ${baseFloorPrice} ${lockedQuote.base_currency}`
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
| `TC-CON-009` | Core Gateway | Operator submits each SCR-003 decision via `/api/v1/approvals/{id}/decision`. | `APPROVE`/`MODIFY` return `200` and resume the task; `PAUSE` returns `200` with `PAUSED`; `REJECT`/`CANCEL` return `200` with `REJECTED`/`CANCELLED`; no other approval route exists. |
| `TC-CON-010` | DOM Connectors | Evaluate FMCG customer with $> 20\%$ CVS non-pickup rate (DOM-FMCG-003). | `allow_cvs_cod` returns `false`, forces `REQUIRE_PREPAYMENT` action. |
| `TC-CON-011` | Core Gateway | Replay the same `idempotency_key`/`effect_key`: (a) byte-identical payload, (b) mutated payload. | (a) returns the cached receipt with the original `task_id` and executes no second external effect; (b) returns `409 IDEMPOTENCY_CONFLICT`. |
| `TC-CON-012` | SCR-005 Control | Operator takes over, heartbeats, then resumes the conversation. | Takeover locks AI outbound replies; heartbeat extends `lease_expires_at`; resume returns status `ACTIVE` (agent control) and releases the lease. |
