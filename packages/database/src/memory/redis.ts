import { createHash } from 'node:crypto';

import type {
  IdempotencyReservation,
  IdempotencyStatus,
  RedisInjectedClient,
} from '../contracts/index.js';

/**
 * Session mutex lease: long enough for one agent turn, short enough that a crashed
 * agent cannot hold a conversation.
 */
export const SESSION_MUTEX_TTL_MS = 30_000;

/**
 * Human takeover lease (SCR-005). The console renews it; expiry releases control
 * back to the automation.
 */
export const SESSION_TAKEOVER_LOCK_TTL_MS = 60_000;

/**
 * Idempotency window of an `effect_key`: 259,200 seconds (72 hours, NFR-003).
 */
export const EFFECT_RESERVATION_TTL_SECONDS = 259_200;

/**
 * Durable-task worker lease. `agentos.platform_durable_tasks` stays the schedule of
 * record, so a Redis flush loses no task.
 */
export const TASK_LEASE_TTL_MS = 30_000;

/**
 * Deletes the mutex only when the caller still owns the token, so a lock that has
 * already expired and been re-acquired is never released by its former holder.
 */
const RELEASE_MUTEX_SCRIPT = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  else
    return 0
  end
`;

/** Stored value of an effect reservation; `response` appears once it is resolved. */
interface StoredEffectReservation {
  readonly status: IdempotencyStatus;
  readonly hash: string;
  readonly response?: unknown;
}

/**
 * Refuses a key scope without a tenant, so no caller can build a global key that
 * every tenant would share.
 */
function assertTenantKeyScope(tenantId: string): void {
  if (tenantId.trim().length === 0) {
    throw new Error(
      'TENANT_CONTEXT_REQUIRED: refusing to build a tenant-scoped Redis key without a tenant id (NFR-006).',
    );
  }
}

/**
 * Refuses a key whose tenant-local segment is blank, which would otherwise collapse
 * every caller of that segment onto one shared key.
 *
 * @param segment - Tenant-local key segment, for example a session id.
 * @param name - Human name of the segment, used in the failure message.
 * @returns The segment, so a builder can interpolate it into the key.
 */
function assertKeySegment(segment: string, name: string): string {
  if (segment.trim().length === 0) {
    throw new Error(
      `${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_REQUIRED: refusing to build a tenant-scoped Redis key with a blank ${name}.`,
    );
  }

  return segment;
}

/**
 * Builds the session mutex key that serialises concurrent agent replies to one
 * customer session.
 *
 * @param tenantId - Authenticated tenant UUID.
 * @param sessionId - Server-issued session identifier.
 * @returns `tenant:{tenantId}:session:{sessionId}:mutex`.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank.
 */
export function sessionMutexKey(tenantId: string, sessionId: string): string {
  assertTenantKeyScope(tenantId);

  return `tenant:${tenantId}:session:${assertKeySegment(sessionId, 'session id')}:mutex`;
}

/**
 * Builds the human takeover lease key for one customer session.
 *
 * @param tenantId - Authenticated tenant UUID.
 * @param sessionId - Server-issued session identifier.
 * @returns `tenant:{tenantId}:session:{sessionId}:takeover_lock`.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank.
 */
export function sessionTakeoverLockKey(tenantId: string, sessionId: string): string {
  assertTenantKeyScope(tenantId);

  return `tenant:${tenantId}:session:${assertKeySegment(sessionId, 'session id')}:takeover_lock`;
}

/**
 * Builds the idempotency key that binds one `effect_key` of one tenant to the
 * payload it was first used with.
 *
 * @param tenantId - Authenticated tenant UUID.
 * @param effectKey - Caller-supplied effect key.
 * @returns `tenant:{tenantId}:effect:{effectKey}`.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank.
 */
export function effectReservationKey(tenantId: string, effectKey: string): string {
  assertTenantKeyScope(tenantId);

  return `tenant:${tenantId}:effect:${assertKeySegment(effectKey, 'effect key')}`;
}

/**
 * Builds the worker lease key of one durable task run.
 *
 * @param tenantId - Authenticated tenant UUID.
 * @param runId - Durable-task run identifier.
 * @returns `tenant:{tenantId}:task:{runId}:lease`.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank.
 */
export function taskLeaseKey(tenantId: string, runId: string): string {
  assertTenantKeyScope(tenantId);

  return `tenant:${tenantId}:task:${assertKeySegment(runId, 'run id')}:lease`;
}

/**
 * Builds the sliding-window counter key of one rate-limited entity.
 *
 * The window length is caller-supplied: the permitted rate is tenant policy and is
 * not decided in this package.
 *
 * @param tenantId - Authenticated tenant UUID.
 * @param entity - Rate-limited subject, for example an agent code or channel.
 * @param window - Window label, for example `1m`.
 * @returns `tenant:{tenantId}:ratelimit:{entity}:{window}`.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank.
 */
export function rateLimitKey(tenantId: string, entity: string, window: string): string {
  assertTenantKeyScope(tenantId);

  const entitySegment = assertKeySegment(entity, 'rate-limit entity');
  const windowSegment = assertKeySegment(window, 'rate-limit window');

  return `tenant:${tenantId}:ratelimit:${entitySegment}:${windowSegment}`;
}

/**
 * Builds the Layer 1 working-memory key of one dialog session.
 *
 * Keyed by the server-issued session id, never by an unverified customer handle, and
 * deliberately without a TTL constant here: the retention decision is tenant policy
 * (ASM-005) and is applied by the writer.
 *
 * @param tenantId - Authenticated tenant UUID.
 * @param sessionId - Server-issued session identifier.
 * @returns `tenant:{tenantId}:wm:{sessionId}`.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank.
 */
export function workingMemoryKey(tenantId: string, sessionId: string): string {
  assertTenantKeyScope(tenantId);

  return `tenant:${tenantId}:wm:${assertKeySegment(sessionId, 'session id')}`;
}

/**
 * Acquires the session mutex with `SET NX PX`, so exactly one agent can reply to a
 * session at a time.
 *
 * @param client - Injected Redis client; this package never constructs one.
 * @param tenantId - Authenticated tenant UUID.
 * @param sessionId - Server-issued session identifier.
 * @param lockOwnerToken - Unique token of this holder, required to release the lock.
 * @param ttlMs - Lease in milliseconds; defaults to the 30s session mutex lease.
 * @returns `true` when the mutex is now held by `lockOwnerToken`.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank.
 */
export async function acquireSessionMutex(
  client: RedisInjectedClient,
  tenantId: string,
  sessionId: string,
  lockOwnerToken: string,
  ttlMs: number = SESSION_MUTEX_TTL_MS,
): Promise<boolean> {
  const key = sessionMutexKey(tenantId, sessionId);
  const result = await client.set(key, lockOwnerToken, 'PX', ttlMs, 'NX');

  return result === 'OK';
}

/**
 * Releases the session mutex, but only when `lockOwnerToken` is still the stored
 * holder, so a lease that expired and was re-acquired is never released by its
 * former holder.
 *
 * @param client - Injected Redis client; this package never constructs one.
 * @param tenantId - Authenticated tenant UUID.
 * @param sessionId - Server-issued session identifier.
 * @param lockOwnerToken - Token the lock was acquired with.
 * @returns `true` when this call deleted the lock.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank.
 */
export async function releaseSessionMutex(
  client: RedisInjectedClient,
  tenantId: string,
  sessionId: string,
  lockOwnerToken: string,
): Promise<boolean> {
  const key = sessionMutexKey(tenantId, sessionId);
  const result = await client.eval(RELEASE_MUTEX_SCRIPT, 1, key, lockOwnerToken);

  return result === 1;
}

/**
 * Reserves an `effect_key` for 72 hours, so a replayed webhook or a retried request
 * executes at most once (NFR-003).
 *
 * The reservation stores the SHA-256 digest of the payload: a replay with the same
 * payload reports the first execution's state, and a replay with a different payload
 * is refused rather than silently executed.
 *
 * @param client - Injected Redis client; this package never constructs one.
 * @param tenantId - Authenticated tenant UUID.
 * @param effectKey - Caller-supplied effect key.
 * @param payload - Request payload the effect key is bound to.
 * @returns The reservation, with `isNew: true` when this call created it.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank.
 * @throws Error `IDEMPOTENCY_CONFLICT` when the key was already used with a different payload.
 */
export async function reserveEffectKey(
  client: RedisInjectedClient,
  tenantId: string,
  effectKey: string,
  payload: unknown,
): Promise<IdempotencyReservation> {
  const key = effectReservationKey(tenantId, effectKey);
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const initialValue = JSON.stringify({
    status: 'PENDING',
    hash: payloadHash,
    createdAt: new Date().toISOString(),
  });

  const reserved = await client.set(
    key,
    initialValue,
    'EX',
    EFFECT_RESERVATION_TTL_SECONDS,
    'NX',
  );

  if (reserved === 'OK') {
    return { isNew: true, status: 'PENDING' };
  }

  const existingRaw = await client.get(key);

  if (existingRaw === null) {
    // The reservation expired between SET and GET: the caller may retry safely.
    return { isNew: true, status: 'PENDING' };
  }

  const existing = JSON.parse(existingRaw) as StoredEffectReservation;

  if (existing.hash !== payloadHash) {
    throw new Error(
      `IDEMPOTENCY_CONFLICT: effect key '${effectKey}' was already used with a different request payload.`,
    );
  }

  return existing.response === undefined
    ? { isNew: false, status: existing.status }
    : { isNew: false, status: existing.status, cachedResponse: existing.response };
}
