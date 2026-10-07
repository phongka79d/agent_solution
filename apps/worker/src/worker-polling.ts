import type { ClaimTaskResult, DurableTaskRecord, DurableWorkflowRepository } from '@agentos/database';

import type { DomainRuntimeRegistry } from './runtime/domain-registry.js';

export interface WorkerDrainResult {
  readonly timedOut: boolean;
  /** Number of task claims/attempts still active when the drain timeout fired. */
  readonly inFlight: number;
}

export interface WorkerStopOptions {
  readonly drainTimeoutMs?: number;
}

export interface WorkerPollerHandle {
  readonly isRunning: boolean;
  stop(options?: WorkerStopOptions): Promise<WorkerDrainResult>;
  pollOnce(): Promise<number>;
}

type TimerHandle = NodeJS.Timeout;
type SetTimeoutFn = (handler: () => void, timeout: number) => TimerHandle;
type ClearTimeoutFn = (handle: TimerHandle) => void;

type WorkflowRepository = Pick<DurableWorkflowRepository,
  'claimNextQueuedTask' | 'getTask' | 'renewTaskLease' | 'releaseTaskLease' | 'recordFailure' | 'transitionTask'>;

export interface WorkerPollingOptions {
  readonly tenantIds: readonly string[];
  readonly registry: DomainRuntimeRegistry;
  readonly workflowRepository: WorkflowRepository;
  readonly workerId: string;
  readonly leaseDurationMs: number;
  readonly pollIntervalMs: number;
  readonly autoStartPolling: boolean;
  /** Maximum number of claimed tasks allowed per tenant at once. */
  readonly tenantConcurrency?: number;
  /** Default drain timeout used when `stop()` is called without an override. */
  readonly drainTimeoutMs?: number;
  /** Polling is admitted only after the process-level dependency/binding readiness gate succeeds. */
  readonly readiness?: boolean;
  readonly now?: () => Date;
  readonly setTimeout?: SetTimeoutFn;
  readonly clearTimeout?: ClearTimeoutFn;
  readonly onError?: ((tenant_id: string, error: unknown) => void) | undefined;
  readonly processTask: (input: {
    readonly taskRecord: DurableTaskRecord;
    readonly tenant_id: string;
    readonly signal: AbortSignal;
  }) => Promise<void>;
}

