import { createHash } from 'node:crypto';

import type {
  IdempotencyReservation,
  IdempotencyStatus,
  RedisInjectedClient,
  SessionTakeoverAcquireRequest,
  SessionTakeoverLease,
  SessionTakeoverRenewRequest,
  SessionTakeoverRequest,
  SessionTakeoverResult,
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

/** Stored value of a takeover lease: the holder and the instant it was acquired. */
interface StoredSessionTakeover {
  readonly operator_id: string;
  readonly acquired_at: string;
}

/** Reply codes of the owner-checked takeover scripts, named for the decision they carry. */
const SESSION_TAKEOVER_SCRIPT_REPLY = {
  /** The mutation was applied to this operator's live lease. */
  APPLIED: 1,
  /** No lease is live: the caller's hold lapsed or was never acquired. */
  ABSENT: 0,
  /** The stored value is not an attributable lease. */
  UNATTRIBUTABLE: -1,
  /** The live lease belongs to another operator. */
  OTHER_OPERATOR: -2,
} as const;

/**
 * Extends a takeover lease only for the operator the stored value names, so a heartbeat
 * for an operator who no longer holds the conversation can never take the lease back
 * (SCR-005).
 *
 * The owner check and the extension are one script, so no competing acquire or release can
 * slip between them. It never writes a lease that is not there: renewing is not acquiring.
 */
const RENEW_SESSION_TAKEOVER_SCRIPT = `
  local current = redis.call("get", KEYS[1])
  if not current then
    return 0
  end
  local ok, lease = pcall(cjson.decode, current)
  if not ok or type(lease) ~= "table" then
    return -1
  end
  if type(lease["operator_id"]) ~= "string" or type(lease["acquired_at"]) ~= "string" then
    return -1
  end
  if lease["operator_id"] ~= ARGV[1] then
    return -2
  end
  redis.call("pexpire", KEYS[1], ARGV[2])
  return 1
`;

/**
 * Deletes a takeover lease only for the operator the stored value names, so an operator
 * whose lease lapsed and was re-acquired by someone else never releases the new holder
 * (`07` §6.2: owner-checked, never a double release).
 *
 * The owner check and the delete are one script. A lease that is absent stays absent, and
 * another operator's live lease is left untouched.
 */
const RELEASE_SESSION_TAKEOVER_SCRIPT = `
  local current = redis.call("get", KEYS[1])
  if not current then
    return 0
  end
  local ok, lease = pcall(cjson.decode, current)
  if not ok or type(lease) ~= "table" then
    return -1
  end
  if type(lease["operator_id"]) ~= "string" or type(lease["acquired_at"]) ~= "string" then
    return -1
  end
  if lease["operator_id"] ~= ARGV[1] then
    return -2
  end
  redis.call("del", KEYS[1])
  return 1
`;

/**
 * Refuses a takeover lease operation with no operator: a blank holder would match every
 * blank owner check, so the lease could not be attributed to anyone.
 */
function assertLeaseOperator(operatorId: string): string {
  if (operatorId.trim().length === 0) {
    throw new Error(
      'OPERATOR_ID_REQUIRED: refusing a takeover lease operation with a blank operator id; a lease that names no holder cannot be owner-checked.',
    );
  }

  return operatorId;
}

/**
 * Converts the wire's whole seconds into the milliseconds Redis expires a key with, and
 * refuses a window that would write a lease with no lifetime at all.
 *
 * @param seconds - Requested window in whole seconds.
 * @param field - Wire field name, used in the failure message.
 * @returns The same window in milliseconds.
 * @throws Error `SESSION_TAKEOVER_WINDOW_INVALID` when the window is not a positive integer.
 */
function leaseWindowMs(seconds: number, field: 'ttl_seconds' | 'extend_seconds'): number {
  if (!Number.isInteger(seconds) || seconds <= 0) {
    throw new Error(
      `SESSION_TAKEOVER_WINDOW_INVALID: refusing a takeover lease ${field} of ${String(seconds)}; the lease window is a whole number of seconds greater than zero.`,
    );
  }

  return seconds * 1000;
}

/**
 * Reads a stored takeover value, or `null` when it is not the canonical lease shape: a
 * value no operator can be verified against is never treated as a held lease.
 *
 * @param raw - Stored value of the takeover key.
 * @returns The holder and acquisition instant, or `null` when the value is malformed.
 */
function parseSessionTakeover(raw: string): StoredSessionTakeover | null {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const stored = parsed as { operator_id?: unknown; acquired_at?: unknown };
  const operatorId = typeof stored.operator_id === 'string' ? stored.operator_id : '';
  const acquiredAt = typeof stored.acquired_at === 'string' ? stored.acquired_at : '';

  if (operatorId.trim().length === 0 || acquiredAt.trim().length === 0) {
    return null;
  }

  return { operator_id: operatorId, acquired_at: acquiredAt };
}

/**
 * Projects the live takeover lease of one key: the operator that stored it, and the instant
 * the key's remaining PTTL ends on the injected clock.
 *
 * @param client - Injected Redis client; this package never constructs one.
 * @param key - Canonical takeover key to read.
 * @param now - Injected clock the expiry is derived from; never a stored instant.
 * @returns The lease, or `null` when nothing is held: the key is absent, already lapsed or
 *   carries no expiry (an unbounded hold is not a lease), or holds a malformed value.
 */
async function readLiveSessionTakeover(
  client: RedisInjectedClient,
  key: string,
  now: () => Date,
): Promise<SessionTakeoverLease | null> {
  const raw = await client.get(key);

  if (raw === null) {
    return null;
  }

  const stored = parseSessionTakeover(raw);

  if (stored === null) {
    return null;
  }

  const remainingMs = await client.pttl(key);

  // `-2` (absent), `-1` (no expiry) and `0` all mean the key does not end in the future, so
  // whatever it holds is not a live lease.
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return null;
  }

  return {
    operator_id: stored.operator_id,
    expires_at: new Date(now().getTime() + remainingMs).toISOString(),
  };
}

