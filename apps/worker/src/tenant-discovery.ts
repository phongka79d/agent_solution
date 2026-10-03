export interface ActiveTenantRecord {
  readonly tenant_id: string;
  readonly enabled_domains: readonly string[];
}

export interface ActiveTenantRepository {
  listActiveTenants(): Promise<readonly ActiveTenantRecord[]>;
}

export interface TenantDiscoveryOptions {
  readonly repository: ActiveTenantRepository;
  /** Optional local-debug allowlists intersected with the database projection. */
  readonly tenantIds?: readonly string[];
  readonly enabledDomains?: readonly string[];
  readonly intervalMs?: number;
  readonly setInterval?: (handler: () => void, timeout: number) => NodeJS.Timeout;
  readonly clearInterval?: (handle: NodeJS.Timeout) => void;
  readonly onError?: (error: unknown) => void;
}

export interface TenantDiscoveryHandle {
  readonly tenants: readonly ActiveTenantRecord[];
  readonly tenantIds: readonly string[];
  refresh(): Promise<readonly ActiveTenantRecord[]>;
  start(): void;
  stop(): Promise<void>;
}

export const DEFAULT_TENANT_DISCOVERY_INTERVAL_MS = 30_000;

export function createTenantDiscovery(options: TenantDiscoveryOptions): TenantDiscoveryHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_TENANT_DISCOVERY_INTERVAL_MS;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error('WORKER_TENANT_DISCOVERY_INTERVAL_INVALID: interval must be a positive integer');
  }
  const tenantFilter = options.tenantIds === undefined ? null : new Set(options.tenantIds);
  const domainFilter = options.enabledDomains === undefined ? null : new Set(options.enabledDomains);
  const schedule = options.setInterval ?? ((handler, timeout) => setInterval(handler, timeout));
  const cancel = options.clearInterval ?? ((handle) => clearInterval(handle));
  const onError = options.onError ?? ((error) => {
    process.stderr.write(
      `worker tenant discovery failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });

  let discovered: readonly ActiveTenantRecord[] = Object.freeze([]);
  let timer: NodeJS.Timeout | null = null;
  let activeRefresh: Promise<readonly ActiveTenantRecord[]> | null = null;

  const refresh = (): Promise<readonly ActiveTenantRecord[]> => {
    if (activeRefresh !== null) return activeRefresh;
    const load = Promise.resolve().then(() => options.repository.listActiveTenants()).then((rows) => {
      const next: ActiveTenantRecord[] = [];
      for (const row of rows) {
        if (tenantFilter !== null && !tenantFilter.has(row.tenant_id)) continue;
        const enabled_domains = [...new Set(row.enabled_domains)].filter((domain) =>
          domainFilter === null || domainFilter.has(domain),
        );
        if (enabled_domains.length === 0) continue;
        next.push({ tenant_id: row.tenant_id, enabled_domains: Object.freeze(enabled_domains) });
      }
      discovered = Object.freeze(next);
      return discovered;
    }).catch((error: unknown) => {
      try {
        onError(error);
      } catch {
        // Logging must not discard the last known-good tenant set.
      }
      return discovered;
    });
    activeRefresh = load;
    void load.then(() => {
      if (activeRefresh === load) activeRefresh = null;
    });
    return load;
  };

  const start = (): void => {
    if (timer !== null) return;
    void refresh();
    timer = schedule(() => { void refresh(); }, intervalMs);
  };

  const stop = async (): Promise<void> => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    if (activeRefresh !== null) await activeRefresh;
  };

  return {
    get tenants() { return discovered; },
    get tenantIds() { return discovered.map(({ tenant_id }) => tenant_id); },
    refresh,
    start,
    stop,
  };
}
