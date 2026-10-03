import type { QueueRetryTimerInput, RetryTimerCandidate } from '@agentos/database';

export const RETRY_SWEEP_BATCH_LIMIT = 200;
export const DEFAULT_RETRY_SWEEP_INTERVAL_MS = 5_000;

export interface RetryTimerSweepRepository {
  listRetryTimerCandidates(tenant_id: string, limit: number): Promise<readonly RetryTimerCandidate[]>;
  queueRetryTimer(input: QueueRetryTimerInput): Promise<boolean>;
}

export interface RetryTimerSweeperOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly tenantIds?: string | readonly string[];
  readonly getTenantIds?: () => readonly string[];
  readonly repository: RetryTimerSweepRepository;
  readonly intervalMs?: number;
  readonly setInterval?: (handler: () => void, timeout: number) => NodeJS.Timeout;
  readonly clearInterval?: (handle: NodeJS.Timeout) => void;
  readonly onError?: (tenant_id: string, error: unknown) => void;
  readonly autoStart?: boolean;
}

export interface RetryTimerSweeperHandle {
  readonly tenantIds: readonly string[];
  readonly intervalMs: number;
  readonly isRunning: boolean;
  start(): void;
  runOnce(): Promise<void>;
  stop(): Promise<void>;
}

function parsePositiveInteger(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`${name}_INVALID: expected a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name}_INVALID: expected a positive integer`);
  return parsed;
}

function resolveTenantIds(raw: string | readonly string[] | undefined, env: NodeJS.ProcessEnv): readonly string[] {
  const configured = raw ?? env.WORKER_TENANT_IDS;
  const ids = typeof configured === 'string'
    ? configured.split(',').map((id) => id.trim()).filter(Boolean)
    : configured === undefined ? [] : [...configured];
  return Object.freeze([...new Set(ids)]);
}

/** Enqueues one durable timer per due RETRY wait; UNKNOWN effects stay on reconciliation. */
export function createRetryTimerSweeper(options: RetryTimerSweeperOptions): RetryTimerSweeperHandle {
  const env = options.env ?? process.env;
  const tenantIds = resolveTenantIds(options.tenantIds, env);
  const intervalMs = options.intervalMs
    ?? parsePositiveInteger(env.RETRY_SWEEP_INTERVAL_MS, 'RETRY_SWEEP_INTERVAL_MS', DEFAULT_RETRY_SWEEP_INTERVAL_MS);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error('RETRY_SWEEP_INTERVAL_MS_INVALID: expected a positive integer');
  }

  const schedule = options.setInterval ?? ((handler, timeout) => setInterval(handler, timeout));
  const cancel = options.clearInterval ?? ((handle) => clearInterval(handle));
  const onError = options.onError ?? ((tenant_id) => {
    process.stderr.write(`retry timer sweep failed for tenant ${tenant_id}\n`);
  });
  const activeTenantIds = (): readonly string[] => options.getTenantIds?.() ?? tenantIds;
  let timer: NodeJS.Timeout | null = null;
  let activeRun: Promise<void> | null = null;

  const runTenants = async (): Promise<void> => {
    for (const tenant_id of activeTenantIds()) {
      try {
        const candidates = await options.repository.listRetryTimerCandidates(
          tenant_id,
          RETRY_SWEEP_BATCH_LIMIT,
        );
        for (const candidate of candidates) {
          if (candidate.tenant_id !== tenant_id
            || candidate.wait_reason !== 'RETRY'
            || candidate.has_resume_event) continue;
          try {
            await options.repository.queueRetryTimer({
              tenant_id,
              run_id: candidate.run_id,
              retry_count: candidate.retry_count,
            });
          } catch (error) {
            try { onError(tenant_id, error); } catch { /* logging must not stop other retries */ }
          }
        }
      } catch (error) {
        try { onError(tenant_id, error); } catch { /* logging must not stop other tenants */ }
      }
    }
  };

  const runOnce = (): Promise<void> => {
    if (activeRun !== null) return activeRun;
    const run = runTenants();
    activeRun = run;
    void run.then(
      () => { if (activeRun === run) activeRun = null; },
      () => { if (activeRun === run) activeRun = null; },
    );
    return run;
  };
  const start = (): void => {
    if (timer !== null) return;
    timer = schedule(() => { void runOnce().catch(() => undefined); }, intervalMs);
  };
  const stop = async (): Promise<void> => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    if (activeRun !== null) await activeRun;
  };
  const handle: RetryTimerSweeperHandle = {
    get tenantIds() { return activeTenantIds(); },
    intervalMs,
    get isRunning() { return timer !== null; },
    start,
    runOnce,
    stop,
  };
  if (options.autoStart !== false) start();
  return handle;
}
