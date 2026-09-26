/**
 * @file Durable bindings for the gateway and engine ports (implement/04 §3.2.3, `06` §8).
 *
 * Each port the routes declare is bound here to a repository that already owns the table, so no
 * layer re-implements policy, idempotency or schema that a foundation package owns. Two rules hold
 * throughout:
 *
 * - **Tenant first.** Every binding passes `tenant_id` from the authenticated principal into a
 *   tenant-scoped repository call, and the repository's RLS context is what isolates the row. No
 *   binding filters rows in memory after a cross-tenant read.
 * - **No synthetic values.** A binding maps stored values onto the wire shape; it never invents a
 *   missing one. Where a source is absent, the port answers with the contract's own empty or
 *   not-instrumented vocabulary rather than a plausible default (`06` §8.1.3).
 */

import { createHmac, randomUUID } from 'node:crypto';

import {
  canonicalizeJson,
  computeEffectKey,
  computeRequestFingerprint,
  EFFECT_RESERVATION_TTL_MS,
} from '@agentos/core-engine';
import type { IEffectGuard, ReservationOutcome } from '@agentos/core-engine/contracts';
import {
  acquireSessionTakeover,
  admitCareTurn,
  CONVERSATION_TURN_SKILL,
  findIdentity,
  getProfile,
  readSessionTakeover,
  releaseSessionTakeover,
  renewSessionTakeover,
  type AgentRunLog,
  type AppendCustomerEventInput,
  type ApprovalRepository,
  type CareHandoffRepository,
  type ConversationRepository,
  type CustomerEventRepository,
  type DurableTaskRecord,
  type DurableWorkflowRepository,
  type EffectReservationRepository,
  type EvidenceRepository,
  type RedisInjectedClient,
  type TenantTransactionRunner,
} from '@agentos/database';

import { fail } from '../gateway/http.js';
import type {
  ApprovalDetailResponse,
  ApprovalQueueItem,
  ChannelId,
  EvidenceClassification,
  RetryableFailureClass,
  RunProjection,
  RunStepProjection,
  TimelineEntry,
} from '../gateway/contracts.js';
import type {
  ApprovalPort,
  CareHandoffPort,
  ConversationPort,
  ConversationRecord,
  EventPort,
  IdentityPort,
  ReceiptPort,
  RunPort,
  StartedRun,
  TakeoverLeasePort,
} from '../gateway/ports.js';

/** Encodes the canonical effect key and request fingerprint of one reservable effect. */
export function createEffectGuard(repository: EffectReservationRepository): IEffectGuard {
  return {
    computeEffectKey,
    computeRequestFingerprint,

    reserve: async (input): Promise<ReservationOutcome> => {
      const outcome = await repository.reserve({
        tenant_id: input.tenant_id,
        run_id: input.run_id,
        request_id: input.request_id,
        effect_key: input.effect_key,
        request_fingerprint: input.request_fingerprint,
        skill_id: input.skill_id,
        step_index: input.step_index,
        action_revision: input.action_revision,
      });

      // The repository owns the reservation protocol; this binding only widens its outcome onto the
      // canonical union so the engine and the gateway see one vocabulary.
      return outcome;
    },

    resolve: async (input): Promise<void> => {
      await repository.resolve({
        tenant_id: input.tenant_id,
        effect_key: input.effect_key,
        status: input.status,
        ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
      });
    },

    reconcile: async (input) => {
      const stored = await repository.getReservation(input.tenant_id, input.effect_key);

      if (stored === null) {
        return { outcome: 'INDETERMINATE' };
      }

      if (stored.status === 'SUCCEEDED') {
        return stored.response_receipt === null || stored.response_receipt === undefined
          ? { outcome: 'SUCCEEDED' }
          : { outcome: 'SUCCEEDED', receipt: stored.response_receipt };
      }

      if (stored.status === 'FAILED') {
        return { outcome: 'FAILED' };
      }

      // A row still `RESERVED` is precisely the indeterminate case: the effect may or may not have
      // landed, so no receipt exists and no re-dispatch is authorized.
      return { outcome: 'INDETERMINATE' };
    },
    reopenForRetry: async (input) => repository.reopenReservation({
      tenant_id: input.tenant_id,
      effect_key: input.effect_key,
      expires_at: new Date(Date.now() + EFFECT_RESERVATION_TTL_MS).toISOString(),
    }),
  };
}

/**
 * Binds the conversation table to the gateway's conversation port.
 *
 * @param repository The durable conversation repository.
 * @param options.session_secret The tenant-session signing secret. A session token is an HMAC over
 *   the conversation binding, so it can be verified on a later request without a second store; a
 *   missing secret throws at composition rather than issuing an unsigned token.
 */
