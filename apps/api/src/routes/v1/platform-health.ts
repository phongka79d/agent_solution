import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { getPool } from '@agentos/database';

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { NetworkProbe } from '../../probes.mjs';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { authenticate, requireOperator, type CredentialStore } from '../../gateway/principal.js';

type HealthState = 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'NOT_CHECKED';
type ProbeResult = { readonly state: HealthState; readonly error_code?: string };

export interface PlatformHealthSnapshot {
  readonly observed_at: string;
  readonly state: HealthState;
  readonly probes: {
    readonly api: ProbeResult;
    readonly database: ProbeResult;
    readonly redis: ProbeResult;
    readonly qdrant: ProbeResult;
    readonly workers: ProbeResult & { readonly items: readonly { readonly worker_id: string; readonly heartbeat_at: string; readonly age_seconds: number | null }[] };
    readonly queue: ProbeResult & { readonly depth: number | null; readonly oldest_queued_age_seconds: number | null; readonly expired_leases: number | null };
    readonly migrations: ProbeResult & { readonly applied_count: number; readonly latest_applied: string | null; readonly applied: readonly string[] };
    readonly llm: ProbeResult & { readonly last_probe: Readonly<Record<string, unknown>> | null };
    readonly connectors: ProbeResult & { readonly companies: readonly Readonly<Record<string, unknown>>[] };
  };
}

interface HealthSnapshotRow {
  readonly workers?: unknown;
  readonly queue_depth?: unknown;
  readonly oldest_queued_at?: unknown;
  readonly expired_leases?: unknown;
  readonly llm_last_probe?: unknown;
  readonly connectors?: unknown;
}

interface ReaderDependencies {
  readonly now?: () => number;
  readonly cacheMs?: number;
  readonly timeoutMs?: number;
  readonly database?: () => Promise<unknown>;
  readonly redis?: () => Promise<{ readonly ok: boolean }>;
  readonly qdrant?: () => Promise<{ readonly ok: boolean }>;
  readonly readSnapshot?: () => Promise<HealthSnapshotRow>;
  readonly readMigrations?: () => Promise<readonly string[]>;
}

const CACHE_MS = 30_000;
const PROBE_TIMEOUT_MS = 2_000;
const REQUIRED_MIGRATION = '0040_worker_heartbeats.sql';

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveCount(value: unknown): number | null {
  const count = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function ageSeconds(value: unknown, now: number): number | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const parsed = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(parsed) ? Math.max(0, (now - parsed) / 1000) : null;
}

export function workerHealthState(
  workers: readonly { readonly heartbeat_at: unknown }[],
  now: number,
): HealthState {
  // Worker IDs change on restart; stale instances remain visible but do not fail the fleet.
  return workers.some((worker) => {
    const age = ageSeconds(worker.heartbeat_at, now);
    return age !== null && age <= 60;
  }) ? 'HEALTHY' : 'FAILED';
}

function aggregateState(states: readonly HealthState[]): HealthState {
  if (states.includes('FAILED')) return 'FAILED';
  if (states.includes('DEGRADED') || states.includes('NOT_CHECKED')) return 'DEGRADED';
  return 'HEALTHY';
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('PROBE_TIMEOUT')), timeoutMs);
    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function checked<T>(operation: () => Promise<T>, timeoutMs: number): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false }> {
  return withTimeout(Promise.resolve().then(operation), timeoutMs)
    .then((value) => ({ ok: true as const, value }))
    .catch(() => ({ ok: false as const }));
}

/**
 * Static import cannot work: `src/probes.mjs` is not compiled into `dist/` (the build copies no
 * `.mjs`), so the specifier is chosen at runtime — next to this source file in development, under
 * `src/` next to the compiled file in the image (same scheme as `server.ts`).
 */
const PROBES_CANDIDATES = ['../../probes.mjs', '../../../src/probes.mjs'] as const;
interface RealProbes {
  readonly redis: NetworkProbe;
  readonly qdrant: NetworkProbe;
}
let probesModule: Promise<RealProbes> | undefined;

function loadRealProbes(): Promise<RealProbes> {
  probesModule ??= (async () => {
    const url = PROBES_CANDIDATES
      .map((candidate) => new URL(candidate, import.meta.url))
      .find((candidate) => existsSync(fileURLToPath(candidate)))
      ?? new URL(PROBES_CANDIDATES[0], import.meta.url);
    const loaded: { readonly realProbes: RealProbes } = await import(url.href);
    return loaded.realProbes;
  })();
  return probesModule;
}

