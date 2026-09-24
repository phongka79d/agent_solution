import { randomUUID } from 'node:crypto';
import { packageName as adaptersPackageName } from '@agentos/adapters';
import { packageName as coreEnginePackageName, RevenueOrchestrator } from '@agentos/core-engine';
import {
  packageName as databasePackageName,
  DurableWorkflowRepository,
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
/**
 * Workspace packages this worker is allowed to depend on (02 §2 dependency DAG).
 */
export const DEPENDENCIES: readonly string[] = [
  coreEnginePackageName,
  skillsPackageName,
  adaptersPackageName,
  databasePackageName,
];

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

export interface WorkerExecutionOptions extends WorkerConnectorOptions {
  readonly workerId?: string;
  readonly tenantIds?: readonly string[];
  readonly workflowRepository?: Pick<DurableWorkflowRepository,
    'claimNextQueuedTask' | 'getTask' | 'releaseTaskLease' | 'recordFailure' | 'transitionTask'>;
  readonly orchestratorFactory?: (tenant_id: string) => Promise<RevenueOrchestrator | null> | RevenueOrchestrator | null;
  readonly pollIntervalMs?: number;
  readonly leaseDurationMs?: number;
  readonly autoStartPolling?: boolean;
  readonly onError?: (tenant_id: string, error: unknown) => void;
  readonly careFactoryOptions?: CareOrchestratorFactoryOptions;
}

/**
 * Releases a running task only while this worker still owns the lease. Closed and parked tasks
 * remain untouched; a concurrent change is resolved by the repository's version guard.
 */
export async function releaseLeaseIfHeld(
  workflowRepository: Pick<DurableWorkflowRepository, 'getTask' | 'releaseTaskLease'>,
  tenant_id: string,
  run_id: string,
  worker_id: string
): Promise<boolean> {
  const task = await workflowRepository.getTask(tenant_id, run_id);
  if (!task || task.lease_owner !== worker_id || task.state !== 'running') return false;
  try {
    await workflowRepository.releaseTaskLease({
      tenant_id,
      run_id,
      lease_owner: worker_id,
      task_version: task.task_version,
      target_state: 'queued',
    });
    return true;
  } catch (error) {
    if (error instanceof Error && /TASK_VERSION_CONFLICT|TASK_LEASE_NOT_HELD/.test(error.message)) {
      return false;
    }
    throw error;
  }
}

function isCompleteCheckpoint(payload: Record<string, unknown>): boolean {
  const target: Record<string, unknown> = ('checkpoint' in payload && payload.checkpoint && typeof payload.checkpoint === 'object' && !Array.isArray(payload.checkpoint))
    ? (payload.checkpoint as Record<string, unknown>)
    : payload;

  const plan = target.plan;
  const hasPlan = typeof plan === 'object' && plan !== null && 'steps' in plan && Array.isArray(plan.steps);

  const context = target.context;
  const hasContext = typeof context === 'object' && context !== null && 'tenant_id' in context && typeof context.tenant_id === 'string';

  const hypothesis = target.hypothesis;
  const hasHypothesis = typeof hypothesis === 'object' && hypothesis !== null && 'classification' in hypothesis && hypothesis.classification === 'HYPOTHESIS';

  const pendingAction = target.pending_action;
  const hasPendingAction = typeof pendingAction === 'object' && pendingAction !== null && 'action_id' in pendingAction && typeof pendingAction.action_id === 'string';

  const completedSteps = target.completed_steps;
  const hasCompletedSteps = Array.isArray(completedSteps);

  return Boolean(hasPlan && hasContext && hasHypothesis && hasPendingAction && hasCompletedSteps);
}
/**
 * Executes a single claimed durable task under the worker lease.
 * Fails closed on non-P1 channels, non-support module, or missing authoritative input.
 */
export async function processClaimedTask(params: {
  taskRecord: DurableTaskRecord;
  tenant_id: string;
  worker_id: string;
  workflowRepository: Pick<DurableWorkflowRepository, 'getTask' | 'releaseTaskLease' | 'recordFailure' | 'transitionTask'>;
  orchestratorFactory?: (tenant_id: string) => Promise<RevenueOrchestrator | null> | RevenueOrchestrator | null;
}): Promise<void> {
  const { taskRecord, tenant_id, worker_id, workflowRepository, orchestratorFactory } = params;

  try {
    const checkpoint = taskRecord.state_payload;
    const pending = typeof checkpoint === 'object' && checkpoint !== null && !Array.isArray(checkpoint)
      && 'pending_action' in checkpoint ? checkpoint.pending_action : null;
    if (typeof pending === 'object' && pending !== null && !Array.isArray(pending)
      && 'mutating' in pending && pending.mutating === true) {
      await workflowRepository.transitionTask(tenant_id, taskRecord.run_id, 'waiting',
        'EFFECT_UNKNOWN: reclaimed mutating action requires provider reconciliation',
        checkpoint, { expected_task_version: taskRecord.task_version, lease_owner: worker_id });
      return;
    }
    const payload = taskRecord.state_payload;
    if (typeof payload === 'object' && payload !== null && !Array.isArray(payload) && 'resume_event' in payload) {
      if (!isCompleteCheckpoint(payload as Record<string, unknown>)) {
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

      const orchestrator = await orchestratorFactory?.(tenant_id);
      if (!orchestrator) {
        await workflowRepository.recordFailure({
          tenant_id,
          run_id: taskRecord.run_id,
          error_class: 'FATAL',
          error_details: { code: 'CARE_ORCHESTRATOR_UNBOUND' },
          lease_owner: worker_id,
        });
        return;
      }

      await orchestrator.resumeTask(taskRecord.run_id, payload.resume_event as never);
      return;
    }
    const signal = typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      && 'signal' in payload ? payload.signal : null;
    const valid = typeof signal === 'object' && signal !== null && !Array.isArray(signal)
      && 'tenant_id' in signal && signal.tenant_id === tenant_id
      && 'correlation_id' in signal && signal.correlation_id === taskRecord.correlation_id
      && 'signal_id' in signal && typeof signal.signal_id === 'string'
      && 'source_channel' in signal && signal.source_channel === 'WEB_CHAT'
      && 'event_type' in signal && signal.event_type === 'message.received'
      && 'payload' in signal && typeof signal.payload === 'object' && signal.payload !== null
      && !Array.isArray(signal.payload) && 'module' in signal.payload
      && signal.payload.module === 'support';
    if (!valid) {
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

    const orchestrator = await orchestratorFactory?.(tenant_id);
    if (!orchestrator) {
      await workflowRepository.recordFailure({
        tenant_id,
        run_id: taskRecord.run_id,
        error_class: 'FATAL',
        error_details: { code: 'CARE_ORCHESTRATOR_UNBOUND' },
        lease_owner: worker_id,
      });
      return;
    }

    await orchestrator.processQueuedSignal(taskRecord.run_id, signal as SignalEnvelope, { worker_id });
  } finally {
    const current = await workflowRepository.getTask(tenant_id, taskRecord.run_id);
    const pending = current?.state_payload && typeof current.state_payload === 'object'
      && !Array.isArray(current.state_payload) && 'pending_action' in current.state_payload
      ? current.state_payload.pending_action : null;
    if (!(pending && typeof pending === 'object' && 'mutating' in pending && pending.mutating === true)) {
      await releaseLeaseIfHeld(workflowRepository, tenant_id, taskRecord.run_id, worker_id);
    }
  }
}

/**
 * Starts the durable worker.
 * Binds connectors, tenant-scoped durable PostgreSQL task polling, and fail-closed checks.
 */
export function startWorker(
  env: WorkerConnectorEnv = process.env,
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

  const unboundCapabilities = getUnboundCapabilities(careFactoryOptions);
  for (const cap of unboundCapabilities) {
    blockers.push(`CARE_CAPABILITY_UNBOUND: ${cap}`);
  }

  const careFactory = unboundCapabilities.length === 0
    ? createCareOrchestratorFactory(careFactoryOptions)
    : null;

  const orchestratorFactory = options.orchestratorFactory ?? careFactory;

  if (tenantIds.length === 0) {
    blockers.push('CARE_TENANT_IDS_EMPTY: No tenants configured; background polling disabled (fail closed).');
  }
  if (!orchestratorFactory) {
    blockers.push('CARE_ORCHESTRATOR_UNBOUND: No authentic Customer Care RevenueOrchestrator factory provided (fail closed).');
  }

  let running = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let activePollCount = 0;

  const pollOnce = async (): Promise<number> => {
    if (tenantIds.length === 0 || !orchestratorFactory) return 0;
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
            orchestratorFactory,
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
  if (shouldAutoStart && tenantIds.length > 0 && orchestratorFactory) {
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
    dispatchAction: (draft) => connectors.dispatcher.dispatch(draft),
    async close(): Promise<void> {
      await poller.stop();
    },
  };
}