export function createConversationPort(
  repository: ConversationRepository,
  options: { readonly session_secret: string },
): ConversationPort {
  if (options.session_secret.length < 16) {
    throw new Error(
      'SESSION_SECRET: a session token is a signed binding and cannot be issued without a signing secret',
    );
  }

  return {
    bindOrCreate: async (input) => {
      const row = await repository.bindOrCreate({
        tenant_id: input.tenant_id,
        channel: input.channel,
        external_thread_id: input.external_thread_id,
        customer_id: input.customer_id,
        ...(input.active_agent === undefined ? {} : { active_agent: input.active_agent }),
      });

      return {
        conversation_id: row.conversation_id,
        tenant_id: row.tenant_id,
        customer_id: row.customer_id,
        channel: row.channel as ChannelId,
        external_thread_id: row.external_thread_id,
        active_agent: row.active_agent,
        state: row.state,
        takeover_operator_id: row.takeover_operator_id,
        last_message_at: row.last_message_at,
        created_at: row.created_at,
        bound: row.bound,
      };
    },

    get: async (tenant_id, conversation_id): Promise<ConversationRecord | null> => {
      const row = await repository.get(tenant_id, conversation_id);
      if (row === null) return null;

      return {
        conversation_id: row.conversation_id,
        tenant_id: row.tenant_id,
        customer_id: row.customer_id,
        channel: row.channel as ChannelId,
        external_thread_id: row.external_thread_id,
        active_agent: row.active_agent,
        state: row.state,
        takeover_operator_id: row.takeover_operator_id,
        last_message_at: row.last_message_at,
        created_at: row.created_at,
        bound: true,
      };
    },

    setState: async (tenant_id, conversation_id, state, takeover_operator_id) => {
      await repository.setState(tenant_id, conversation_id, state, takeover_operator_id);
    },

    appendMessage: async (input) => {
      await repository.appendMessage({
        tenant_id: input.tenant_id,
        conversation_id: input.conversation_id,
        sender_type: input.sender_type,
        sender_id: input.sender_id,
        content: input.content,
        ...(input.content_type === undefined ? {} : { content_type: input.content_type }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });
    },

    issueSessionToken: async (input) => {
      // The token is the binding itself, signed. It carries no authority of its own: the gateway
      // still resolves the principal and re-checks the conversation on every request, and the
      // signature is what makes the binding unforgeable rather than merely opaque.
      const binding = `${input.tenant_id}.${input.conversation_id}.${input.channel}`;
      const signature = createHmac('sha256', options.session_secret)
        .update(binding, 'utf8')
        .digest('base64url');
      return `${Buffer.from(binding, 'utf8').toString('base64url')}.${signature}`;
    },
  };
}

/** The ten stages exposed by the unified Customer 360 timeline (FR-C360-002). */
const TIMELINE_STAGES = Object.freeze([
  'View',
  'Search',
  'Click',
  'Chat',
  'Add to cart',
  'Purchase',
  'Delivery',
  'Support',
  'Review',
  'Repurchase',
] as const);

type TimelineStage = (typeof TIMELINE_STAGES)[number];

/** Payload properties whose values are server-owned evidence, never client-delivered data. */
const RESERVED_EVENT_PAYLOAD_FIELDS = Object.freeze([
  'classification',
  'classification_authority',
  'evidence_reference',
] as const);

const BASELINE_EVENT_STAGES: Readonly<Record<string, TimelineStage>> = Object.freeze({
  session: 'View',
  view: 'View',
  product_view: 'View',
  'product.view': 'View',
  search: 'Search',
  click: 'Click',
  chat: 'Chat',
  message_received: 'Chat',
  'message.received': 'Chat',
  add_to_cart: 'Add to cart',
  'cart.add': 'Add to cart',
  checkout: 'Purchase',
  purchase: 'Purchase',
  delivery: 'Delivery',
  support: 'Support',
  review: 'Review',
  repurchase: 'Repurchase',
});

/**
 * Maps platform extension events by their documented suffix vocabulary. For example,
 * ext.marketing.campaign_view maps to View and ext.commerce.delivery_dispatched maps
 * to Delivery. An extension without one of these explicit suffix tokens stays Unknown.
 */
function extensionTimelineStage(eventName: string): TimelineStage | null {
  const match = /^ext\.[^.]+\.(.+)$/.exec(eventName);
  if (match === null) return null;
  const name = match[1]!.toLowerCase();
  if (/(^|[_.-])(view|impression)(?:$|[_.-])/.test(name)) return 'View';
  if (/(^|[_.-])search(?:$|[_.-])/.test(name)) return 'Search';
  if (/(^|[_.-])click(?:$|[_.-])/.test(name)) return 'Click';
  if (/(^|[_.-])(chat|message)(?:$|[_.-])/.test(name)) return 'Chat';
  if (/(^|[_.-])(add_to_cart|cart_add)(?:$|[_.-])/.test(name)) return 'Add to cart';
  if (/(^|[_.-])(purchase|checkout|order)(?:$|[_.-])/.test(name)) return 'Purchase';
  if (/(^|[_.-])(delivery|delivered|shipment)(?:$|[_.-])/.test(name)) return 'Delivery';
  if (/(^|[_.-])support(?:$|[_.-])/.test(name)) return 'Support';
  if (/(^|[_.-])review(?:$|[_.-])/.test(name)) return 'Review';
  if (/(^|[_.-])(repurchase|reorder|replenishment)(?:$|[_.-])/.test(name)) return 'Repurchase';
  return null;
}

function stringPayloadField(payload: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
}

function timelineDomain(eventName: string): TimelineEntry['domain'] | undefined {
  const match = /^ext\.([^.]+)\..+$/.exec(eventName);
  if (match === null) return undefined;
  switch (match[1]!.trim().toUpperCase()) {
    case 'MARKETING': return 'MARKETING';
    case 'SALES': return 'SALES';
    case 'COMMERCE': return 'COMMERCE';
    case 'CARE':
    case 'SUPPORT': return 'SUPPORT';
    case 'ORCHESTRATOR': return 'ORCHESTRATOR';
    default: return undefined;
  }
}

function timelineStage(eventName: string): TimelineStage | 'Unknown' {
  return BASELINE_EVENT_STAGES[eventName] ?? extensionTimelineStage(eventName) ?? 'Unknown';
}

function storedClassification(value: unknown): EvidenceClassification | undefined {
  return value === 'FACT' || value === 'SIGNAL' || value === 'HYPOTHESIS' || value === 'DECISION' || value === 'ACTION'
    ? value
    : undefined;
}

function reservedEventPayloadField(payload: Record<string, unknown>): string | undefined {
  const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key);

  for (const field of RESERVED_EVENT_PAYLOAD_FIELDS) {
    if (hasOwn(payload, field)) return field;
  }

  // R04 wraps the delivered payload under payload; R12 passes it directly.
  const nested = payload['payload'];
  if (plainRecord(nested)) {
    for (const field of RESERVED_EVENT_PAYLOAD_FIELDS) {
      if (hasOwn(nested, field)) return field;
    }
  }
  return undefined;
}

