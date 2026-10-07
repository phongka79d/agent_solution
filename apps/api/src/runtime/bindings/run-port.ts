import { randomUUID } from 'node:crypto';

import { canonicalizeJson, EFFECT_RESERVATION_TTL_MS } from '@agentos/core-engine';
import type { IEffectGuard } from '@agentos/core-engine/contracts';
import {
  admitCareTurn,
  CONVERSATION_TURN_SKILL,
  type AgentRunLog,
  type DurableTaskRecord,
  type DurableWorkflowRepository,
  type EffectReservationRepository,
  type EvidenceRepository,
  type RunResponseRepository,
  type TenantTransactionRunner,
} from '@agentos/database';

import type {
  RetryableFailureClass,
  RunProjection,
  RunStepProjection,
  TaskSourceRef,
} from '../../gateway/contracts.js';
import type { RunPort, StartedRun } from '../../gateway/ports.js';
import { fail } from '../../gateway/http.js';

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

/** Repository surface needed to project a persisted terminal response onto R03. */
type DurableResponseRepository = Pick<RunResponseRepository, 'read'>;

/** Repository surface needed by the truthful durable run projection. */
type DurableRunRepository = Pick<
  DurableWorkflowRepository,
  'getTask' | 'listTasks' | 'requeueFailed'
>;

type DurableReconciliationRepository = Pick<DurableWorkflowRepository, 'queueReconciliation'>;

/** Operational-log surface needed by retry classification and R16. */
type RunEvidenceRepository = Pick<EvidenceRepository, 'readRunLogs' | 'readEvidenceChain'>;

/** Reservation surface used to prove that a failed effect is not still indeterminate. */
type RunReservationRepository = Pick<EffectReservationRepository, 'getReservation'>;

/** A JSON object as stored by PostgreSQL JSONB. */
function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Malformed or unrelated admission signals grant no session ownership. */
function runOwner(task: DurableTaskRecord): { conversation_id?: string; session_id?: string } {
  if (!plainRecord(task.state_payload) || !plainRecord(task.state_payload['signal'])) return {};
  const signal = task.state_payload['signal'];
  if (!plainRecord(signal['subject']) || !plainRecord(signal['payload'])) return {};
  const conversation_id = signal['subject']['conversation_id'];
  const payloadConversation = signal['payload']['conversation_id'];
  const session_id = signal['subject']['session_id'];
  if (
    typeof conversation_id !== 'string' ||
    conversation_id.length === 0 ||
    conversation_id !== payloadConversation ||
    typeof session_id !== 'string' ||
    session_id.length === 0
  ) return {};
  return { conversation_id, session_id };
}

const TASK_SOURCE_KEYS = ['source_record_id', 'source_version', 'source_file'] as const;

function invalidResponseProjection(detail: string): never {
  throw new Error(`RUN_RESPONSE_PROJECTION_INVALID: ${detail}`);
}

/**
 * Rebuilds the closed wire source shape instead of returning JSONB objects directly. This prevents
 * an accidentally persisted private field from crossing the R03 boundary.
 */
function taskSourcesOf(value: unknown): readonly TaskSourceRef[] {
  if (!Array.isArray(value)) {
    return invalidResponseProjection('sources must be an array');
  }

  return value.map((item, index): TaskSourceRef => {
    if (!plainRecord(item)) {
      return invalidResponseProjection(`sources[${index}] must be an object`);
    }

    const keys = Object.keys(item);
    if (
      keys.length !== TASK_SOURCE_KEYS.length ||
      keys.some((key) => !(TASK_SOURCE_KEYS as readonly string[]).includes(key))
    ) {
      return invalidResponseProjection(`sources[${index}] has an invalid shape`);
    }

    const source_record_id = item['source_record_id'];
    const source_version = item['source_version'];
    const source_file = item['source_file'];
    if (
      typeof source_record_id !== 'string' ||
      source_record_id.length === 0 ||
      typeof source_version !== 'string' ||
      source_version.length === 0 ||
      typeof source_file !== 'string' ||
      source_file.length === 0
    ) {
      return invalidResponseProjection(`sources[${index}] has an invalid field`);
    }

    return { source_record_id, source_version, source_file };
  });
}

