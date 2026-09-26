import { randomUUID } from 'node:crypto';
import { packageName as adaptersPackageName } from '@agentos/adapters';
import { packageName as coreEnginePackageName, RevenueOrchestrator } from '@agentos/core-engine';
import {
  packageName as databasePackageName,
  DurableWorkflowRepository,
  assertCompleteCheckpoint,
  type DurableTaskRecord,
} from '@agentos/database';
import { packageName as skillsPackageName } from '@agentos/skills';
import type { ActionDraft, ExecutionReceipt, SignalEnvelope } from '@agentos/core-engine/contracts';

import { createWorkerConnectors, type WorkerConnectorEnv, type WorkerConnectorOptions } from './runtime/connectors.js';
import { nodeHmacSha256Hex } from './runtime/hmac.js';

import {
  createCareOrchestratorFactory,
  getUnboundCapabilities,
  type CareOrchestratorFactoryOptions,
} from './runtime/care/index.js';
import {
  createSalesOrchestratorFactory,
  getSalesUnboundCapabilities,
  type SalesOrchestratorFactoryOptions,
} from './runtime/sales/index.js';
import {
  createDomainRuntimeRegistry,
  type DomainRuntimeBinding,
  type DomainRuntimeRegistry,
  type DomainSignalContract,
} from './runtime/domain-registry.js';
import {
  createMarketingOrchestratorFactory,
  MARKETING_SIGNAL_CONTRACT_DEFAULTS,
  type MarketingOrchestratorFactoryOptions,
} from './runtime/marketing/factory.js';

export const VALID_AGENT_MODULES: readonly string[] = Object.freeze(['support', 'sales', 'marketing']);