/** Maps a stored event row onto the truthful ten-stage timeline projection (03 §8). */
function toTimelineEntry(item: {
  readonly event_id: string;
  readonly source_event_id: string;
  readonly event_name: string;
  readonly session_id: string;
  readonly channel: string;
  readonly occurred_at: string;
  readonly payload: Record<string, unknown>;
}): TimelineEntry {
  const authoritativeClassification =
    item.payload['classification_authority'] === 'SERVER'
      ? storedClassification(item.payload['classification'])
      : undefined;
  const classification = authoritativeClassification ?? 'SIGNAL';
  const stage = timelineStage(item.event_name);
  const domain = timelineDomain(item.event_name);
  const summary = stringPayloadField(item.payload, 'summary', 'event_summary', 'description', 'message');
  const evidence_reference =
    authoritativeClassification === undefined
      ? undefined
      : stringPayloadField(item.payload, 'evidence_reference');
  const source_record_id = stringPayloadField(item.payload, 'source_record_id', 'sourceRecordId');
  const gaps: string[] = [];
  if (authoritativeClassification === undefined) gaps.push('CLASSIFICATION_NOT_SERVER_AUTHORITATIVE');
  if (stage === 'Unknown') gaps.push('stage mapping unavailable for event ' + item.event_name);
  if (domain === undefined) gaps.push('domain absent or outside the stored domain vocabulary');
  if (summary === undefined) gaps.push('summary absent from stored event payload');
  if (authoritativeClassification !== undefined && evidence_reference === undefined) {
    gaps.push('EVIDENCE_REFERENCE_ABSENT');
  }
  if (source_record_id === undefined) gaps.push('source_record_id absent from stored event payload');

  return {
    occurred_at: item.occurred_at,
    event_id: item.event_id,
    event_type: item.event_name,
    stage,
    canonical_event: BASELINE_EVENT_STAGES[item.event_name] === undefined ? null : item.event_name,
    classification,
    ...(domain === undefined ? {} : { domain }),
    ...(summary === undefined ? {} : { summary }),
    ...(evidence_reference === undefined ? {} : { evidence_reference }),
    ...(source_record_id === undefined ? {} : { source_record_id }),
    ...(gaps.length === 0 ? {} : { gap_reason: gaps.join('; ') }),
  };
}

/**
 * Binds the customer-event table to the gateway's event port.
 *
 * The port owns the durable append and the timeline read only: the canonical derivation belongs to
 * the connector layer and the `(tenant, source_event_id)` uniqueness constraint owns deduplication,
 * so a redelivery normalises here exactly as it did the first time and is then dropped by the store.
 */
