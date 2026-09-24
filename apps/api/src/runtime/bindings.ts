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
  readSessionTakeover,
  releaseSessionTakeover,
  renewSessionTakeover,
  type AgentRunLog,
  type AppendCustomerEventInput,
  type ApprovalRepository,
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

/** Maps a stored event row onto the ten-stage timeline projection (`03` §8). */
function toTimelineEntry(item: {
  readonly event_id: string;
  readonly source_event_id: string;
  readonly event_name: string;
  readonly session_id: string;
  readonly channel: string;
  readonly occurred_at: string;
  readonly payload: Record<string, unknown>;
}): TimelineEntry {
  const classification = item.payload['classification'];
  const verdict = item.payload['evidence_classification'];

  return {
    occurred_at: item.occurred_at,
    source_record_id: item.source_event_id,
    event_id: item.event_id,
    stage: item.event_name,
    canonical_event: item.event_name.startsWith('ext.') ? null : item.event_name,
    // The classification is carried by the producer; a row that predates the vocabulary is a
    // SIGNAL, its weakest truthful reading, never a FACT.
    classification:
      classification === 'FACT' || classification === 'HYPOTHESIS' || classification === 'DECISION' || classification === 'ACTION'
        ? classification
        : verdict === 'FACT' || verdict === 'HYPOTHESIS' || verdict === 'DECISION' || verdict === 'ACTION'
          ? verdict
          : ('SIGNAL' satisfies EvidenceClassification),
    evidence_reference:
      typeof item.payload['evidence_reference'] === 'string' ? item.payload['evidence_reference'] : null,
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
    append: async (input: AppendCustomerEventInput) => repository.append(input),

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
 * Binds the durable run read model and the narrow operator requeue path.
 *
 * Start and reconciliation are intentionally absent: both require the complete RevenueOrchestrator
 * graph, including current policy, skill execution, evidence and leases. The composition root keeps
 * those two capabilities fail-closed instead of mutating repositories behind the orchestrator.
 */
export function createDurableRunPort(
  repository: DurableRunRepository,
  evidence: RunEvidenceRepository,
  reservations: RunReservationRepository,
): Pick<RunPort, 'read' | 'classifyRetry' | 'retry' | 'list'> {
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
      const canonicalPayload = {
        message: input.payload['message'],
        conversation_id: input.payload['conversation_id'],
        module: input.payload['module'] ?? 'support',
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

      // The canonical `SignalEnvelope`: `signal_id` IS the immutable inbound identity the effect key
      // is derived from, and the session/channel binding travels nested under `subject` because that
      // is the only place the context aggregator may read identity from.
      const signal: Record<string, unknown> = {
        signal_id: input.request_id,
        tenant_id: input.tenant_id,
        correlation_id: input.correlation_id,
        source_channel: input.source_channel,
        event_type: input.event_type,
        timestamp: clock().toISOString(),
        payload: input.payload,
        subject: {
          session_id: input.session_id,
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

/** Function seam for the tenant-scoped verified channel-identity read. */
export type CustomerIdentityLookup = typeof findIdentity;

/** Binds identity only from a verified exact tenant/channel row; claims never become answers. */
export function createIdentityPort(
  lookup: CustomerIdentityLookup = findIdentity,
): IdentityPort {
  return {
    resolveCustomer: async (input) => {
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
