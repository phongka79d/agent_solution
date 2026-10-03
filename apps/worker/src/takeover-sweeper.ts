import { sessionTakeoverLockKey, type RedisInjectedClient } from '@agentos/database';

export const TAKEOVER_SWEEP_BATCH_LIMIT = 200;
export const DEFAULT_TAKEOVER_SWEEP_INTERVAL_MS = 30_000;
export const TAKEOVER_EXPIRY_GRACE_MS = 60_000;

export interface PausedTakeoverRecord {
  readonly conversation_id: string;
  readonly takeover_operator_id: string | null;
}

export interface TakeoverSweepRepository {
  listPausedTakeovers(
    tenant_id: string,
    limit: number,
    afterConversationId?: string,
  ): Promise<readonly PausedTakeoverRecord[]>;
  /** Atomically CAS-clears the marker only when no ASSIGNED handoff exists. */
  clearOrphanedTakeoverIfOwned(
    tenant_id: string,
    conversation_id: string,
    operator_id: string,
  ): Promise<boolean>;
}

export interface TakeoverSweeperOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly tenantIds?: string | readonly string[];
  readonly getTenantIds?: () => readonly string[];
  readonly repository: TakeoverSweepRepository;
  readonly redis: RedisInjectedClient;
  readonly intervalMs?: number;
  readonly setInterval?: (handler: () => void, timeout: number) => NodeJS.Timeout;
  readonly clearInterval?: (handle: NodeJS.Timeout) => void;
  readonly now?: () => Date;
  readonly onError?: (tenant_id: string, error: unknown) => void;
  readonly autoStart?: boolean;
}

export interface TakeoverSweeperHandle {
  readonly tenantIds: readonly string[];
  readonly intervalMs: number;
  readonly isRunning: boolean;
  start(): void;
  runOnce(): Promise<void>;
  stop(): Promise<void>;
}

interface MissingLeaseObservation {
  readonly tenant_id: string;
  readonly operator_id: string;
  readonly first_missing_at: number;
}

function parseIntervalMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_TAKEOVER_SWEEP_INTERVAL_MS;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error('TAKEOVER_SWEEP_INTERVAL_MS_INVALID: interval must be a positive integer');
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error('TAKEOVER_SWEEP_INTERVAL_MS_INVALID: interval must be a positive integer');
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
 * Reconciles durable takeover markers after a Redis lease has been absent for a full grace window.
 * The repository's conditional clear also excludes ASSIGNED handoffs in the same database update.
 */
export function createTakeoverSweeper(options: TakeoverSweeperOptions): TakeoverSweeperHandle {
  const env = options.env ?? process.env;
  const tenantIds = resolveTenantIds(options.tenantIds, env);
  const intervalMs = options.intervalMs ?? parseIntervalMs(env.TAKEOVER_SWEEP_INTERVAL_MS);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error('TAKEOVER_SWEEP_INTERVAL_MS_INVALID: interval must be a positive integer');
  }

  const schedule = options.setInterval ?? ((handler, timeout) => setInterval(handler, timeout));
  const cancel = options.clearInterval ?? ((handle) => clearInterval(handle));
  const now = options.now ?? (() => new Date());
  const onError = options.onError ?? ((tenant_id) => {
    process.stderr.write(`takeover sweep failed for tenant ${tenant_id}\n`);
  });
  const missingLeaseSince = new Map<string, MissingLeaseObservation>();

  let timer: NodeJS.Timeout | null = null;
  let activeRun: Promise<void> | null = null;
  const activeTenantIds = (): readonly string[] => options.getTenantIds?.() ?? tenantIds;


  const runTenants = async (): Promise<void> => {
    for (const tenant_id of activeTenantIds()) {
      let scanComplete = false;
      const seenKeys = new Set<string>();
      try {
        let afterConversationId: string | undefined;
        while (true) {
          const conversations = await options.repository.listPausedTakeovers(
            tenant_id,
            TAKEOVER_SWEEP_BATCH_LIMIT,
            afterConversationId,
          );
          for (const conversation of conversations) {
            const operator_id = conversation.takeover_operator_id;
            if (operator_id === null) continue;
            const leaseKey = sessionTakeoverLockKey(tenant_id, conversation.conversation_id);
            seenKeys.add(leaseKey);
            const rawLease = await options.redis.get(leaseKey);
            if (rawLease !== null) {
              // A present value is treated as live or unattributable; do not clear on a TTL race or
              // malformed lease. Redis removes expired values before returning from GET.
              missingLeaseSince.delete(leaseKey);
              continue;
            }

            const current = missingLeaseSince.get(leaseKey);
            if (current === undefined || current.operator_id !== operator_id) {
              missingLeaseSince.set(leaseKey, {
                tenant_id,
                operator_id,
                first_missing_at: now().getTime(),
              });
              continue;
            }
            if (now().getTime() - current.first_missing_at <= TAKEOVER_EXPIRY_GRACE_MS) continue;

            // Recheck just before the database CAS to narrow the race with a new Redis acquisition.
            if (await options.redis.get(leaseKey) !== null) {
              missingLeaseSince.delete(leaseKey);
              continue;
            }
            const cleared = await options.repository.clearOrphanedTakeoverIfOwned(
              tenant_id,
              conversation.conversation_id,
              operator_id,
            );
            if (cleared) missingLeaseSince.delete(leaseKey);
          }

          if (conversations.length < TAKEOVER_SWEEP_BATCH_LIMIT) {
            scanComplete = true;
            break;
          }
          const lastConversation = conversations[conversations.length - 1];
          if (lastConversation === undefined || lastConversation.conversation_id === afterConversationId) {
            throw new Error('TAKEOVER_SWEEP_CURSOR_STALLED: repository page did not advance');
          }
          afterConversationId = lastConversation.conversation_id;
        }
      } catch (error) {
        try {
          onError(tenant_id, error);
        } catch {
          // A logger failure must not stop the remaining tenant sweeps.
        }
      }
      if (scanComplete) {
        for (const [leaseKey, observation] of missingLeaseSince) {
          if (observation.tenant_id === tenant_id && !seenKeys.has(leaseKey)) {
            missingLeaseSince.delete(leaseKey);
          }
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

  const handle: TakeoverSweeperHandle = {
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

export { parseIntervalMs as parseTakeoverSweepIntervalMs };
