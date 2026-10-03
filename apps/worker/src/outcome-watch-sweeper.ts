import { EvidenceRepository } from '@agentos/database';

export const OUTCOME_WATCH_SWEEP_BATCH_LIMIT = 500;
export const DEFAULT_OUTCOME_WATCH_SWEEP_INTERVAL_MS = 60_000;

export interface OutcomeWatchExpiryRepository {
  expireOverdueOutcomeWatches(tenant_id: string, limit: number): Promise<readonly string[]>;
}

export interface OutcomeWatchSweeperOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Raw `WORKER_TENANT_IDS` or an already parsed tenant list for tests and embedding callers. */
  readonly tenantIds?: string | readonly string[];
  readonly getTenantIds?: () => readonly string[];
  readonly repository?: OutcomeWatchExpiryRepository;
  readonly intervalMs?: number;
  readonly setInterval?: (handler: () => void, timeout: number) => NodeJS.Timeout;
  readonly clearInterval?: (handle: NodeJS.Timeout) => void;
  /** Receives one tenant's failure; a failure never prevents the next tenant from being swept. */
  readonly onError?: (tenant_id: string, error: unknown) => void;
  readonly autoStart?: boolean;
}

export interface OutcomeWatchSweeperHandle {
  readonly tenantIds: readonly string[];
  readonly intervalMs: number;
  readonly isRunning: boolean;
  start(): void;
  runOnce(): Promise<void>;
  stop(): Promise<void>;
}

function parseIntervalMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_OUTCOME_WATCH_SWEEP_INTERVAL_MS;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error('OUTCOME_WATCH_SWEEP_INTERVAL_MS_INVALID: interval must be a positive integer');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('OUTCOME_WATCH_SWEEP_INTERVAL_MS_INVALID: interval must be a positive integer');
  }
  return parsed;
}

function resolveTenantIds(
  raw: string | readonly string[] | undefined,
  env: NodeJS.ProcessEnv,
): readonly string[] {
  const configured = raw ?? env.WORKER_TENANT_IDS;
  const ids = typeof configured === 'string'
    ? configured.split(',').map((id) => id.trim()).filter(Boolean)
    : configured === undefined
      ? []
      : [...configured];
  return Object.freeze([...new Set(ids)]);
}

/**
 * Periodically closes expired outcome watches. Each repository call is tenant-scoped and records
 * UNKNOWN_OUTCOME atomically with the watch's EXPIRED transition.
 */
export function createOutcomeWatchSweeper(
  options: OutcomeWatchSweeperOptions = {},
): OutcomeWatchSweeperHandle {
  const env = options.env ?? process.env;
  const tenantIds = resolveTenantIds(options.tenantIds, env);
  const intervalMs = options.intervalMs ?? parseIntervalMs(env.OUTCOME_WATCH_SWEEP_INTERVAL_MS);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error('OUTCOME_WATCH_SWEEP_INTERVAL_MS_INVALID: interval must be a positive integer');
  }

  const repository = options.repository ?? new EvidenceRepository();
  const schedule = options.setInterval ?? ((handler, timeout) => setInterval(handler, timeout));
  const cancel = options.clearInterval ?? ((handle) => clearInterval(handle));
  const onError = options.onError ?? ((tenant_id) => {
    process.stderr.write(`outcome watch sweep failed for tenant ${tenant_id}\n`);
  });

  let timer: NodeJS.Timeout | null = null;
  let activeRun: Promise<void> | null = null;

  const activeTenantIds = (): readonly string[] => options.getTenantIds?.() ?? tenantIds;

  const runTenants = async (): Promise<void> => {
    for (const tenant_id of activeTenantIds()) {
      try {
        await repository.expireOverdueOutcomeWatches(tenant_id, OUTCOME_WATCH_SWEEP_BATCH_LIMIT);
      } catch (error) {
        try {
          onError(tenant_id, error);
        } catch {
          // A logger failure must not stop the remaining tenant sweeps.
        }
      }
    }
  };

  const runOnce = (): Promise<void> => {
    if (activeRun !== null) return activeRun;
    const run = runTenants();
    activeRun = run;
    void run.then(
      () => {
        if (activeRun === run) activeRun = null;
      },
      () => {
        if (activeRun === run) activeRun = null;
      },
    );
    return run;
  };

  const start = (): void => {
    if (timer !== null) return;
    timer = schedule(() => {
      void runOnce().catch(() => undefined);
    }, intervalMs);
  };

  const stop = async (): Promise<void> => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    if (activeRun !== null) await activeRun;
  };

  const handle: OutcomeWatchSweeperHandle = {
    get tenantIds() {
      return activeTenantIds();
    },
    intervalMs,
    get isRunning() {
      return timer !== null;
    },
    start,
    runOnce,
    stop,
  };

  if (options.autoStart !== false) start();
  return handle;
}

export { parseIntervalMs as parseOutcomeWatchSweepIntervalMs };
