import type { ReconciliationCandidate } from '@agentos/database';

export const RECONCILE_SWEEP_BATCH_LIMIT = 200;
export const DEFAULT_RECONCILE_SWEEP_INTERVAL_MS = 60_000;
export const DEFAULT_RECONCILE_MIN_AGE_MINUTES = 5;

export interface ReconciliationSweepRepository {
  listReconciliationCandidates(
    tenant_id: string,
    min_age_minutes: number,
    limit: number,
  ): Promise<readonly ReconciliationCandidate[]>;
  recordReconciliationOutcome(input: {
    readonly tenant_id: string;
    readonly run_id: string;
    readonly effect_key: string;
    readonly outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE';
    readonly receipt?: unknown;
  }): Promise<'COMPLETED' | 'FAILED' | 'ESCALATED' | 'UNCHANGED'>;
}

export interface ReconcileActionInput {
  readonly tenant_id: string;
  readonly effect_key: string;
  readonly action_id?: string;
  readonly adapter_target?: string;
  readonly skill_id: string;
}

export interface ReconcileActionResult {
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE';
  readonly receipt?: unknown;
}

export interface ReconcileSweeperOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly tenantIds?: string | readonly string[];
  readonly getTenantIds?: () => readonly string[];
  readonly repository: ReconciliationSweepRepository;
  readonly reconcileAction: (input: ReconcileActionInput) => Promise<ReconcileActionResult>;
  readonly intervalMs?: number;
  readonly minAgeMinutes?: number;
  readonly setInterval?: (handler: () => void, timeout: number) => NodeJS.Timeout;
  readonly clearInterval?: (handle: NodeJS.Timeout) => void;
  readonly onError?: (tenant_id: string, error: unknown) => void;
  readonly autoStart?: boolean;
}

export interface ReconcileSweeperHandle {
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function hasReceiptProof(value: unknown): value is Record<string, unknown> {
  const receipt = asRecord(value);
  return receipt !== null
    && receipt['adapter_status'] === 'SUCCESS'
    && typeof receipt['execution_id'] === 'string' && receipt['execution_id'].trim().length > 0
    && typeof receipt['provider_reference'] === 'string' && receipt['provider_reference'].trim().length > 0;
}

/** Reconciles old waiting effects; an unknown provider result is never dispatched or settled. */
export function createReconcileSweeper(options: ReconcileSweeperOptions): ReconcileSweeperHandle {
  const env = options.env ?? process.env;
  const tenantIds = resolveTenantIds(options.tenantIds, env);
  const intervalMs = options.intervalMs
    ?? parsePositiveInteger(env.RECONCILE_SWEEP_INTERVAL_MS, 'RECONCILE_SWEEP_INTERVAL_MS', DEFAULT_RECONCILE_SWEEP_INTERVAL_MS);
  const minAgeMinutes = options.minAgeMinutes
    ?? parsePositiveInteger(env.RECONCILE_SWEEP_MIN_AGE_MINUTES, 'RECONCILE_SWEEP_MIN_AGE_MINUTES', DEFAULT_RECONCILE_MIN_AGE_MINUTES);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error('RECONCILE_SWEEP_INTERVAL_MS_INVALID: expected a positive integer');
  }
  if (!Number.isSafeInteger(minAgeMinutes) || minAgeMinutes < 1) {
    throw new Error('RECONCILE_SWEEP_MIN_AGE_MINUTES_INVALID: expected a positive integer');
  }

  const schedule = options.setInterval ?? ((handler, timeout) => setInterval(handler, timeout));
  const cancel = options.clearInterval ?? ((handle) => clearInterval(handle));
  const onError = options.onError ?? ((tenant_id) => {
    process.stderr.write(`reconciliation sweep failed for tenant ${tenant_id}\n`);
  });
  const activeTenantIds = (): readonly string[] => options.getTenantIds?.() ?? tenantIds;
  let timer: NodeJS.Timeout | null = null;
  let activeRun: Promise<void> | null = null;

  const runTenants = async (): Promise<void> => {
    for (const tenant_id of activeTenantIds()) {
      try {
        const candidates = await options.repository.listReconciliationCandidates(
          tenant_id,
          minAgeMinutes,
          RECONCILE_SWEEP_BATCH_LIMIT,
        );
        for (const candidate of candidates) {
          try {
            const payload = asRecord(candidate.state_payload);
            const action = asRecord(payload?.['pending_action']);
            let result: ReconcileActionResult = { outcome: 'INDETERMINATE' };
            if (action !== null && action['effect_key'] === candidate.effect_key && action['mutating'] === true) {
              try {
                result = await options.reconcileAction({
                  tenant_id,
                  effect_key: candidate.effect_key,
                  skill_id: candidate.skill_id,
                  ...(typeof action['action_id'] === 'string' ? { action_id: action['action_id'] } : {}),
                  ...(typeof action['adapter_target'] === 'string' ? { adapter_target: action['adapter_target'] } : {}),
                });
              } catch (error) {
                try { onError(tenant_id, error); } catch { /* logging must not stop other effects */ }
              }
            }
            const outcome = result.outcome === 'SUCCEEDED' && !hasReceiptProof(result.receipt)
              ? 'INDETERMINATE'
              : result.outcome;
            await options.repository.recordReconciliationOutcome({
              tenant_id,
              run_id: candidate.run_id,
              effect_key: candidate.effect_key,
              outcome,
              ...(outcome === 'SUCCEEDED' ? { receipt: result.receipt } : {}),
            });
          } catch (error) {
            try { onError(tenant_id, error); } catch { /* logging must not stop other effects */ }
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
  const handle: ReconcileSweeperHandle = {
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