/**
 * Acquires the operator takeover lease of one conversation with `SET NX PX`, so exactly one
 * operator holds the conversation at a time (`03` §3, `07` §6.2).
 *
 * The stored value holds the operator and the acquisition instant only; the expiry lives on
 * the key's TTL. A re-issue by the operator that already holds the lease extends that live
 * lease instead of stacking a second one, and the extension is owner-checked inside Redis.
 * Another operator's lease is never touched, and is reported as held by them.
 *
 * @param client - Injected Redis client; this package never constructs one.
 * @param input - Tenant, conversation, operator and the requested window in seconds.
 * @param now - Injected clock stamped as `acquired_at` and used to derive `expires_at`.
 * @returns The outcome and, when the caller holds the lease, its live projection.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenant_id` is blank.
 * @throws Error `SESSION_ID_REQUIRED` when `conversation_id` is blank.
 * @throws Error `OPERATOR_ID_REQUIRED` when `operator_id` is blank.
 * @throws Error `SESSION_TAKEOVER_WINDOW_INVALID` when `ttl_seconds` is not a positive integer.
 */
export async function acquireSessionTakeover(
  client: RedisInjectedClient,
  input: SessionTakeoverAcquireRequest,
  now: () => Date = () => new Date(),
): Promise<SessionTakeoverResult> {
  const operatorId = assertLeaseOperator(input.operator_id);
  const ttlMs = leaseWindowMs(input.ttl_seconds, 'ttl_seconds');
  const key = sessionTakeoverLockKey(input.tenant_id, input.conversation_id);
  const value = JSON.stringify({ operator_id: operatorId, acquired_at: now().toISOString() });

  // Two passes are enough for both races this call can meet: a re-issue by the current
  // holder, and a lease that lapsed between the refused compare-and-set and the owner check.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const stored = await client.set(key, value, 'PX', ttlMs, 'NX');

    if (stored === 'OK') {
      return { outcome: 'ACQUIRED', lease: await readLiveSessionTakeover(client, key, now) };
    }

    const renewed = await client.eval(RENEW_SESSION_TAKEOVER_SCRIPT, 1, key, operatorId, ttlMs);

    if (typeof renewed !== 'number') {
      // A reply this helper cannot read is not a lease, and never a success.
      return { outcome: 'NOT_HELD', lease: null };
    }

    if (renewed === SESSION_TAKEOVER_SCRIPT_REPLY.APPLIED) {
      return { outcome: 'RENEWED', lease: await readLiveSessionTakeover(client, key, now) };
    }

    if (renewed === SESSION_TAKEOVER_SCRIPT_REPLY.OTHER_OPERATOR) {
      return { outcome: 'HELD_BY_ANOTHER_OPERATOR', lease: null };
    }

    if (renewed === SESSION_TAKEOVER_SCRIPT_REPLY.UNATTRIBUTABLE) {
      // Something occupies the key that is no operator's lease, so no operator can hold it.
      return { outcome: 'NOT_HELD', lease: null };
    }

    // The lease lapsed between the refused compare-and-set and the owner check: try again.
  }

  // The key kept changing hands across both attempts: report what this call could establish,
  // which is nothing.
  return { outcome: 'NOT_HELD', lease: null };
}