function projectPersistedResponse(
  response: {
    readonly tenant_id: string;
    readonly run_id: string;
    readonly answer: unknown;
    readonly sources: unknown;
  },
  tenant_id: string,
  run_id: string,
): { readonly answer: string; readonly sources: readonly TaskSourceRef[] } {
  if (response.tenant_id !== tenant_id || response.run_id !== run_id) {
    return invalidResponseProjection('stored response identity does not match the requested run');
  }
  if (typeof response.answer !== 'string') {
    return invalidResponseProjection('answer must be text');
  }
  return { answer: response.answer, sources: taskSourcesOf(response.sources) };
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
 * When a response reader is bound, its answer and closed source references are projected only for a
 * completed task; all non-completed states remain receipt/status-only.
 */

export function createDurableRunPort(
  repository: DurableRunRepository,
  evidence: RunEvidenceRepository,
  reservations: RunReservationRepository,
  reconciliationOrResponse?: DurableReconciliationRepository | DurableResponseRepository,
  responseRepository?: DurableResponseRepository,
): Pick<RunPort, 'read' | 'classifyRetry' | 'retry' | 'reconcile' | 'list'> {
  const reconciliation =
    reconciliationOrResponse !== undefined && 'queueReconciliation' in reconciliationOrResponse
      ? reconciliationOrResponse
      : undefined;
  const responseReader =
    responseRepository ??
    (reconciliationOrResponse !== undefined && 'read' in reconciliationOrResponse
      ? reconciliationOrResponse
      : undefined);
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
      if (task.tenant_id !== tenant_id || task.run_id !== run_id) return null;
      const [logs, chain, response] = await Promise.all([
        evidence.readRunLogs(tenant_id, run_id),
        evidence.readEvidenceChain(tenant_id, run_id),
        task.state === 'completed' && responseReader !== undefined
          ? responseReader.read(tenant_id, run_id)
          : Promise.resolve(null),
      ]);
      const lastEvidence = chain.at(-1);
      const actions = logs.flatMap((log) => {
        if (!plainRecord(log.action)) return [];
        const provider_reference = log.action['provider_reference'];
        return typeof provider_reference === 'string'
          ? [{ operation: log.skill, status: log.execution_status, provider_reference }]
          : [];
      });
      const persistedResponse =
        response === null ? {} : projectPersistedResponse(response, tenant_id, run_id);
      return {
        run_id: task.run_id,
        task_version: task.task_version,
        lifecycle_state: task.state,
        correlation_id: task.correlation_id,
        ...runOwner(task),
        ...persistedResponse,
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
        ...runOwner(task),
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

type QueuedAdmissionTaskWriter = (input: {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly state_payload?: unknown;
}) => Promise<DurableTaskRecord>;

type StartWorkflowRepository =
  Pick<DurableWorkflowRepository, 'getTask'> & {
    readonly createQueuedAdmissionTask?: QueuedAdmissionTaskWriter;
  };

export interface StartRunPortOptions {
  readonly guard: IEffectGuard;
  readonly workflows: StartWorkflowRepository;
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
  workflows: StartWorkflowRepository,
  options?: {
    readonly ids?: () => string;
    readonly clock?: () => Date;
    readonly runner?: TenantTransactionRunner;
  },
): Pick<RunPort, 'start'>;
export function createStartRunPort(
  guardOrOptions: IEffectGuard | StartRunPortOptions,
  workflowsArg?: StartWorkflowRepository,
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
      const campaignDraft = input.admission_skill_id === 'campaign.draft';
      const canonicalPayload = campaignDraft ? input.payload : {
        message: input.payload['message'],
        conversation_id: input.payload['conversation_id'],
        module,
        attachments: input.payload['attachments'] ?? null,
      };

      const effect_key = guard.computeEffectKey({
        tenant_id: input.tenant_id,
        skill_id: input.admission_skill_id ?? CONVERSATION_TURN_SKILL,
        step_index: 0,
        action_revision: 0,
        request_id: input.request_id,
      });

      const request_fingerprint = guard.computeRequestFingerprint(canonicalPayload);
      const run_id = input.admission_reservation?.run_id ?? ids();
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

      if (input.admission_reservation !== undefined) {
        if (
          input.admission_reservation.effect_key !== effect_key ||
          input.admission_reservation.request_fingerprint !== request_fingerprint
        ) {
          fail('INTERNAL_ERROR', 'the preclaimed turn reservation does not match the canonical request');
        }
        if (workflows.createQueuedAdmissionTask === undefined) {
          throw new Error('PRECLAIMED_ADMISSION_UNSUPPORTED: the run binding has no queued task writer');
        }
        const task = await workflows.createQueuedAdmissionTask({
          tenant_id: input.tenant_id,
          run_id,
          correlation_id: input.correlation_id,
          state_payload: { signal },
        });
        return {
          run_id: task.run_id,
          task_version: task.task_version,
          correlation_id: task.correlation_id,
          lifecycle_state: task.state,
          ...(typeof conversation_id === 'string' && conversation_id.length > 0 ? { conversation_id } : {}),
          admission: 'ADMITTED',
        };
      }

      const outcome = await admitCareTurn(
        {
          tenant_id: input.tenant_id,
          effect_key,
          request_id: input.request_id,
          request_fingerprint,
          run_id,
          correlation_id: input.correlation_id,
          signal,
          skill_id: input.admission_skill_id ?? CONVERSATION_TURN_SKILL,
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
          ...runOwner(outcome.task),
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
        ...runOwner(existingTask),
        admission: outcome.kind,
        ...(outcome.kind === 'REPLAY' && outcome.receipt !== null ? { receipt: outcome.receipt } : {}),
      };
    },
  };
}