export function createEventPort(repository: CustomerEventRepository): EventPort {
  return {
    append: async (input: AppendCustomerEventInput) => {
      const reservedField = reservedEventPayloadField(input.payload);
      if (reservedField !== undefined) {
        fail(
          'CUSTOMER_EVENT_RESERVED_PAYLOAD_FIELD',
          'client event payload contains a server-owned evidence field',
          { field: reservedField },
        );
      }
      return repository.append(input);
    },

    receipt: async (tenant_id, source_event_id) => repository.findByIdempotencyKey(tenant_id, source_event_id),

    timeline: async (input) => {
      const page = await repository.listTimeline({
        tenant_id: input.tenant_id,
        customer_id: input.customer_id,
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.to === undefined ? {} : { to: input.to }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
      });

      return {
        items: page.items.map(toTimelineEntry),
        next_cursor: page.next_cursor,
      };
    },
  };
}

/**
 * The receipt the caller of a storefront turn or an event delivery re-reads (R11, R12, R04).
 *
 * The receipt lives beside the canonical effect reservation, never in a second store, so a replay
 * and an idempotency conflict are decided by the same row that decided the first dispatch.
 */
export function createReceiptPort(guard: IEffectGuard): ReceiptPort {
  return {
    receiptFor: async (tenant_id, effect_key) => {
      const outcome = await guard.reconcile({ tenant_id, effect_key, skill_id: 'gateway.receipt' });
      if (outcome.outcome !== 'SUCCEEDED') return null;

      const receipt = outcome.receipt;
      if (typeof receipt !== 'object' || receipt === null || Array.isArray(receipt)) return null;

      return { ...receipt };
    },

    storeReceipt: async (tenant_id, effect_key, receipt) => {
      await guard.resolve({ tenant_id, effect_key, status: 'SUCCEEDED', receipt });
    },
  };
}

/** Repository surface needed by the truthful durable run projection. */
type DurableRunRepository = Pick<
  DurableWorkflowRepository,
  'getTask' | 'listTasks' | 'requeueFailed'
>;

type DurableReconciliationRepository = Pick<DurableWorkflowRepository, 'queueReconciliation'>;
type ApprovalDecisionRepository = Pick<ApprovalRepository, 'queueDecision'>;

/** Operational-log surface needed by retry classification and R16. */
type RunEvidenceRepository = Pick<EvidenceRepository, 'readRunLogs' | 'readEvidenceChain'>;

/** Reservation surface used to prove that a failed effect is not still indeterminate. */
type RunReservationRepository = Pick<EffectReservationRepository, 'getReservation'>;

/** Approval read surface. Decisions stay with the unavailable orchestrator resume graph. */
type ApprovalReadRepository = Pick<ApprovalRepository, 'getDetail' | 'listPending'>;

/** A JSON object as stored by PostgreSQL JSONB. */
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Reads the persisted error code without trusting a free-text message. */
function errorCodeOf(value: unknown): string | null {
  if (!plainRecord(value)) return null;
  const code = value['code'];
  return typeof code === 'string' && code.length > 0 ? code : null;
}

/** Reads the deterministic effect key from a complete checkpoint or a stored run-log action. */
function effectKeyOf(task: DurableTaskRecord, logs: readonly AgentRunLog[]): string | null {
  if (plainRecord(task.state_payload)) {
    const pending = task.state_payload['pending_action'];
    if (plainRecord(pending) && typeof pending['effect_key'] === 'string') {
      return pending['effect_key'];
    }
  }

  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const action = logs[index]?.action;
    if (plainRecord(action) && typeof action['effect_key'] === 'string') {
      return action['effect_key'];
    }
  }

  return null;
}