/**
 * Extends the operator takeover lease of one conversation, but only for the operator that
 * holds it. A lease that lapsed is reported as expired and is never re-created, so a
 * heartbeat can never take a conversation that no longer belongs to the caller.
 *
 * @param client - Injected Redis client; this package never constructs one.
 * @param input - Tenant, conversation, operator and the requested extension in seconds.
 * @param now - Injected clock used to derive `expires_at` from the renewed PTTL.
 * @returns The outcome and, when the caller still holds the lease, its live projection.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenant_id` is blank.
 * @throws Error `SESSION_ID_REQUIRED` when `conversation_id` is blank.
 * @throws Error `OPERATOR_ID_REQUIRED` when `operator_id` is blank.
 * @throws Error `SESSION_TAKEOVER_WINDOW_INVALID` when `extend_seconds` is not a positive integer.
 */
export async function renewSessionTakeover(
  client: RedisInjectedClient,
  input: SessionTakeoverRenewRequest,
  now: () => Date = () => new Date(),
): Promise<SessionTakeoverResult> {
  const operatorId = assertLeaseOperator(input.operator_id);
  const extendMs = leaseWindowMs(input.extend_seconds, 'extend_seconds');
  const key = sessionTakeoverLockKey(input.tenant_id, input.conversation_id);
  const reply = await client.eval(RENEW_SESSION_TAKEOVER_SCRIPT, 1, key, operatorId, extendMs);

  if (typeof reply !== 'number') {
    return { outcome: 'NOT_HELD', lease: null };
  }

  if (reply === SESSION_TAKEOVER_SCRIPT_REPLY.APPLIED) {
    return { outcome: 'RENEWED', lease: await readLiveSessionTakeover(client, key, now) };
  }

  if (reply === SESSION_TAKEOVER_SCRIPT_REPLY.OTHER_OPERATOR) {
    return { outcome: 'HELD_BY_ANOTHER_OPERATOR', lease: null };
  }

  if (reply === SESSION_TAKEOVER_SCRIPT_REPLY.ABSENT) {
    return { outcome: 'EXPIRED', lease: null };
  }

  // The stored value is not an attributable lease: there is nothing of this operator's to
  // extend.
  return { outcome: 'NOT_HELD', lease: null };
}

/**
 * Releases the operator takeover lease of one conversation, and only for the operator that
 * holds it: a lease that lapsed and was re-acquired by someone else is never released by
 * its former holder (`07` §6.2).
 *
 * Releasing a lease nobody holds is a no-op reported as `NOT_HELD`, never a double release.
 *
 * @param client - Injected Redis client; this package never constructs one.
 * @param input - Tenant, conversation and the operator the release is checked against.
 * @returns The outcome; `lease` is always `null`, because nothing is held afterwards.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenant_id` is blank.
 * @throws Error `SESSION_ID_REQUIRED` when `conversation_id` is blank.
 * @throws Error `OPERATOR_ID_REQUIRED` when `operator_id` is blank.
 */
export async function releaseSessionTakeover(
  client: RedisInjectedClient,
  input: SessionTakeoverRequest,
): Promise<SessionTakeoverResult> {
  const operatorId = assertLeaseOperator(input.operator_id);
  const key = sessionTakeoverLockKey(input.tenant_id, input.conversation_id);
  const reply = await client.eval(RELEASE_SESSION_TAKEOVER_SCRIPT, 1, key, operatorId);

  if (typeof reply !== 'number') {
    return { outcome: 'NOT_HELD', lease: null };
  }

  if (reply === SESSION_TAKEOVER_SCRIPT_REPLY.APPLIED) {
    // The release is what ended the hold, so the lease is no longer live for anyone. The
    // shared outcome vocabulary names that end state `EXPIRED`: it is the only member that
    // claims nothing false about a lease that no longer exists.
    return { outcome: 'EXPIRED', lease: null };
  }

  if (reply === SESSION_TAKEOVER_SCRIPT_REPLY.OTHER_OPERATOR) {
    return { outcome: 'HELD_BY_ANOTHER_OPERATOR', lease: null };
  }

  // An absent key, a lease nobody can be verified against, or a reply this client cannot
  // read: either way this operator holds nothing to release.
  return { outcome: 'NOT_HELD', lease: null };
}

/**
 * Reads who holds the operator takeover lease of one conversation, without mutating it
 * (SCR-005 live check).
 *
 * @param client - Injected Redis client; this package never constructs one.
 * @param tenantId - Authenticated tenant UUID.
 * @param conversationId - Conversation whose takeover lease is read.
 * @param now - Injected clock used to derive `expires_at` from the key's PTTL.
 * @returns The live lease, or `null` when no lease is held: the key is absent, has lapsed or
 *   carries no expiry, or its value is malformed.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank.
 * @throws Error `SESSION_ID_REQUIRED` when `conversationId` is blank.
 */
export async function readSessionTakeover(
  client: RedisInjectedClient,
  tenantId: string,
  conversationId: string,
  now: () => Date = () => new Date(),
): Promise<SessionTakeoverLease | null> {
  return readLiveSessionTakeover(client, sessionTakeoverLockKey(tenantId, conversationId), now);
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