export const CARE_SIGNAL_CONTRACT: DomainSignalContract = Object.freeze({
  module: 'support',
  source_channels: Object.freeze(['WEB_CHAT']),
  event_types: Object.freeze(['message.received']),
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

export interface WorkerPollerHandle {
  readonly isRunning: boolean;
  stop(): Promise<void>;
  pollOnce(): Promise<number>;
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
  close(): Promise<void>;
}

export interface WorkerEnv extends WorkerConnectorEnv {
  readonly ENABLED_AGENT_MODULES?: string;
  readonly SALES_SIGNAL_SOURCE_CHANNELS?: string;
  readonly SALES_SIGNAL_EVENT_TYPES?: string;
  readonly MARKETING_SIGNAL_SOURCE_CHANNELS?: string;
  readonly MARKETING_SIGNAL_EVENT_TYPES?: string;
  readonly AUDIT_HMAC_SECRET?: string;
}

export interface WorkerExecutionOptions extends WorkerConnectorOptions {
  readonly workerId?: string;
  readonly tenantIds?: readonly string[];
  readonly workflowRepository?: Pick<DurableWorkflowRepository,
    'claimNextQueuedTask' | 'getTask' | 'releaseTaskLease' | 'recordFailure' | 'transitionTask'>;
  readonly orchestratorFactory?: (tenant_id: string) => Promise<RevenueOrchestrator | null> | RevenueOrchestrator | null;
  readonly salesOrchestratorFactory?: (tenant_id: string) => Promise<RevenueOrchestrator | null> | RevenueOrchestrator | null;
  readonly marketingOrchestratorFactory?: (tenant_id: string) => Promise<RevenueOrchestrator | null> | RevenueOrchestrator | null;
  readonly marketingFactoryOptions?: MarketingOrchestratorFactoryOptions;
  readonly domainRegistry?: DomainRuntimeRegistry;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly autoStartPolling?: boolean;
  readonly onError?: (tenant_id: string, error: unknown) => void;
  readonly careFactoryOptions?: CareOrchestratorFactoryOptions;
  readonly salesFactoryOptions?: SalesOrchestratorFactoryOptions;
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
}): Promise<void> {
  const { taskRecord, tenant_id, worker_id, workflowRepository, orchestratorFactory } = params;
  const hadResumeEvent = hasResumeEvent(taskRecord.state_payload);

  const registry = params.registry ?? (
    orchestratorFactory
      ? createDomainRuntimeRegistry([{
          contract: CARE_SIGNAL_CONTRACT,
          createOrchestrator: orchestratorFactory,
        }])
      : createDomainRuntimeRegistry([])
  );

  try {
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
          lease_owner: worker_id,
        });
        return;
      }

      await orchestrator.resumeTask(taskRecord.run_id, resumeEvent as never);
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
          lease_owner: worker_id,
        });
        return;
      }

      await orchestrator.processQueuedSignal(taskRecord.run_id, signal as SignalEnvelope, { worker_id });
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
    const current = await workflowRepository.getTask(tenant_id, taskRecord.run_id);
    const currentPayload = asRecord(current?.state_payload);
    const currentPending = currentPayload?.['pending_action'];
    if (
      hadResumeEvent
      || hasResumeEvent(current?.state_payload)
      || !(currentPending && typeof currentPending === 'object' && !Array.isArray(currentPending)
        && 'mutating' in currentPending && currentPending.mutating === true)
    ) {
      await releaseLeaseIfHeld(workflowRepository, tenant_id, taskRecord.run_id, worker_id, hadResumeEvent);
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
  const connectors = createWorkerConnectors(env, options);
  const workerId = options.workerId ?? `worker_${randomUUID().slice(0, 8)}`;
  const blockers: string[] = [];

  // Parse tenant scope: explicit options or CARE_TENANT_IDS environment variable
  const rawTenants = options.tenantIds ?? (
    typeof env.CARE_TENANT_IDS === 'string'
      ? env.CARE_TENANT_IDS.split(',').map((id) => id.trim()).filter(Boolean)
      : []
  );

  const tenantIds = [...rawTenants];
  // The tenant identifier is a `uuid` column, so the check is the generic UUID shape. The RFC 4122
  // version/variant nibbles are deliberately not required: the pilot's synthetic tenant
  // (`11111111-1111-1111-1111-111111111111`) is a real row in the fixtures, and rejecting it here
  // would refuse the registered tenant rather than an unregistered one.
  if (tenantIds.some((id) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error('CARE_TENANT_IDS_INVALID: expected comma-separated tenant UUIDs');
  }
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const leaseDurationMs = options.leaseDurationMs ?? 30000;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1
    || !Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 1) {
    throw new Error('CARE_POLL_CONFIG_INVALID: polling interval and lease duration must be positive integers');
  }

  const workflowRepository = options.workflowRepository ?? new DurableWorkflowRepository();
  const careFactoryOptions: CareOrchestratorFactoryOptions = options.careFactoryOptions ?? {
    workerId,
    workflowRepository: workflowRepository as DurableWorkflowRepository,
    // The connector's own read surface, or `null` when no system of record is bound — in which
    // case the order skill refuses at dispatch instead of the worker substituting a cached value.
    erp_read: connectors.erp_read,
    env,
  };

  const enabledModules = parseEnabledAgentModules(env.ENABLED_AGENT_MODULES);
  const bindings: DomainRuntimeBinding[] = [];

  let careOrchestratorFactory: ((tenant_id: string) => Promise<RevenueOrchestrator | null> | RevenueOrchestrator | null) | null = null;
  if (enabledModules.includes('support')) {
    const unboundCapabilities = getUnboundCapabilities(careFactoryOptions);
    for (const cap of unboundCapabilities) {
      blockers.push(`CARE_CAPABILITY_UNBOUND: ${cap}`);
    }

    const careFactory = unboundCapabilities.length === 0
      ? createCareOrchestratorFactory(careFactoryOptions)
      : null;

    careOrchestratorFactory = options.orchestratorFactory ?? careFactory;

    if (!careOrchestratorFactory) {
      blockers.push('CARE_ORCHESTRATOR_UNBOUND: No authentic Customer Care RevenueOrchestrator factory provided (fail closed).');
    } else {
      bindings.push({
        contract: CARE_SIGNAL_CONTRACT,
        createOrchestrator: careOrchestratorFactory,
      });
    }
  }

  if (enabledModules.includes('sales')) {
    const rawChannels = env.SALES_SIGNAL_SOURCE_CHANNELS;
    const rawEventTypes = env.SALES_SIGNAL_EVENT_TYPES;
    const salesChannels = rawChannels ? rawChannels.split(',').map((c) => c.trim()).filter(Boolean) : [];
    const salesEventTypes = rawEventTypes ? rawEventTypes.split(',').map((e) => e.trim()).filter(Boolean) : [];

    if (salesChannels.length === 0 || salesEventTypes.length === 0) {
      blockers.push('SALES_CAPABILITY_UNBOUND: SALES_SIGNAL_SOURCE_CHANNELS and SALES_SIGNAL_EVENT_TYPES must be configured and non-empty');
    } else {
      const salesFactoryOptions: SalesOrchestratorFactoryOptions = options.salesFactoryOptions ?? {
        workerId,
        workflowRepository: workflowRepository as DurableWorkflowRepository,
        erp_read: connectors.erp_read,
      };

      // Reported, never used to suppress the domain: a deployment that binds only the read
      // connectors still serves catalog/stock/customer reads and refuses each mutation at
      // dispatch. The default factory is built only when no injected factory already covers it,
      // so a supplied factory never forces construction of a graph the caller replaced.
      const salesUnboundCapabilities = getSalesUnboundCapabilities(salesFactoryOptions);
      for (const cap of salesUnboundCapabilities) {
        blockers.push(`SALES_CAPABILITY_UNBOUND: ${cap}`);
      }

      const salesFactory = options.salesOrchestratorFactory
        ? null
        : createSalesOrchestratorFactory(salesFactoryOptions);
      const salesOrchestratorFactory = options.salesOrchestratorFactory ?? salesFactory;

      if (!salesOrchestratorFactory) {
        blockers.push('SALES_ORCHESTRATOR_UNBOUND: No authentic Sales RevenueOrchestrator factory provided (fail closed).');
      } else {
        bindings.push({
          contract: {
            module: 'sales',
            source_channels: Object.freeze(salesChannels),
            event_types: Object.freeze(salesEventTypes),
            signal_invalid_code: 'SALES_SIGNAL_INVALID',
          },
          createOrchestrator: salesOrchestratorFactory,
        });
      }
    }
  }

  if (enabledModules.includes('marketing')) {
    const marketingChannels = env.MARKETING_SIGNAL_SOURCE_CHANNELS
      ? env.MARKETING_SIGNAL_SOURCE_CHANNELS.split(',').map((value) => value.trim()).filter(Boolean)
      : [...MARKETING_SIGNAL_CONTRACT_DEFAULTS.source_channels];
    const marketingEventTypes = env.MARKETING_SIGNAL_EVENT_TYPES
      ? env.MARKETING_SIGNAL_EVENT_TYPES.split(',').map((value) => value.trim()).filter(Boolean)
      : [...MARKETING_SIGNAL_CONTRACT_DEFAULTS.event_types];

    let marketingFactory = options.marketingOrchestratorFactory;
    if (!marketingFactory) {
      try {
        marketingFactory = createMarketingOrchestratorFactory({
          ...(options.marketingFactoryOptions ?? {}),
          workerId,
          workflowRepository: options.marketingFactoryOptions?.workflowRepository ?? workflowRepository as DurableWorkflowRepository,
          ...(env.AUDIT_HMAC_SECRET === undefined ? {} : { auditSecret: env.AUDIT_HMAC_SECRET }),
        });
      } catch (error) {
        blockers.push('MARKETING_ORCHESTRATOR_UNBOUND: ' + (error instanceof Error ? error.message : String(error)));
      }
    }

    if (marketingFactory) {
      bindings.push({
        contract: {
          module: 'marketing',
          source_channels: Object.freeze(marketingChannels),
          event_types: Object.freeze(marketingEventTypes),
          signal_invalid_code: 'MARKETING_SIGNAL_INVALID',
        },
        createOrchestrator: marketingFactory,
      });
    }
  }

  const registry = options.domainRegistry ?? createDomainRuntimeRegistry(bindings);

  if (tenantIds.length === 0) {
    blockers.push('CARE_TENANT_IDS_EMPTY: No tenants configured; background polling disabled (fail closed).');
  }
  let running = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let activePollCount = 0;

  const pollOnce = async (): Promise<number> => {
    if (tenantIds.length === 0 || registry.modules().length === 0) return 0;
    let claimedCount = 0;

    for (const tenant_id of tenantIds) {
      try {
        const claimResult = await workflowRepository.claimNextQueuedTask({
          tenant_id,
          lease_owner: workerId,
          lease_duration_ms: leaseDurationMs,
        });

        if (claimResult) {
          claimedCount++;
          await processClaimedTask({
            taskRecord: claimResult.task,
            tenant_id,
            worker_id: workerId,
            workflowRepository,
            registry,
          });
        }
      } catch (error) {
        if (options.onError) options.onError(tenant_id, error);
        else process.stderr.write(`care worker tenant ${tenant_id} failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }

    return claimedCount;
  };

  const scheduleNext = () => {
    if (!running) return;
    pollTimer = setTimeout(() => {
      activePollCount++;
      void pollOnce().catch((error: unknown) => {
        process.stderr.write(`care worker poll failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }).finally(() => {
        activePollCount--;
        scheduleNext();
      });
    }, pollIntervalMs);
  };

  const shouldAutoStart = options.autoStartPolling ?? true;
  if (shouldAutoStart && tenantIds.length > 0 && registry.modules().length > 0) {
    running = true;
    scheduleNext();
  }

  const poller: WorkerPollerHandle = {
    get isRunning() {
      return running;
    },
    async stop() {
      running = false;
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      // Wait for any in-flight poll to finish
      while (activePollCount > 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    },
    pollOnce,
  };

  return {
    dependencies: [...DEPENDENCIES],
    connectors: { bound: connectors.bound, unbound: connectors.unbound },
    poller,
    blockers: Object.freeze(blockers),
    registry,
    dispatchAction: (draft) => connectors.dispatcher.dispatch(draft),
    async close(): Promise<void> {
      await poller.stop();
    },
  };
}