export function createWorkerPoller(options: WorkerPollingOptions): WorkerPollerHandle {
  const tenantConcurrency = options.tenantConcurrency ?? 2;
  if (!Number.isSafeInteger(tenantConcurrency) || tenantConcurrency < 1) {
    throw new Error('WORKER_TENANT_CONCURRENCY_INVALID: tenant concurrency must be a positive integer');
  }
  const defaultDrainTimeoutMs = options.drainTimeoutMs ?? 25_000;
  if (!Number.isSafeInteger(defaultDrainTimeoutMs) || defaultDrainTimeoutMs < 1) {
    throw new Error('WORKER_DRAIN_TIMEOUT_INVALID: drain timeout must be a positive integer');
  }

  let running = false;
  let pollTimer: TimerHandle | null = null;
  /** Includes claims currently in flight, so concurrent pollOnce calls cannot over-claim. */
  const inFlightByTenant = new Map<string, number>();
  let activePollCount = 0;
  let drainWaiter: (() => void) | null = null;
  let drainTimer: TimerHandle | null = null;
  let stopPromise: Promise<WorkerDrainResult> | null = null;
  let drainTimeoutReason: Error | null = null;
  const activeAttempts = new Map<string, {
    readonly tenant_id: string;
    timedOut: boolean;
    readonly abort: (reason: unknown) => void;
  }>();
  const scheduleTimer = options.setTimeout ?? ((handler, timeout) => setTimeout(handler, timeout));
  const cancelTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle));
  const now = options.now ?? (() => new Date());
  let acceptingClaims = true;

  const reportError = (tenant_id: string, error: unknown): void => {
    if (options.onError) {
      options.onError(tenant_id, error);
    } else {
      process.stderr.write(
        `care worker tenant ${tenant_id} failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  };

  const totalInFlight = (): number => {
    let count = 0;
    for (const value of inFlightByTenant.values()) count += value;
    return count;
  };

  const isDrained = (): boolean => activePollCount === 0 && totalInFlight() === 0;

  const notifyDrainWaiter = (): void => {
    if (drainWaiter !== null && isDrained()) {
      const waiter = drainWaiter;
      drainWaiter = null;
      waiter();
    }
  };

  const incrementInFlight = (tenant_id: string): void => {
    inFlightByTenant.set(tenant_id, (inFlightByTenant.get(tenant_id) ?? 0) + 1);
  };

  const decrementInFlight = (tenant_id: string): void => {
    const next = (inFlightByTenant.get(tenant_id) ?? 1) - 1;
    if (next > 0) inFlightByTenant.set(tenant_id, next);
    else inFlightByTenant.delete(tenant_id);
    notifyDrainWaiter();
  };

  const processClaimedTask = async (tenant_id: string, taskRecord: DurableTaskRecord): Promise<void> => {
    const controller = new AbortController();
    let heartbeatTimer: TimerHandle | null = null;
    let settled = false;
    let rejectLeaseLost: (reason: unknown) => void = () => undefined;
    const leaseLost = new Promise<never>((_, reject) => {
      rejectLeaseLost = reject;
    });
    const attemptKey = `${tenant_id}:${taskRecord.run_id}`;

    const stopHeartbeat = () => {
      settled = true;
      if (heartbeatTimer !== null) {
        cancelTimer(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const failLease = (error: unknown) => {
      if (settled) return;
      stopHeartbeat();
      const reason = error instanceof Error
        ? error
        : new Error(`TASK_LEASE_NOT_HELD: execution lease renewal failed (${String(error)})`);
      controller.abort(reason);
      rejectLeaseLost(reason);
    };

    activeAttempts.set(attemptKey, {
      tenant_id,
      timedOut: false,
      abort: (reason) => failLease(reason),
    });

    const heartbeat = async (): Promise<void> => {
      if (settled || controller.signal.aborted) return;
      try {
        const current = await options.workflowRepository.getTask(tenant_id, taskRecord.run_id);
        if (current?.state === 'stopped') {
          stopHeartbeat();
          return;
        }
        const parked = current?.state === 'waiting' || current?.state === 'awaiting_human';
        if (
          current === null
          || (current.state !== 'running' && !parked)
          || current.lease_owner !== options.workerId
        ) {
          throw new Error('TASK_LEASE_NOT_HELD: execution lease is no longer owned by this worker');
        }
        const currentExpiry = current.lease_expires_at === null ? Number.NaN : Date.parse(current.lease_expires_at);
        if (!Number.isFinite(currentExpiry) || currentExpiry <= now().getTime()) {
          throw new Error('TASK_LEASE_EXPIRED: execution lease is absent or expired');
        }
        const renewed = await options.workflowRepository.renewTaskLease({
          tenant_id,
          run_id: taskRecord.run_id,
          lease_owner: options.workerId,
          task_version: current.task_version,
          lease_duration_ms: options.leaseDurationMs,
        });
        const expiresAt = renewed.lease_expires_at === null ? Number.NaN : Date.parse(renewed.lease_expires_at);
        if (
          renewed.lease_owner !== options.workerId
          || !Number.isFinite(expiresAt)
          || expiresAt <= now().getTime()
        ) {
          throw new Error('TASK_LEASE_NOT_HELD: lease renewal did not return a live lease owned by this worker');
        }
      } catch (error) {
        failLease(error);
        return;
      }
      if (!settled) {
        heartbeatTimer = scheduleTimer(() => {
          void heartbeat();
        }, options.leaseDurationMs / 3);
      }
    };

    heartbeatTimer = scheduleTimer(() => {
      void heartbeat();
    }, options.leaseDurationMs / 3);

    try {
      const taskPromise = options.processTask({
        taskRecord,
        tenant_id,
        signal: controller.signal,
      });
      taskPromise.catch(() => undefined);
      await Promise.race([taskPromise, leaseLost]);
    } finally {
      stopHeartbeat();
      activeAttempts.delete(attemptKey);
    }
  };

  const pollOnce = async (): Promise<number> => {
    activePollCount++;
    try {
      if (
        !acceptingClaims
        || options.readiness !== true
        || options.tenantIds.length === 0
        || options.registry.modules().length === 0
      ) return 0;
      let claimedCount = 0;
      const taskPromises: Promise<void>[] = [];

      for (const tenant_id of options.tenantIds) {
        for (;;) {
          if (!acceptingClaims) break;
          const inFlight = inFlightByTenant.get(tenant_id) ?? 0;
          if (inFlight >= tenantConcurrency) break;
          // Reserve before awaiting the claim so overlapping pollOnce calls share the cap.
          incrementInFlight(tenant_id);
          let claimResult: ClaimTaskResult | null;
          try {
            claimResult = await options.workflowRepository.claimNextQueuedTask({
              tenant_id,
              lease_owner: options.workerId,
              lease_duration_ms: options.leaseDurationMs,
            });
          } catch (error) {
            decrementInFlight(tenant_id);
            reportError(tenant_id, error);
            continue;
          }

          if (!claimResult) {
            decrementInFlight(tenant_id);
            break;
          }

          claimedCount++;
          const attemptKey = `${tenant_id}:${claimResult.task.run_id}`;
          const taskPromiseBase = processClaimedTask(tenant_id, claimResult.task);
          const attempt = activeAttempts.get(attemptKey);
          if (drainTimeoutReason !== null && attempt !== undefined) {
            attempt.timedOut = true;
            reportError(tenant_id, drainTimeoutReason);
            attempt.abort(drainTimeoutReason);
          }
          const taskPromise = taskPromiseBase
            .catch((error: unknown) => {
              if (attempt?.timedOut !== true) reportError(tenant_id, error);
            })
            .finally(() => {
              decrementInFlight(tenant_id);
            });
          taskPromises.push(taskPromise);
        }
      }

      await Promise.all(taskPromises);
      return claimedCount;
    } finally {
      activePollCount--;
      notifyDrainWaiter();
    }
  };

  const scheduleNext = () => {
    if (!running) return;
    pollTimer = scheduleTimer(() => {
      pollTimer = null;
      void pollOnce().catch((error: unknown) => {
        process.stderr.write(`care worker poll failed: ${error instanceof Error ? error.message : String(error)}\n`);
      }).finally(() => {
        scheduleNext();
      });
    }, options.pollIntervalMs);
  };

  if (
    options.autoStartPolling
    && options.readiness === true
    && options.tenantIds.length > 0
    && options.registry.modules().length > 0
  ) {
    running = true;
    scheduleNext();
  }
  return {
    get isRunning() {
      return running;
    },
    async stop(stopOptions: WorkerStopOptions = {}): Promise<WorkerDrainResult> {
      if (stopPromise !== null) return stopPromise;
      const requestedTimeout = stopOptions.drainTimeoutMs ?? defaultDrainTimeoutMs;
      if (!Number.isSafeInteger(requestedTimeout) || requestedTimeout < 1) {
        throw new Error('WORKER_DRAIN_TIMEOUT_INVALID: drain timeout must be a positive integer');
      }

      acceptingClaims = false;
      running = false;
      if (pollTimer !== null) {
        cancelTimer(pollTimer);
        pollTimer = null;
      }

      stopPromise = new Promise<WorkerDrainResult>((resolve) => {
        const finish = (result: WorkerDrainResult): void => {
          if (drainTimer !== null) {
            cancelTimer(drainTimer);
            drainTimer = null;
          }
          drainWaiter = null;
          resolve(result);
        };
        if (isDrained()) {
          finish({ timedOut: false, inFlight: 0 });
          return;
        }

        drainWaiter = () => finish({ timedOut: false, inFlight: 0 });
        drainTimer = scheduleTimer(() => {
          if (isDrained()) {
            finish({ timedOut: false, inFlight: 0 });
            return;
          }
          const remaining = totalInFlight();
          const reason = new Error(`WORKER_DRAIN_TIMEOUT: aborting ${remaining} in-flight task attempt(s)`);
          drainTimeoutReason = reason;
          for (const attempt of activeAttempts.values()) {
            attempt.timedOut = true;
            reportError(attempt.tenant_id, reason);
            attempt.abort(reason);
          }
          if (activeAttempts.size === 0) {
            process.stderr.write(`${reason.message}\n`);
          }
          finish({ timedOut: true, inFlight: remaining });
        }, requestedTimeout);
      });
      return stopPromise;
    },
    pollOnce,
  };
}
