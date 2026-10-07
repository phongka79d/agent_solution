import { randomUUID } from 'node:crypto';
import { packageName as adaptersPackageName } from '@agentos/adapters';
import {
  packageName as coreEnginePackageName,
  RevenueOrchestrator,
  type AutonomyAdmissionPort,
} from '@agentos/core-engine';
import {
  packageName as databasePackageName,
  DurableWorkflowRepository,
  assertCompleteCheckpoint,
  readCrossDomainLifecycle,
  type DurableTaskRecord,
  type TenantTransactionRunner,
} from '@agentos/database';
import { packageName as skillsPackageName } from '@agentos/skills';
import type {
  ActionDraft,
  ExecutionReceipt,
  ICrossDomainHandoffBroker,
  SignalEnvelope,
} from '@agentos/core-engine/contracts';

import { createCrossDomainHandoffBroker } from './runtime/shared/cross-domain-handoff.js';

import { createWorkerConnectors, type WorkerConnectorEnv, type WorkerConnectorOptions } from './runtime/connectors.js';
import { nodeHmacSha256Hex } from './runtime/hmac.js';

import {
  type CareOrchestratorFactoryOptions,
} from './runtime/care/index.js';
import {
  type SalesOrchestratorFactoryOptions,
} from './runtime/sales/index.js';
import {
  createDomainRuntimeRegistry,
  type DomainRuntimeRegistry,
  type DomainSignalContract,
} from './runtime/domain-registry.js';
import {
  MARKETING_SIGNAL_CONTRACT_DEFAULTS,
  type MarketingOrchestratorFactoryOptions,
} from './runtime/marketing/factory.js';
import { createDatabaseAutonomy } from './worker-database-autonomy.js';
import { createWorkerDomainBindings } from './worker-bindings.js';
import { createWorkerPoller, type WorkerDrainResult, type WorkerPollerHandle } from './worker-polling.js';

export type { WorkerDrainResult, WorkerPollerHandle } from './worker-polling.js';

export const VALID_AGENT_MODULES: readonly string[] = Object.freeze(['support', 'sales', 'marketing']);

/**
 * The channel and event types a brokered handoff is admitted on (plans/customer-lifecycle.md §3).
 *
 * `ORCHESTRATOR_HANDOFF` is an INTERNAL channel: it is never a customer-facing channel, and no
 * external ingestion route admits it. The broker writes it into the target run's signal after the
 * durable admission of the handoff, so only the orchestrator can produce a run that carries it.
 */
export const CROSS_DOMAIN_HANDOFF_CHANNEL = 'ORCHESTRATOR_HANDOFF';

/** Canonical event type of one journey edge, keyed by the edge's target domain and leg. */
export const CROSS_DOMAIN_HANDOFF_EVENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  marketing_to_sales: 'handoff.marketing_to_sales',
  sales_to_care: 'handoff.sales_to_care',
  care_to_retention: 'handoff.care_to_retention',
});

export const CARE_SIGNAL_CONTRACT: DomainSignalContract = Object.freeze({
  module: 'support',
  source_channels: Object.freeze(['WEB_CHAT', CROSS_DOMAIN_HANDOFF_CHANNEL]),
  event_types: Object.freeze([
    'message.received',
    CROSS_DOMAIN_HANDOFF_EVENT_TYPES['sales_to_care'] as string,
    CROSS_DOMAIN_HANDOFF_EVENT_TYPES['care_to_retention'] as string,
  ]),
  signal_invalid_code: 'CARE_SIGNAL_INVALID',
});


export function parseEnabledAgentModules(raw?: string): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) {
    return Object.freeze(['support']);
  }
  const parts = raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  for (const part of parts) {
    if (!VALID_AGENT_MODULES.includes(part)) {
      throw new Error(
        `ENABLED_AGENT_MODULES_INVALID: unknown module '${part}'. Valid modules are ${VALID_AGENT_MODULES.join(', ')}`,
      );
    }
  }
  return Object.freeze([...new Set(parts)]);
}
/**
 * Workspace packages this worker is allowed to depend on (02 §2 dependency DAG).
 */