/** Closed mapping of stored pre-effect failures to R13's verified side-effect-free classes. */
function retryClassOf(code: string | null): RetryableFailureClass | null {
  switch (code) {
    case 'SCHEMA_VALIDATION_ERROR':
    case 'OUTPUT_SCHEMA_VALIDATION_ERROR':
    case 'CANONICAL_JSON_INVALID':
    case 'POLICY_INPUT_INVALID':
      return 'SCHEMA_VALIDATION_FAILURE';

    case 'AUTHORITY_DENIED':
    case 'INSUFFICIENT_AUTHORITY':
    case 'INVALID_CLEARANCE':
    case 'PROHIBITED_ACTION':
    case 'UNAUTHORIZED_AGENT':
    case 'CLEARANCE_REQUIRED':
      return 'AUTHORITY_DENY';

    case 'TENANT_CONTEXT_REQUIRED':
    case 'CROSS_TENANT_ASSERTION':
    case 'CROSS_CUSTOMER_ASSERTION':
    case 'IDENTITY_UNVERIFIED':
    case 'UNKNOWN_AGENT':
    case 'UNKNOWN_SKILL':
    case 'AGENT_TO_AGENT_FORBIDDEN':
    case 'PROMPT_INJECTION_BLOCKED':
    case 'HYPOTHESIS_PROMOTION_REJECTED':
    case 'CONSENT_REQUIRED':
    case 'P_FLOOR_UNAVAILABLE':
    case 'ERR_ARBITRARY_PRICING':
    case 'ERR_FLOOR_PRICE_VIOLATION':
    case 'AUTHORITATIVE_SOURCE_UNAVAILABLE':
    case 'EFFECT_KEY_REQUIRED':
    case 'IDEMPOTENCY_CONFLICT':
    case 'HUMAN_TAKEOVER':
    case 'EVIDENCE_REQUIRED':
    case 'AUDIT_SECRET_MISSING':
    case 'AUDIT_UNAVAILABLE':
    case 'APPROVAL_QUEUE_UNAVAILABLE':
      return 'FAIL_CLOSED';

    case 'PROVIDER_RATE_LIMITED':
    case 'PROVIDER_UNAVAILABLE':
    case 'CONNECTOR_NOT_FOUND':
    case 'CONNECTOR_NOT_ENABLED':
      return 'PRE_DISPATCH_PROVIDER_REJECTION';

    default:
      return null;
  }
}

/** Extracts the persisted USD cost without inventing a zero for an unrecognised shape. */
function costOf(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (plainRecord(value)) {
    const total = value['total_cost_usd'];
    if (typeof total === 'number' && Number.isFinite(total)) return total;
  }
  throw new Error('RUN_LOG_PROJECTION_INVALID: cost has no numeric total_cost_usd');
}

/** Maps one durable operational-log row without dropping any structured value. */
function toRunStep(log: AgentRunLog): RunStepProjection {
  return {
    step_index: log.step_index,
    skill: log.skill,
    tool: log.tool,
    authority: log.authority,
    approval: log.approval === null ? 'null' : canonicalizeJson(log.approval),
    action: canonicalizeJson(log.action),
    execution_status: log.execution_status,
    evidence: log.evidence === null ? null : canonicalizeJson(log.evidence),
    outcome: log.outcome === null ? null : canonicalizeJson(log.outcome),
    latency_ms: log.latency_ms,
    cost: costOf(log.cost),
    error: log.error === null ? null : canonicalizeJson(log.error),
    started_at: log.started_at,
    completed_at: log.completed_at,
  };
}

/** Maps the PostgreSQL schedule of record plus its step log onto R16. */
async function toRunProjection(
  task: DurableTaskRecord,
  evidence: RunEvidenceRepository,
): Promise<RunProjection> {
  const logs = await evidence.readRunLogs(task.tenant_id, task.run_id);
  return {
    run_id: task.run_id,
    state: task.state,
    task_version: task.task_version,
    current_step: task.current_step,
    retry_count: task.retry_count,
    last_error_class: task.last_error_class,
    steps: logs.map(toRunStep),
    correlation_id: task.correlation_id,
  };
}

/**
 * Binds the durable run projection, safe requeue path and INTERNAL reconciliation event queue.
 * Provider-confirmed settlement remains fail-closed in the orchestrator until a provider query is
 * available; this binding records the authenticated operator event without settling a reservation.
 */