export function createPlatformHealthReader(deps: ReaderDependencies = {}): () => Promise<PlatformHealthSnapshot> {
  const now = deps.now ?? Date.now;
  const cacheMs = deps.cacheMs ?? CACHE_MS;
  const timeoutMs = deps.timeoutMs ?? PROBE_TIMEOUT_MS;
  const database = deps.database ?? (async () => { await getPool().query('SELECT 1'); });
  const redis = deps.redis ?? (async () => (await loadRealProbes()).redis(process.env, { timeoutMs }));
  const qdrant = deps.qdrant ?? (async () => (await loadRealProbes()).qdrant(process.env, { timeoutMs }));
  const readSnapshot = deps.readSnapshot ?? (async () => {
    const result = await getPool().query<{ snapshot: HealthSnapshotRow }>(
      'SELECT agentos.platform_system_health_snapshot() AS snapshot',
    );
    return result.rows[0]?.snapshot ?? {};
  });
  const readMigrations = deps.readMigrations ?? (async () => {
    const result = await getPool().query<{ filename: string }>(
      'SELECT filename FROM agentos.schema_applied_migrations() ORDER BY filename',
    );
    return result.rows.map((row) => row.filename);
  });

function refreshAges(snapshot: PlatformHealthSnapshot, now: number, cachedAt: number): PlatformHealthSnapshot {
  const previousWorkers = snapshot.probes.workers;
  const items = previousWorkers.items.map((worker) => ({
    ...worker,
    age_seconds: ageSeconds(worker.heartbeat_at, now),
  }));
  const workerState: HealthState = previousWorkers.state === 'NOT_CHECKED'
    ? 'NOT_CHECKED'
    : workerHealthState(items, now);
  const previousQueue = snapshot.probes.queue;
  const oldestAge = previousQueue.oldest_queued_age_seconds === null
    ? null
    : previousQueue.oldest_queued_age_seconds + Math.max(0, now - cachedAt) / 1000;
  const queueState: HealthState = previousQueue.state === 'NOT_CHECKED' || previousQueue.state === 'FAILED'
    ? previousQueue.state
    : (previousQueue.expired_leases ?? 0) > 0 || (oldestAge !== null && oldestAge > 60)
      ? 'DEGRADED'
      : 'HEALTHY';
  const probes: PlatformHealthSnapshot['probes'] = {
    ...snapshot.probes,
    workers: { ...previousWorkers, state: workerState, items },
    queue: { ...previousQueue, state: queueState, oldest_queued_age_seconds: oldestAge },
  };
  return {
    ...snapshot,
    state: aggregateState(Object.values(probes).map((probe) => probe.state)),
    probes,
  };
}

  let cachedAt = Number.NEGATIVE_INFINITY;
  let cached: PlatformHealthSnapshot | null = null;
  let inFlight: Promise<PlatformHealthSnapshot> | null = null;

  return async () => {
    const requestedAt = now();
    if (cached !== null && requestedAt - cachedAt < cacheMs) return refreshAges(cached, requestedAt, cachedAt);
    if (inFlight !== null) return inFlight;

    inFlight = (async () => {
      const [databaseResult, redisResult, qdrantResult, snapshotResult, migrationsResult] = await Promise.all([
        checked(database, timeoutMs),
        checked(redis, timeoutMs),
        checked(qdrant, timeoutMs),
        checked(readSnapshot, timeoutMs),
        checked(readMigrations, timeoutMs),
      ]);
      const observedAt = new Date(now()).toISOString();
      const snapshot = snapshotResult.ok ? snapshotResult.value : {};
      const workersRaw = Array.isArray(snapshot.workers) ? snapshot.workers : [];
      const workers = workersRaw.flatMap((item) => {
        const entry = record(item);
        return entry !== null && typeof entry.worker_id === 'string'
          ? [{ worker_id: entry.worker_id, heartbeat_at: typeof entry.heartbeat_at === 'string' ? entry.heartbeat_at : '', age_seconds: ageSeconds(entry.heartbeat_at, now()) }]
          : [];
      });
      const workerState = snapshotResult.ok ? workerHealthState(workers, now()) : 'NOT_CHECKED';
      const depth = positiveCount(snapshot.queue_depth);
      const expiredLeases = positiveCount(snapshot.expired_leases);
      const oldestAge = ageSeconds(snapshot.oldest_queued_at, now());
      const queueState: HealthState = !snapshotResult.ok
        ? 'NOT_CHECKED'
        : expiredLeases === null || depth === null
          ? 'FAILED'
          : expiredLeases > 0 || (oldestAge !== null && oldestAge > 60)
            ? 'DEGRADED'
            : 'HEALTHY';
      const migrations = migrationsResult.ok ? migrationsResult.value : [];
      const llmProbe = record(snapshot.llm_last_probe);
      const llmState: HealthState = !snapshotResult.ok
        ? 'NOT_CHECKED'
        : llmProbe === null
          ? 'NOT_CHECKED'
          : llmProbe.outcome === 'PASS'
            ? 'HEALTHY'
            : llmProbe.outcome === 'FAIL' ? 'FAILED' : 'NOT_CHECKED';
      const connectorRows = Array.isArray(snapshot.connectors)
        ? snapshot.connectors.map(record).filter((value): value is Record<string, unknown> => value !== null)
        : [];
      const connectorState: HealthState = !snapshotResult.ok || connectorRows.length === 0
        ? 'NOT_CHECKED'
        : connectorRows.some((item) => item.outcome === 'FAIL')
          ? 'FAILED'
          : connectorRows.every((item) => item.outcome === 'PASS') ? 'HEALTHY' : 'NOT_CHECKED';
      const databaseState: HealthState = databaseResult.ok ? 'HEALTHY' : 'FAILED';
      const redisState: HealthState = redisResult.ok && redisResult.value.ok ? 'HEALTHY' : 'FAILED';
      const qdrantState: HealthState = qdrantResult.ok && qdrantResult.value.ok ? 'HEALTHY' : 'FAILED';
      const migrationState: HealthState = !migrationsResult.ok
        ? 'FAILED'
        : migrations.includes(REQUIRED_MIGRATION) ? 'HEALTHY' : 'FAILED';
      const probes: PlatformHealthSnapshot['probes'] = {
        api: { state: 'HEALTHY' },
        database: databaseResult.ok ? { state: databaseState } : { state: databaseState, error_code: 'DATABASE_UNAVAILABLE' },
        redis: redisResult.ok ? { state: redisState } : { state: 'FAILED', error_code: 'PROBE_TIMEOUT' },
        qdrant: qdrantResult.ok ? { state: qdrantState } : { state: 'FAILED', error_code: 'PROBE_TIMEOUT' },
        workers: { state: workerState, items: workers },
        queue: {
          state: queueState,
          depth,
          oldest_queued_age_seconds: oldestAge,
          expired_leases: expiredLeases,
        },
        migrations: {
          state: migrationState,
          applied_count: migrations.length,
          latest_applied: migrations[migrations.length - 1] ?? null,
          applied: migrations,
        },
        llm: { state: llmState, last_probe: llmProbe },
        connectors: { state: connectorState, companies: connectorRows },
      };
      return {
        observed_at: observedAt,
        state: aggregateState(Object.values(probes).map((probe) => probe.state)),
        probes,
      };
    })();

    try {
      cached = await inFlight;
      cachedAt = now();
      return cached;
    } finally {
      inFlight = null;
    }
  };
}