export const DEPENDENCIES: readonly string[] = [
  coreEnginePackageName,
  skillsPackageName,
  adaptersPackageName,
  databasePackageName,
];
const RESUME_EVENT_TYPES = new Set([
  'human.approval',
  'human.modify',
  'human.reject',
  'human.pause',
  'human.cancel',
  'human.reconcile',
  'timer.expired',
  'reconcile.completed',
  'human.handoff.evidence',
  // Cross-domain journey resume events (implement/04 §8, plans/customer-lifecycle.md §3).
  // A task resumed with a handoff event must be admitted here; without these entries the worker
  // calls recordFailure(RESUME_EVENT_INVALID) and the entire cross-domain journey is blocked.
  'handoff.marketing_to_sales',
  'handoff.sales_to_care',
  'handoff.care_to_retention',
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasResumeEvent(value: unknown): boolean {
  const record = asRecord(value);
  return record !== null && asRecord(record['resume_event']) !== null;
}



export interface WorkerHandle {
  readonly dependencies: readonly string[];
  /** Connector ids reachable from this process, and the capabilities it does not bind. */
  readonly connectors: {
    readonly bound: readonly string[];
    readonly unbound: readonly string[];
  };
  readonly poller?: WorkerPollerHandle;
  readonly blockers?: readonly string[];
  readonly registry?: DomainRuntimeRegistry;
  /**
   * Sends one already-authorized action draft to its `adapter_target` ({@link DEPENDENCIES}).
   *
   * Effect reservation and settlement stay with the caller (`04` §4.4): this door reports what the
   * provider said and refuses an unregistered target before any socket opens.
   *
   * @param draft Immutable draft produced by the orchestrator's dispatch guard.
   * @returns The provider receipt.
   */
  dispatchAction(draft: ActionDraft): Promise<ExecutionReceipt>;
  close(): Promise<WorkerDrainResult>;
}

export interface WorkerEnv extends WorkerConnectorEnv {
  readonly ENABLED_AGENT_MODULES?: string;
  readonly SALES_SIGNAL_SOURCE_CHANNELS?: string;
  readonly SALES_SIGNAL_EVENT_TYPES?: string;
  readonly MARKETING_SIGNAL_SOURCE_CHANNELS?: string;
  readonly MARKETING_SIGNAL_EVENT_TYPES?: string;
  readonly AUDIT_HMAC_SECRET?: string;
  readonly DEMO_MODE?: string;
  readonly DATABASE_URL?: string;
  readonly WORKER_TENANT_CONCURRENCY?: string;
  readonly WORKER_DRAIN_TIMEOUT_MS?: string;
  /**
   * Enables the brokered cross-domain journey (`marketing → sales → care → retention`). Absent or
   * not `true`, no broker is bound and a plan that declares a handoff refuses
   * (`HANDOFF_BROKER_UNBOUND`) — a default deployment never admits a cross-domain run.
   */
  readonly CROSS_DOMAIN_JOURNEY_ENABLED?: string;
}

export interface WorkerExecutionOptions extends WorkerConnectorOptions {
  readonly workerId?: string;
  readonly tenantIds?: readonly string[];
  /** Durable database binding used to admit persisted autonomy policies. */
  readonly databaseRunner?: TenantTransactionRunner;
  /** Optional autonomy admission override; no in-memory store is created by the worker. */
  readonly autonomy?: AutonomyAdmissionPort;
  readonly workflowRepository?: Pick<DurableWorkflowRepository,
    'claimNextQueuedTask' | 'getTask' | 'renewTaskLease' | 'releaseTaskLease' | 'recordFailure' | 'transitionTask'>;
  readonly orchestratorFactory?: (tenant_id: string) => Promise<RevenueOrchestrator | null> | RevenueOrchestrator | null;
  readonly salesOrchestratorFactory?: (tenant_id: string) => Promise<RevenueOrchestrator | null> | RevenueOrchestrator | null;
  readonly marketingOrchestratorFactory?: (tenant_id: string) => Promise<RevenueOrchestrator | null> | RevenueOrchestrator | null;
  readonly marketingFactoryOptions?: MarketingOrchestratorFactoryOptions;
  readonly domainRegistry?: DomainRuntimeRegistry;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly tenantConcurrency?: number;
  readonly drainTimeoutMs?: number;
  readonly now?: () => Date;
  readonly setTimeout?: (handler: () => void, timeout: number) => NodeJS.Timeout;
  readonly clearTimeout?: (handle: NodeJS.Timeout) => void;
  readonly autoStartPolling?: boolean;
  /** Explicit admission from the process readiness gate; absent means polling stays disabled. */
  readonly readiness?: boolean;
  readonly onError?: (tenant_id: string, error: unknown) => void;
  readonly careFactoryOptions?: CareOrchestratorFactoryOptions;
  readonly salesFactoryOptions?: SalesOrchestratorFactoryOptions;
  /** The brokered handoff binding; when supplied it overrides the env-gated default broker. */
  readonly crossDomainHandoff?: ICrossDomainHandoffBroker;
  /** Persistence the broker reads the durable journey from; defaults to the real repository. */
  readonly handoffRepository?: { readCrossDomainLifecycle: typeof readCrossDomainLifecycle };
}

function parsePositiveWorkerInteger(raw: string | undefined, name: string, defaultValue: number): number {
  if (raw === undefined) return defaultValue;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name}_INVALID: ${name} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name}_INVALID: ${name} must be a positive integer`);
  }
  return parsed;
}
/**
 * Releases a task only while this worker still owns the lease. Event-bearing parked tasks retain
 * their state and resume event; a consumed resume event may explicitly release its parked lease.
 */
export async function releaseLeaseIfHeld(
  workflowRepository: Pick<DurableWorkflowRepository, 'getTask' | 'releaseTaskLease'>,
  tenant_id: string,
  run_id: string,
  worker_id: string,
  releaseParkedWithoutEvent = false,
): Promise<boolean> {
  const task = await workflowRepository.getTask(tenant_id, run_id);
  if (!task || task.lease_owner !== worker_id) return false;
  const eventBearing = hasResumeEvent(task.state_payload);
  const parked = task.state === 'waiting' || task.state === 'awaiting_human';
  if (task.state !== 'running' && !(eventBearing && parked) && !(releaseParkedWithoutEvent && parked)) {
    return false;
  }
  const targetState = task.state === 'awaiting_human'
    ? 'awaiting_human'
    : task.state === 'waiting'
      ? 'waiting'
      : 'queued';
  try {
    await workflowRepository.releaseTaskLease({
      tenant_id,
      run_id,
      lease_owner: worker_id,
      task_version: task.task_version,
      target_state: targetState,
    });
    return true;
  } catch (error) {
    if (error instanceof Error && /TASK_VERSION_CONFLICT|TASK_LEASE_NOT_HELD/.test(error.message)) {
      return false;
    }
    throw error;
  }
}

/**
 * Executes a single claimed durable task under the worker lease.
 * Resume events are consumed before generic mutating-action recovery; the event is the authoritative
 * handoff that decides whether approval or reconciliation may continue.
 */
export async function processClaimedTask(params: {
  taskRecord: DurableTaskRecord;
  tenant_id: string;
  worker_id: string;
  workflowRepository: Pick<DurableWorkflowRepository, 'getTask' | 'releaseTaskLease' | 'recordFailure' | 'transitionTask'>;
  orchestratorFactory?: (tenant_id: string) => Promise<RevenueOrchestrator | null> | RevenueOrchestrator | null;
  registry?: DomainRuntimeRegistry | undefined;
  signal?: AbortSignal | undefined;
}): Promise<void> {
  const { taskRecord, tenant_id, worker_id, workflowRepository, orchestratorFactory, signal: abortSignal } = params;
  const hadResumeEvent = hasResumeEvent(taskRecord.state_payload);
  const parkedWithoutResumeEvent =
    (taskRecord.state === 'waiting' || taskRecord.state === 'awaiting_human') && !hadResumeEvent;

  const registry = params.registry ?? (
    orchestratorFactory
      ? createDomainRuntimeRegistry([{
          contract: CARE_SIGNAL_CONTRACT,
          createOrchestrator: orchestratorFactory,
        }])
      : createDomainRuntimeRegistry([])
  );

  try {
    // Repository claims should already exclude parked rows without a resume event. Keep the worker
    // fail-closed if a stale/misbehaving claim crosses that boundary: parked progress is resumed only
    // by its durable handoff event, never by replaying the original signal.
    if (parkedWithoutResumeEvent) {
      return;
    }
    abortSignal?.throwIfAborted();
    const payload = taskRecord.state_payload;
    const record = asRecord(payload);
    const resumeEventValue = record?.['resume_event'];
    if (resumeEventValue !== undefined) {
      const resumeEvent = asRecord(resumeEventValue);
      const eventType = resumeEvent?.['event_type'];
      if (
        resumeEvent === null
        || resumeEvent['tenant_id'] !== tenant_id
        || typeof eventType !== 'string'
        || !RESUME_EVENT_TYPES.has(eventType)
      ) {
        await workflowRepository.recordFailure({
          tenant_id,
          run_id: taskRecord.run_id,
          error_class: 'FATAL',
          error_details: { code: 'RESUME_EVENT_INVALID' },
          expected_task_version: taskRecord.task_version,
          lease_owner: worker_id,
        });
        return;
      }

      const checkpoint = { ...record };
      delete checkpoint['resume_event'];
      try {
        assertCompleteCheckpoint(checkpoint);
      } catch {
        await workflowRepository.recordFailure({
          tenant_id,
          run_id: taskRecord.run_id,
          error_class: 'FATAL',
          error_details: { code: 'CHECKPOINT_INCOMPLETE' },
          expected_task_version: taskRecord.task_version,
          lease_owner: worker_id,
        });
        return;
      }

      const signal = record?.['signal'];
      const signalRecord = asRecord(signal);
      const signalPayload = asRecord(signalRecord?.['payload']);
      const moduleName = typeof signalPayload?.['module'] === 'string'
        ? signalPayload['module']
        : null;

      if (!moduleName) {
        await workflowRepository.recordFailure({
          tenant_id,
          run_id: taskRecord.run_id,
          error_class: 'FATAL',
          error_details: { code: 'CARE_SIGNAL_INVALID' },
          expected_task_version: taskRecord.task_version,
          lease_owner: worker_id,
        });
        return;
      }

      const binding = registry.resolve(moduleName);
      if (!binding) {
        await workflowRepository.recordFailure({
          tenant_id,
          run_id: taskRecord.run_id,
          error_class: 'FATAL',
          error_details: {
            code: 'CAPABILITY_NOT_ENABLED',
            module: moduleName,
            message: `module '${moduleName}' is not enabled`,
          },
          expected_task_version: taskRecord.task_version,
          lease_owner: worker_id,
        });
        return;
      }

      const orchestrator = await binding.createOrchestrator(tenant_id);
      if (!orchestrator) {
        const unboundCode = binding.contract.module === 'support'
          ? 'CARE_ORCHESTRATOR_UNBOUND'
          : `${binding.contract.module.toUpperCase()}_ORCHESTRATOR_UNBOUND`;
        await workflowRepository.recordFailure({
          tenant_id,
          run_id: taskRecord.run_id,
          error_class: 'FATAL',
          error_details: { code: unboundCode },
          expected_task_version: taskRecord.task_version,
          lease_owner: worker_id,
        });
        return;
      }

      abortSignal?.throwIfAborted();
      await orchestrator.resumeTask(taskRecord.run_id, resumeEvent as never);
      abortSignal?.throwIfAborted();
      return;
    }

    const pending = record?.['pending_action'] ?? null;
    if (typeof pending === 'object' && pending !== null && !Array.isArray(pending)
      && 'mutating' in pending && pending.mutating === true) {
      await workflowRepository.transitionTask(tenant_id, taskRecord.run_id, 'waiting',
        'EFFECT_UNKNOWN: reclaimed mutating action requires provider reconciliation',
        payload, { expected_task_version: taskRecord.task_version, lease_owner: worker_id });
      return;
    }

    const signal = record?.['signal'];
    const signalRecord = asRecord(signal);
    const signalPayload = asRecord(signalRecord?.['payload']);

    if (signalPayload !== null && typeof signalPayload['module'] === 'string') {
      const moduleName = signalPayload['module'];
      const binding = registry.resolve(moduleName);
      if (!binding) {
        await workflowRepository.recordFailure({
          tenant_id,
          run_id: taskRecord.run_id,
          error_class: 'FATAL',
          error_details: {
            code: 'CAPABILITY_NOT_ENABLED',
            module: moduleName,
            message: `module '${moduleName}' is not enabled`,
          },
          expected_task_version: taskRecord.task_version,
          lease_owner: worker_id,
        });
        return;
      }

      const accepted = registry.accepts(signal, { tenant_id, correlation_id: taskRecord.correlation_id });
      if (!accepted) {
        await workflowRepository.recordFailure({
          tenant_id,
          run_id: taskRecord.run_id,
          error_class: 'FATAL',
          error_details: { code: binding.contract.signal_invalid_code },
          expected_task_version: taskRecord.task_version,
          lease_owner: worker_id,
        });
        return;
      }

      const orchestrator = await accepted.createOrchestrator(tenant_id);
      if (!orchestrator) {
        const unboundCode = binding.contract.module === 'support'
          ? 'CARE_ORCHESTRATOR_UNBOUND'
          : `${binding.contract.module.toUpperCase()}_ORCHESTRATOR_UNBOUND`;
        await workflowRepository.recordFailure({
          tenant_id,
          run_id: taskRecord.run_id,
          error_class: 'FATAL',
          error_details: { code: unboundCode },
          expected_task_version: taskRecord.task_version,
          lease_owner: worker_id,
        });
        return;
      }

      abortSignal?.throwIfAborted();
      await orchestrator.processQueuedSignal(taskRecord.run_id, signal as SignalEnvelope, { worker_id });
      abortSignal?.throwIfAborted();
      return;
    }

    // Malformed signal without module field fails with CARE_SIGNAL_INVALID
    await workflowRepository.recordFailure({
      tenant_id,
      run_id: taskRecord.run_id,
      error_class: 'FATAL',
      error_details: { code: 'CARE_SIGNAL_INVALID' },
      expected_task_version: taskRecord.task_version,
      lease_owner: worker_id,
    });
  } finally {
    if (!abortSignal?.aborted) {
      const current = await workflowRepository.getTask(tenant_id, taskRecord.run_id);
      if (!abortSignal?.aborted) {
        const currentPayload = asRecord(current?.state_payload);
        const currentPending = currentPayload?.['pending_action'];
        if (
          hadResumeEvent
          || hasResumeEvent(current?.state_payload)
          || !(currentPending && typeof currentPending === 'object' && !Array.isArray(currentPending)
            && 'mutating' in currentPending && currentPending.mutating === true)
        ) {
          await releaseLeaseIfHeld(
            workflowRepository,
            tenant_id,
            taskRecord.run_id,
            worker_id,
            hadResumeEvent || parkedWithoutResumeEvent,
          );
        }
      }
    }
  }
}

/**
 * Starts the durable worker.
 * Binds connectors, tenant-scoped durable PostgreSQL task polling, and fail-closed checks.
 */
export function startWorker(
  env: WorkerEnv = process.env,
  options: WorkerExecutionOptions = { hmac: nodeHmacSha256Hex },
): WorkerHandle {
  const configuredTenantConcurrency = parsePositiveWorkerInteger(
    env.WORKER_TENANT_CONCURRENCY,
    'WORKER_TENANT_CONCURRENCY',
    2,
  );
  const configuredDrainTimeoutMs = parsePositiveWorkerInteger(
    env.WORKER_DRAIN_TIMEOUT_MS,
    'WORKER_DRAIN_TIMEOUT_MS',
    25_000,
  );
  const tenantConcurrency = options.tenantConcurrency ?? configuredTenantConcurrency;
  const drainTimeoutMs = options.drainTimeoutMs ?? configuredDrainTimeoutMs;
  const connectors = createWorkerConnectors(env, options);
  const workerId = options.workerId ?? `worker_${randomUUID().slice(0, 8)}`;
  const blockers: string[] = [];

  // Polling scope is independent of the knowledge corpus tenant allowlist.
  const rawTenants = options.tenantIds ?? (
    typeof env.WORKER_TENANT_IDS === 'string'
      ? env.WORKER_TENANT_IDS.split(',').map((id) => id.trim()).filter(Boolean)
      : []
  );

  const tenantIds = [...rawTenants];
  // The tenant identifier is a `uuid` column, so the check is the generic UUID shape. The RFC 4122
  // version/variant nibbles are deliberately not required: the pilot's synthetic tenant
  // (`11111111-1111-1111-1111-111111111111`) is a real row in the fixtures, and rejecting it here
  // would refuse the registered tenant rather than an unregistered one.
  if (tenantIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error('WORKER_TENANT_IDS_INVALID: expected comma-separated tenant UUIDs');
  }
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const leaseDurationMs = options.leaseDurationMs ?? 30000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1
    || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new Error('WORKER_POLL_CONFIG_INVALID: polling interval and lease duration must be positive integers');
  }

  const workflowRepository = options.workflowRepository ?? new DurableWorkflowRepository();
  const autonomy = createDatabaseAutonomy({
    databaseRunner: options.databaseRunner,
    databaseUrl: env.DATABASE_URL,
    autonomy: options.autonomy,
  });

  // The brokered journey is opt-in and fail-closed: without an explicit `true` no broker is bound,
  // so a plan that declares a handoff refuses rather than admitting a cross-domain run.
  const crossDomainHandoff: ICrossDomainHandoffBroker | undefined = options.crossDomainHandoff
    ?? (env.CROSS_DOMAIN_JOURNEY_ENABLED === 'true'
      ? createCrossDomainHandoffBroker({
          handoffRepository: options.handoffRepository ?? { readCrossDomainLifecycle },
        })
      : undefined);

  const careFactoryOptions: CareOrchestratorFactoryOptions = options.careFactoryOptions === undefined
    ? {
        workerId,
        workflowRepository: workflowRepository as DurableWorkflowRepository,
        // The connector's own read surface, or `null` when no system of record is bound — in which
        // case the order skill refuses at dispatch instead of the worker substituting a cached value.
        erp_read: connectors.erp_read,
        env,
        ...(crossDomainHandoff === undefined ? {} : { crossDomainHandoff }),
        ...(autonomy === undefined ? {} : { autonomy }),
      }
    : {
        // A caller-supplied options object is the documented injection seam, so the broker is
        // merged into it unless the caller bound one itself — otherwise enabling the journey would
        // silently do nothing on that path.
        ...options.careFactoryOptions,
        ...(options.careFactoryOptions.crossDomainHandoff !== undefined || crossDomainHandoff === undefined
          ? {}
          : { crossDomainHandoff }),
        ...(options.careFactoryOptions.autonomy !== undefined || autonomy === undefined
          ? {}
          : { autonomy }),
      };

  const enabledModules = parseEnabledAgentModules(env.ENABLED_AGENT_MODULES);
  const bindings = createWorkerDomainBindings({
    env,
    workerId,
    workflowRepository,
    connectors,
    enabledModules,
    blockers,
    autonomy,
    crossDomainHandoff,
    careSignalContract: CARE_SIGNAL_CONTRACT,
    crossDomainHandoffChannel: CROSS_DOMAIN_HANDOFF_CHANNEL,
    crossDomainHandoffEventTypes: CROSS_DOMAIN_HANDOFF_EVENT_TYPES,
    marketingSignalContractDefaults: MARKETING_SIGNAL_CONTRACT_DEFAULTS,
    careFactoryOptions,
    orchestratorFactory: options.orchestratorFactory,
    salesOrchestratorFactory: options.salesOrchestratorFactory,
    salesFactoryOptions: options.salesFactoryOptions,
    marketingOrchestratorFactory: options.marketingOrchestratorFactory,
    marketingFactoryOptions: options.marketingFactoryOptions,
  });
  const registry = options.domainRegistry ?? createDomainRuntimeRegistry(bindings);

  if (tenantIds.length === 0) {
    blockers.push('WORKER_TENANT_IDS_EMPTY: No tenants configured; background polling disabled (fail closed).');
  }
  const autoStartPolling = options.autoStartPolling ?? true;
  const readiness = options.readiness === true;
  if (autoStartPolling && !readiness) {
    blockers.push('WORKER_READINESS_REQUIRED: readiness gate has not admitted background polling.');
  }
  const poller = createWorkerPoller({
    tenantIds,
    registry,
    workflowRepository,
    workerId,
    leaseDurationMs,
    pollIntervalMs,
    tenantConcurrency,
    drainTimeoutMs,
    readiness,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.setTimeout === undefined ? {} : { setTimeout: options.setTimeout }),
    ...(options.clearTimeout === undefined ? {} : { clearTimeout: options.clearTimeout }),
    autoStartPolling,
    onError: options.onError,
    processTask: ({ taskRecord, tenant_id, signal }) => processClaimedTask({
      taskRecord,
      tenant_id,
      worker_id: workerId,
      workflowRepository,
      registry,
      signal,
    }),
  });


  return {
    dependencies: [...DEPENDENCIES],
    connectors: { bound: connectors.bound, unbound: connectors.unbound },
    poller,
    blockers: Object.freeze(blockers),
    registry,
    dispatchAction: (draft) => connectors.dispatcher.dispatch(draft),
    close: () => poller.stop(),
  };


}