export function createDurableRunPort(
  repository: DurableRunRepository,
  evidence: RunEvidenceRepository,
  reservations: RunReservationRepository,
  reconciliation?: DurableReconciliationRepository,
): Pick<RunPort, 'read' | 'classifyRetry' | 'retry' | 'reconcile' | 'list'> {
  const classifyRetry: RunPort['classifyRetry'] = async (tenant_id, run_id) => {
    const task = await repository.getTask(tenant_id, run_id);
    if (task === null) return { retryable: false, reason: 'NOT_FOUND' };
    if (task.state !== 'failed') return { retryable: false, reason: 'NOT_FAILED' };

    const logs = await evidence.readRunLogs(tenant_id, run_id);
    const effect_key = effectKeyOf(task, logs);
    const failure_class = retryClassOf(errorCodeOf(task.error_details));
    if (effect_key === null || failure_class === null) {
      return { retryable: false, reason: 'UNKNOWN' };
    }

    const reservation = await reservations.getReservation(tenant_id, effect_key);
    if (reservation !== null && reservation.status !== 'FAILED') {
      // RESERVED means the effect may have landed; SUCCEEDED means it did. Neither is retryable.
      return { retryable: false, reason: 'UNKNOWN' };
    }

    return { retryable: true, failure_class, effect_key };
  };

  return {
    reconcile: async (input) => {
      if (reconciliation === undefined) {
        throw new Error(
          'RUN_RECONCILIATION_UNBOUND: no durable reconciliation repository is bound for INTERNAL handoff',
        );
      }
      const task = await reconciliation.queueReconciliation({
        tenant_id: input.tenant_id,
        run_id: input.run_id,
        resolution: input.resolution,
        reason: input.reason,
        operator_id: input.operator_id,
        ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
      });
      return { accepted: true, run_id: task.run_id };
    },
    read: async ({ tenant_id, run_id }) => {
      const task = await repository.getTask(tenant_id, run_id);
      if (task === null) return null;
      const [logs, chain] = await Promise.all([
        evidence.readRunLogs(tenant_id, run_id),
        evidence.readEvidenceChain(tenant_id, run_id),
      ]);
      const lastEvidence = chain.at(-1);
      const actions = logs.flatMap((log) => {
        if (!plainRecord(log.action)) return [];
        const provider_reference = log.action['provider_reference'];
        return typeof provider_reference === 'string'
          ? [{ operation: log.skill, status: log.execution_status, provider_reference }]
          : [];
      });
      return {
        run_id: task.run_id,
        task_version: task.task_version,
        lifecycle_state: task.state,
        correlation_id: task.correlation_id,
        ...(lastEvidence === undefined ? {} : { evidence_reference: lastEvidence.evidence_id }),
        ...(actions.length === 0 ? {} : { actions }),
      };
    },

    classifyRetry,

    retry: async (input) => {
      const classification = await classifyRetry(input.tenant_id, input.run_id);
      if (!classification.retryable) {
        if (classification.reason === 'UNKNOWN') {
          throw new Error(
            'RUN_RECONCILIATION_REQUIRED: the effect is not proven absent and must be reconciled before any retry',
          );
        }
        throw new Error('TASK_REQUEUE_NOT_FAILED: only a failed durable task can be re-queued');
      }

      const task = await repository.requeueFailed({
        tenant_id: input.tenant_id,
        run_id: input.run_id,
        reason: input.reason,
      });
      return {
        run_id: task.run_id,
        task_version: task.task_version,
        correlation_id: task.correlation_id,
        lifecycle_state: task.state,
      };
    },

    list: async (input) => {
      const page = await repository.listTasks(input);
      return {
        items: await Promise.all(page.items.map((task) => toRunProjection(task, evidence))),
        next_cursor: page.next_cursor,
      };
    },
  };
}

export interface StartRunPortOptions {
  readonly guard: IEffectGuard;
  readonly workflows: Pick<DurableWorkflowRepository, 'getTask'>;
  readonly ids?: () => string;
  readonly clock?: () => Date;
  readonly runner?: TenantTransactionRunner;
}

/**
 * Binds `RunPort.start` for Customer Care turns.
 *
 * Computes `effect_key` and `request_fingerprint` with the injected `IEffectGuard` over
 * `{tenant_id, skill_id: CONVERSATION_TURN_SKILL, step_index: 0, action_revision: 0, request_id}`
 * and the canonical payload `{message, conversation_id, module, attachments}`.
 * Admits the turn via `admitCareTurn` in one transaction.
 * On REPLAY/IN_FLIGHT returns the existing task identity.
 * On CONFLICT throws IDEMPOTENCY_CONFLICT refusal.
 */