const readPlatformHealth = createPlatformHealthReader();

export interface PlatformHealthRouteDependencies {
  readonly credentials: CredentialStore;
  readonly runtime: GatewayRuntime;
  readonly readHealth?: () => Promise<PlatformHealthSnapshot>;
}

export function registerPlatformHealthRoutes(app: FastifyInstance, deps: PlatformHealthRouteDependencies): void {
  const authenticateRequest = authenticate(deps);
  const preValidation = async (request: FastifyRequest): Promise<void> => {
    if (request.headers['x-tenant-id'] !== undefined) {
      fail('VALIDATION_FAILED', 'platform routes do not accept tenant binding assertions');
    }
    const query = request.query;
    if (record(query)?.['tenant_id'] !== undefined) {
      fail('INSUFFICIENT_AUTHORITY', 'platform routes do not accept tenant-scoped query parameters');
    }
  };
  const preHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    await authenticateRequest(request, reply);
  };

  app.get('/platform/health', { preValidation, preHandler }, async (request, reply) => {
    try {
      const principal = requireOperator(request, 'platform:admin');
      if (principal.scope !== 'platform') fail('INSUFFICIENT_AUTHORITY', 'the platform control plane requires a platform-scoped principal');
      return reply.code(200).send(await (deps.readHealth ?? readPlatformHealth)());
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, deps.runtime));
    }
  });
}