export function createStartRunPort(
  options: StartRunPortOptions,
): Pick<RunPort, 'start'>;
export function createStartRunPort(
  guard: IEffectGuard,
  workflows: Pick<DurableWorkflowRepository, 'getTask'>,
  options?: {
    readonly ids?: () => string;
    readonly clock?: () => Date;
    readonly runner?: TenantTransactionRunner;
  },
): Pick<RunPort, 'start'>;
export function createStartRunPort(
  guardOrOptions: IEffectGuard | StartRunPortOptions,
  workflowsArg?: Pick<DurableWorkflowRepository, 'getTask'>,
  extraOptions?: {
    readonly ids?: () => string;
    readonly clock?: () => Date;
    readonly runner?: TenantTransactionRunner;
  },
): Pick<RunPort, 'start'> {
  const options: StartRunPortOptions =
    'guard' in guardOrOptions
      ? guardOrOptions
      : {
          guard: guardOrOptions,
          workflows: workflowsArg!,
          ...(extraOptions?.ids === undefined ? {} : { ids: extraOptions.ids }),
          ...(extraOptions?.clock === undefined ? {} : { clock: extraOptions.clock }),
          ...(extraOptions?.runner === undefined ? {} : { runner: extraOptions.runner }),
        };

  const { guard, workflows } = options;
  const ids = options.ids ?? systemIdentifiers;
  const clock = options.clock ?? systemClock;
  const runner = options.runner;

  return {
    async start(input): Promise<StartedRun> {
      const rawModule = input.payload['module'];
      const module = rawModule === undefined || rawModule === 'auto' ? 'support' : rawModule;
      const canonicalPayload = {
        message: input.payload['message'],
        conversation_id: input.payload['conversation_id'],
        module,
        attachments: input.payload['attachments'] ?? null,
      };

      const effect_key = guard.computeEffectKey({
        tenant_id: input.tenant_id,
        skill_id: CONVERSATION_TURN_SKILL,
        step_index: 0,
        action_revision: 0,
        request_id: input.request_id,
      });

      const request_fingerprint = guard.computeRequestFingerprint(canonicalPayload);
      const run_id = ids();
      const conversation_id = input.payload['conversation_id'];
      // The canonical `SignalEnvelope`: `signal_id` IS the immutable inbound identity the effect key
      // is derived from. The API-resolved conversation UUID and the session/channel identity are
      // nested under `subject`; the context aggregator never derives the UUID from a thread id.
      const signal: Record<string, unknown> = {
        signal_id: input.request_id,
        tenant_id: input.tenant_id,
        correlation_id: input.correlation_id,
        source_channel: input.source_channel,
        event_type: input.event_type,
        timestamp: clock().toISOString(),
        payload: {
          ...input.payload,
          module,
        },
        subject: {
          session_id: input.session_id,
          ...(typeof conversation_id === 'string' && conversation_id.length > 0 ? { conversation_id } : {}),
          channel_type: input.channel_type,
          ...(input.channel_identifier === undefined ? {} : { channel_identifier: input.channel_identifier }),
          ...(input.verified_customer_id === undefined ? {} : { verified_customer_id: input.verified_customer_id }),
        },
      };

      const outcome = await admitCareTurn(
        {
          tenant_id: input.tenant_id,
          effect_key,
          request_id: input.request_id,
          request_fingerprint,
          run_id,
          correlation_id: input.correlation_id,
          signal,
          skill_id: CONVERSATION_TURN_SKILL,
          step_index: 0,
          // The window is the effect guard's own constant, so the row admission writes and the row
          // the guard later reads share one number instead of two that could drift apart.
          reservation_ttl_ms: EFFECT_RESERVATION_TTL_MS,
          now: clock,
        },
        runner,
      );

      if (outcome.kind === 'CONFLICT') {
        fail(
          'IDEMPOTENCY_CONFLICT',
          'this idempotency key was already claimed for a different payload; the turn is not started again',
        );
      }

      if (outcome.kind === 'RECONCILE_REQUIRED') {
        fail(
          'INTERNAL_ERROR',
          'the turn reservation requires reconciliation before it can be started again',
        );
      }

      if (outcome.kind === 'ADMITTED') {
        return {
          run_id: outcome.task.run_id,
          task_version: outcome.task.task_version,
          correlation_id: outcome.task.correlation_id,
          lifecycle_state: outcome.task.state,
          admission: 'ADMITTED',
        };
      }

      const existingTask = await workflows.getTask(input.tenant_id, outcome.run_id);
      if (existingTask === null) {
        throw new Error(
          `DURABLE_TASK_NOT_FOUND: task for admitted run ${outcome.run_id} not found in tenant ${input.tenant_id}.`,
        );
      }

      return {
        run_id: outcome.run_id,
        task_version: existingTask.task_version,
        correlation_id: existingTask.correlation_id,
        lifecycle_state: existingTask.state,
        admission: outcome.kind,
        ...(outcome.kind === 'REPLAY' && outcome.receipt !== null ? { receipt: outcome.receipt } : {}),
      };
    },
  };
}

/** Structural approval row used by the gateway mapper without importing repository internals. */
interface ApprovalDetailRecordLike {
  readonly approval: {
    readonly id: string;
    readonly tenant_id: string;
    readonly run_id: string;
    readonly action_id: string;
    readonly effect_key: string;
    readonly payload: unknown;
    readonly payload_sha256: string;
    readonly reason: string;
    readonly operator_id: string | null;
    readonly decision: string;
    readonly is_paused: boolean;
    readonly review_comment: string | null;
    readonly decided_at: string | null;
    readonly created_at: string;
  };
}

/** Maps the single canonical approval row onto the queue contract. */
function toApprovalQueueItem(detail: ApprovalDetailRecordLike): ApprovalQueueItem {
  const { approval } = detail;
  if (approval.decision !== 'PENDING') {
    throw new Error(
      'APPROVAL_DETAIL_STATUS_UNREPRESENTABLE: this gateway contract publishes the PENDING queue only',
    );
  }
  if (!plainRecord(approval.payload)) {
    throw new Error('APPROVAL_PAYLOAD_INVALID: the reviewed approval payload is not a JSON object');
  }

  return {
    approval_id: approval.id,
    run_id: approval.run_id,
    action_id: approval.action_id,
    effect_key: approval.effect_key,
    payload: approval.payload,
    reason: approval.reason,
    status: 'PENDING',
    is_paused: approval.is_paused,
    decided_by: approval.operator_id,
    decided_at: approval.decided_at,
    decision_notes: approval.review_comment,
    created_at: approval.created_at,
    payload_sha256: approval.payload_sha256,
  };
}

/** Binds the approval queue and detail reads to their canonical PostgreSQL rows. */
export function createApprovalReadPort(
  repository: ApprovalReadRepository,
): Pick<ApprovalPort, 'list' | 'detail'> {
  return {
    list: async (input) => {
      const page = await repository.listPending({
        tenant_id: input.tenant_id,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      });
      return {
        items: page.items.map(toApprovalQueueItem),
        next_cursor: page.next_cursor,
      };
    },

    detail: async (tenant_id, approval_id): Promise<ApprovalDetailResponse | null> => {
      const detail = await repository.getDetail(tenant_id, approval_id);
      return detail === null
        ? null
        : {
            ...toApprovalQueueItem(detail),
            tenant_id: detail.approval.tenant_id,
            // No owner-approved approval TTL or stored expiry exists in P0.
            expires_at: null,
          };
    },
  };
}
/** Queues an authenticated decision; the worker owns policy and lease-fenced consumption. */
export function createApprovalDecisionPort(
  repository: ApprovalDecisionRepository,
): Pick<ApprovalPort, 'decide'> {
  return {
    decide: (input) => repository.queueDecision(input),
  };
}

/** Binds SCR-005 to the canonical tenant/conversation-scoped Redis lease helpers. */
export function createTakeoverLeasePort(
  redis: RedisInjectedClient,
  now: () => Date = systemClock,
): TakeoverLeasePort {
  return {
    acquire: async (input) => acquireSessionTakeover(redis, input, now),
    renew: async (input) => renewSessionTakeover(redis, input, now),
    release: async (input) => releaseSessionTakeover(redis, input),
    holder: async (tenant_id, conversation_id) =>
      readSessionTakeover(redis, tenant_id, conversation_id, now),
  };
}

/** Binds durable handoff ownership transitions to the PostgreSQL repository transaction. */
export function createCareHandoffPort(
  repository: Pick<CareHandoffRepository, 'claim' | 'complete'>,
): CareHandoffPort {
  return {
    claim: (input) => repository.claim(input),
    complete: (input) => repository.complete(input),
  };
}

/** Function seam for the tenant-scoped verified channel-identity read. */
export type CustomerIdentityLookup = typeof findIdentity;

/** Tenant-scoped existence read used only for authenticated operator customer claims. */
export type CustomerOperatorCustomerLookup = typeof getProfile;

/**
 * Binds channel identity only from a verified exact tenant/channel row. An operator's claimed
 * customer id takes a separate, tenant-scoped existence path and is never reported as a channel
 * identity; all other callers remain unresolved when no channel identifier is present.
 */
export function createIdentityPort(
  lookup: CustomerIdentityLookup = findIdentity,
  operatorLookup: CustomerOperatorCustomerLookup = getProfile,
): IdentityPort {
  return {
    resolveCustomer: async (input) => {
      if (input.channel_type === 'OPERATOR') {
        if (input.claimed_customer_id === undefined || input.claimed_customer_id.length === 0) {
          return { customer_id: null, verdict: 'UNRESOLVED' };
        }
        const profile = await operatorLookup(input.tenant_id, input.claimed_customer_id);
        return profile === null
          ? { customer_id: null, verdict: 'UNRESOLVED' }
          : { customer_id: profile.customer_id, verdict: 'OPERATOR_VERIFIED' };
      }

      if (input.channel_identifier === undefined || input.channel_identifier.length === 0) {
        return { customer_id: null, verdict: 'UNRESOLVED' };
      }

      const identity = await lookup(
        input.tenant_id,
        input.channel_type,
        input.channel_identifier,
      );
      return identity === null || identity.verified_at === null
        ? { customer_id: null, verdict: 'UNRESOLVED' }
        : { customer_id: identity.customer_id, verdict: 'CHANNEL_IDENTIFIER_EXACT' };
    },
  };
}

/** Identifier source for the composition root: every gateway-issued id is a real UUID. */
export const systemIdentifiers: () => string = () => randomUUID();

/** Clock source for the composition root: the only place a wall-clock instant is read. */
export const systemClock: () => Date = () => new Date();

/**
 * Transaction runner used by the gateway-side projections that need a tenant-scoped read beyond the
 * repositories. Exposed so a projection binds the same RLS context the repositories use.
 */
export interface ProjectionTransactionRunner {
  readonly run: TenantTransactionRunner;
}
