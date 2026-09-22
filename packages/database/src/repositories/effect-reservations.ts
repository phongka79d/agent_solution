import type { PoolClient, QueryResultRow } from 'pg';

import type {
  EffectReservationKey,
  EffectReservationOutcome,
  EffectReservationRecord,
  EffectReservationReopen,
  EffectReservationRequest,
  EffectReservationRunScope,
  EffectReservationSettlement,
  EffectReservationStatus,
} from '../contracts/index.js';
import { withTenantContext } from '../rls.js';

/**
 * Binds one tenant to one transaction and hands the caller the `pg` client of that transaction.
 *
 * Structural on purpose: `withTenantContext` (implement/03 §2) is the only sanctioned binder, and a
 * test may substitute one. Because every statement below runs through it, every statement sees the
 * transaction-local `app.current_tenant_id` the row-level security policy requires.
 */
export type TenantTransactionRunner = <T>(
  tenantId: string,
  work: (client: PoolClient) => Promise<T>,
) => Promise<T>;

/** `agentos` is not on the connection `search_path`, so every statement is schema-qualified. */
const EFFECT_RESERVATIONS = 'agentos.effect_reservations';

/**
 * The columns every read publishes. Two deliberate details:
 *
 *  * `expired` is computed against `CURRENT_TIMESTAMP` — the durable clock of the implement/04
 *    §3.2.3 decision table — never against the application clock of the caller.
 *  * `request_fingerprint` is read through `rtrim` because the column is `CHAR(64)`, which
 *    blank-pads a shorter value instead of rejecting it; writes refuse such a value outright.
 */
const RESERVATION_PROJECTION = `
    tenant_id,
    effect_key,
    request_id,
    rtrim(request_fingerprint) AS request_fingerprint,
    run_id,
    step_index,
    skill_id,
    status,
    response_receipt,
    reserved_at,
    resolved_at,
    expires_at,
    expires_at <= CURRENT_TIMESTAMP AS expired`;

const SELECT_RESERVATION = `SELECT${RESERVATION_PROJECTION}
  FROM ${EFFECT_RESERVATIONS}
  WHERE tenant_id = $1 AND effect_key = $2`;

const SELECT_RESERVATION_FOR_UPDATE = `${SELECT_RESERVATION}
  FOR UPDATE`;

const SELECT_OPEN_RESERVATIONS_BY_RUN = `SELECT${RESERVATION_PROJECTION}
  FROM ${EFFECT_RESERVATIONS}
  WHERE tenant_id = $1 AND run_id = $2 AND status = 'RESERVED'
  ORDER BY step_index`;

/**
 * `expires_at` is omitted so the durable column default (the 72 h window) stays the single source of
 * the reservation window; the variant below carries it when a caller that owns the TTL supplies it.
 */
const INSERT_RESERVATION = `INSERT INTO ${EFFECT_RESERVATIONS} (
    tenant_id,
    effect_key,
    request_id,
    request_fingerprint,
    run_id,
    step_index,
    skill_id
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7)
  ON CONFLICT (tenant_id, effect_key) DO NOTHING
  RETURNING${RESERVATION_PROJECTION}`;

const INSERT_RESERVATION_WITH_EXPIRY = `INSERT INTO ${EFFECT_RESERVATIONS} (
    tenant_id,
    effect_key,
    request_id,
    request_fingerprint,
    run_id,
    step_index,
    skill_id,
    expires_at
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
  ON CONFLICT (tenant_id, effect_key) DO NOTHING
  RETURNING${RESERVATION_PROJECTION}`;

const SETTLE_RESERVATION = `UPDATE ${EFFECT_RESERVATIONS}
  SET status = $3,
      response_receipt = $4::jsonb,
      resolved_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND effect_key = $2
  RETURNING effect_key`;

const REOPEN_RESERVATION = `UPDATE ${EFFECT_RESERVATIONS}
  SET status = 'RESERVED',
      expires_at = $3::timestamptz,
      resolved_at = NULL
  WHERE tenant_id = $1 AND effect_key = $2 AND status = 'FAILED'
  RETURNING effect_key`;

const EXPIRE_RESERVATION = `UPDATE ${EFFECT_RESERVATIONS}
  SET status = 'EXPIRED',
      resolved_at = CURRENT_TIMESTAMP
  WHERE tenant_id = $1 AND effect_key = $2 AND status = 'RESERVED'
  RETURNING effect_key`;

/**
 * Statuses `resolve()` may settle from: an unproven `RESERVED` row, an escalated `EXPIRED` row, and
 * a `FAILED` row whose confirmed absence was disproved by a later provider check (implement/04 §4.4
 * step 2). `SUCCEEDED` is deliberately absent: a settled success is terminal.
 */
const RESOLVABLE_FROM: readonly EffectReservationStatus[] = ['RESERVED', 'EXPIRED', 'FAILED'];

/** Statuses `settleReservation()` may settle in place: only a live, unproven `RESERVED` row. */
const SETTLEABLE_FROM: readonly EffectReservationStatus[] = ['RESERVED'];

/** Bare lowercase hex SHA-256: the single accepted encoding of every digest in this schema. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** One reservation row exactly as `pg` returns it, before the projection is published. */
interface EffectReservationRow extends QueryResultRow {
  tenant_id: string;
  effect_key: string;
  request_id: string;
  request_fingerprint: string;
  run_id: string;
  step_index: number;
  skill_id: string;
  status: EffectReservationStatus;
  response_receipt: unknown;
  reserved_at: Date;
  resolved_at: Date | null;
  expires_at: Date;
  expired: boolean;
}

type SettlementResult = 'SETTLED' | 'UNCHANGED' | 'MISSING' | 'REFUSED';

/**
 * Publishes one row with its timestamps as ISO-8601 UTC strings, so the durable row survives
 * serialization into a worker checkpoint or an API projection unchanged.
 */
function toRecord(row: EffectReservationRow): EffectReservationRecord {
  return {
    tenant_id: row.tenant_id,
    effect_key: row.effect_key,
    request_id: row.request_id,
    request_fingerprint: row.request_fingerprint,
    run_id: row.run_id,
    step_index: row.step_index,
    skill_id: row.skill_id,
    status: row.status,
    response_receipt: row.response_receipt,
    reserved_at: row.reserved_at.toISOString(),
    resolved_at: row.resolved_at === null ? null : row.resolved_at.toISOString(),
    expires_at: row.expires_at.toISOString(),
    expired: row.expired,
  };
}

/**
 * The persisted half of the implement/04 §3.2.3 decision table for an existing row. The caller has
 * already compared `request_fingerprint`: a different payload is a `CONFLICT`, never a merge.
 */
function decideReservation(existing: EffectReservationRow): EffectReservationOutcome {
  switch (existing.status) {
    case 'SUCCEEDED':
      // Same key, same fingerprint, already settled: the stored receipt is the answer.
      return { kind: 'REPLAY', receipt: existing.response_receipt ?? null };
    case 'RESERVED':
      // In flight while the window is open; once it has lapsed the effect is still unproven.
      return existing.expired ? { kind: 'RECONCILE_REQUIRED' } : { kind: 'IN_FLIGHT' };
    case 'FAILED':
    case 'EXPIRED':
      // A prior failed attempt and an escalated reservation are both reconciled by key (§4.4).
      return { kind: 'RECONCILE_REQUIRED' };
    default:
      throw new Error(
        `EFFECT_RESERVATION_STATUS_UNKNOWN: effect_key ${existing.effect_key} carries the status ` +
          `${String(existing.status)}, which the durable decision table cannot classify; ` +
          'refusing to guess (implement/03 §1 DOMAIN 5).',
      );
  }
}

function assertEffectKey(effect_key: unknown): void {
  if (typeof effect_key !== 'string' || effect_key.trim().length === 0) {
    throw new Error(
      'EFFECT_RESERVATION_KEY_REQUIRED: a reservation is addressed by the durable key ' +
        '(tenant_id, effect_key); effect_key must be a non-empty string.',
    );
  }
}

/**
 * Normalizes and validates the canonical payload fingerprint (implement/04 §3.2.3).
 *
 * This is a fail-closed guard, not decoration: `request_fingerprint` is `CHAR(64)`, so a shorter
 * digest would be blank-padded by the column and a prefixed one would never compare equal — both
 * would silently weaken the "same payload" test that a replay depends on.
 */
function normalizeFingerprint(request_fingerprint: unknown): string {
  const normalized =
    typeof request_fingerprint === 'string' ? request_fingerprint.trim().toLowerCase() : '';

  if (!SHA256_HEX.test(normalized)) {
    throw new Error(
      'EFFECT_RESERVATION_FINGERPRINT_INVALID: request_fingerprint must be the bare lowercase ' +
        '64-character hex SHA-256 of the canonical request payload.',
    );
  }

  return normalized;
}

/**
 * Serializes the durable receipt. An absent receipt stores SQL `NULL`; a value JSON cannot
 * represent is refused instead of being silently dropped, because a settlement is the record of
 * what the provider proved.
 */
function serializeReceipt(receipt: unknown): string | null {
  if (receipt === undefined || receipt === null) {
    return null;
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(receipt);
  } catch (error) {
    throw new Error(
      'EFFECT_RESERVATION_RECEIPT_UNSERIALIZABLE: the settlement receipt is not JSON-serializable, ' +
        'so it cannot be stored durably.',
      { cause: error },
    );
  }

  if (serialized === undefined) {
    throw new Error(
      'EFFECT_RESERVATION_RECEIPT_UNSERIALIZABLE: the settlement receipt is not JSON-serializable, ' +
        'so it cannot be stored durably.',
    );
  }

  return serialized;
}

/**
 * Durable effect reservations on PostgreSQL (`agentos.effect_reservations`, implement/03 §1 DOMAIN 5).
 *
 * PostgreSQL is the authority for at-most-once execution (NFR-003, BR-005, BR-006). Redis may cache
 * the same key for latency, but it never decides idempotency: every outcome below is read from, or
 * arbitrated by, the unique key `(tenant_id, effect_key)`. Every method opens exactly one
 * tenant-scoped transaction through `withTenantContext`, so the transaction-local
 * `app.current_tenant_id` binding and the tenant predicate always agree and no statement can run
 * unscoped.
 *
 * The surface is the core-engine port plus the §3.2.3 composite the orchestrator calls:
 *
 *  * `reserve()` — arbitration in ONE transaction: insert the key, or lock the existing row,
 *    compare the canonical fingerprint and report `RESERVED` / `REPLAY` / `IN_FLIGHT` /
 *    `RECONCILE_REQUIRED` / `CONFLICT`. A mismatched payload is never merged or overwritten.
 *  * `resolve()` — settlement of `SUCCEEDED` (with the durable receipt) or a provider-confirmed
 *    `FAILED` absence. `UNKNOWN` is not a settlement: the row stays `RESERVED`.
 *  * `getReservation()` / `listOpenByRun()` — the lookups the reconciliation loop (implement/04
 *    §4.4) loads before it, or the provider, may decide anything.
 *  * `insertReservation()` / `settleReservation()` / `reopenReservation()` / `expireReservation()` —
 *    the row primitives the core-engine port declares, sharing the same statements as the methods
 *    above so there is exactly one implementation of each transition.
 */
export class EffectReservationRepository {
  private readonly runInTenantTransaction: TenantTransactionRunner;

  /**
   * @param runInTenantTransaction Binds a tenant to the transaction every statement runs in.
   * Defaults to the package's `withTenantContext` binder.
   */
  constructor(runInTenantTransaction: TenantTransactionRunner = withTenantContext) {
    this.runInTenantTransaction = runInTenantTransaction;
  }

  /**
   * Reserves one effect key, or reports why it cannot be dispatched (implement/04 §3.2.3).
   *
   * The arbitration is a single transaction: `INSERT ... ON CONFLICT (tenant_id, effect_key) DO
   * NOTHING` decides the winner, and when this caller lost the race the existing row is locked
   * (`SELECT ... FOR UPDATE`) so the fingerprint and status it reports cannot change under it.
   * Concurrent callers with the same key therefore resolve to exactly one `RESERVED`.
   *
   * @param input Canonical reservation request; `run_id`, timestamps and random ids never enter the key.
   * @returns `RESERVED` (dispatch once), `REPLAY` with the stored receipt, `IN_FLIGHT`,
   * `RECONCILE_REQUIRED`, or `CONFLICT` when the same key carries a different payload.
   * @throws Error `EFFECT_RESERVATION_KEY_REQUIRED` / `EFFECT_RESERVATION_FINGERPRINT_INVALID` when
   * the input cannot address a durable row.
   * @throws Error `EFFECT_RESERVATION_IDENTITY_IN_USE` when `(tenant_id, request_id, skill_id,
   * step_index)` is already bound to another effect key.
   */
  async reserve(input: EffectReservationRequest): Promise<EffectReservationOutcome> {
    assertEffectKey(input.effect_key);
    const request_fingerprint = normalizeFingerprint(input.request_fingerprint);

    return this.runInTenantTransaction(
      input.tenant_id,
      async (client): Promise<EffectReservationOutcome> => {
        const inserted = await this.insertWithin(client, input, request_fingerprint);
        if (inserted !== null) {
          return { kind: 'RESERVED' };
        }

        const existing = await this.selectWithin(client, input, 'lock');
        if (existing === null) {
          throw new Error(
            `EFFECT_RESERVATION_UNSTABLE: effect_key ${input.effect_key} was reported as taken by ` +
              'the insert but no row is visible in this transaction; refusing to guess whether the ' +
              'effect may be dispatched.',
          );
        }

        if (existing.request_fingerprint !== request_fingerprint) {
          return { kind: 'CONFLICT' };
        }

        return decideReservation(existing);
      },
    );
  }

  /**
   * Settles a reservation with the outcome that was actually proven (implement/04 §3.2.3).
   *
   * This is the reconciliation-tolerant settlement: it applies to an unproven `RESERVED` row, to an
   * escalated `EXPIRED` row a human or the provider has now resolved, and to a `FAILED` row whose
   * confirmed absence was disproved by a later provider check. A settled `SUCCEEDED` row is
   * terminal — it is never downgraded to `FAILED` and its receipt is never overwritten — while
   * repeating the same settlement is a no-op, so a retried worker cannot rewrite durable truth.
   *
   * `UNKNOWN` is not a settlement: an indeterminate provider outcome leaves the row `RESERVED`
   * (implement/04 §3.2.4), which is what keeps a later reader from mistaking it for a no-op.
   *
   * @param input Tenant, key, settlement status and the receipt to store durably.
   * @throws Error `EFFECT_RESERVATION_NOT_FOUND` when no reservation row exists — a settlement never
   * creates one, because that would claim an effect that was never reserved.
   * @throws Error `EFFECT_RESERVATION_TERMINAL` when the row is already `SUCCEEDED`: a confirmed
   * success is never downgraded to `FAILED` and its receipt is never overwritten.
   */
  async resolve(input: EffectReservationSettlement): Promise<void> {
    assertEffectKey(input.effect_key);

    await this.runInTenantTransaction(input.tenant_id, async (client): Promise<void> => {
      const result = await this.settleWithin(client, input, RESOLVABLE_FROM);

      if (result === 'MISSING') {
        throw new Error(
          `EFFECT_RESERVATION_NOT_FOUND: no reservation is stored for effect_key ` +
            `${input.effect_key}; settle only an effect that was reserved first (BR-005).`,
        );
      }

      if (result === 'REFUSED') {
        throw new Error(
          `EFFECT_RESERVATION_TERMINAL: effect_key ${input.effect_key} is already settled ` +
            'SUCCEEDED; a confirmed success is never downgraded or overwritten (NFR-003).',
        );
      }
    });
  }

  /**
   * Reads the durable reservation for one key inside the caller's tenant scope.
   *
   * This is the reconciliation lookup of implement/04 §4.4: the caller (or the provider, through an
   * adapter) decides from `status`, `response_receipt` and `expired`, never from a cache.
   *
   * @param tenant_id Tenant that owns the row; also enforced by row-level security.
   * @param effect_key Deterministic effect key.
   * @returns The stored row, or `null` when this tenant holds no reservation for the key.
   */
  async getReservation(
    tenant_id: string,
    effect_key: string,
  ): Promise<EffectReservationRecord | null> {
    assertEffectKey(effect_key);

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const row = await this.selectWithin(client, { tenant_id, effect_key }, 'read');

      return row === null ? null : toRecord(row);
    });
  }

  /**
   * Loads the still-open reservations of one durable run (implement/04 §4.4 step 1).
   *
   * "Open" means `RESERVED`: the effect was claimed and its provider outcome is unproven. Each row
   * carries `expired` so the recovery loop can back off on an unproven effect and escalate only once
   * the window has lapsed.
   *
   * @param input Tenant and the durable `run_id` whose open reservations are loaded.
   * @returns The open rows in step order; an empty list when nothing is outstanding.
   */
  async listOpenByRun(
    input: EffectReservationRunScope,
  ): Promise<readonly EffectReservationRecord[]> {
    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<EffectReservationRow>(SELECT_OPEN_RESERVATIONS_BY_RUN, [
        input.tenant_id,
        input.run_id,
      ]);

      return result.rows.map(toRecord);
    });
  }

  /**
   * Inserts one reservation without arbitrating an existing row.
   *
   * @param input Canonical reservation request.
   * @returns The inserted row, or `null` when `(tenant_id, effect_key)` was already taken — the
   * caller then reads it (`getReservation`) instead of overlaying it.
   * @throws Error `EFFECT_RESERVATION_IDENTITY_IN_USE` when the request identity is already bound to
   * a different effect key.
   */
  async insertReservation(
    input: EffectReservationRequest,
  ): Promise<EffectReservationRecord | null> {
    assertEffectKey(input.effect_key);
    const request_fingerprint = normalizeFingerprint(input.request_fingerprint);

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const row = await this.insertWithin(client, input, request_fingerprint);

      return row === null ? null : toRecord(row);
    });
  }

  /**
   * Strict primitive behind `resolve()`: settles only a live `RESERVED` row in place.
   *
   * @param input Tenant, key, settlement status and receipt.
   * @returns `true` when this call performed the settlement; `false` when there is no such row, it
   * was already settled, or it is not settleable in place (use `resolve()` for the reconciliation
   * transitions).
   */
  async settleReservation(input: EffectReservationSettlement): Promise<boolean> {
    assertEffectKey(input.effect_key);

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await this.settleWithin(client, input, SETTLEABLE_FROM);

      return result === 'SETTLED';
    });
  }

  /**
   * Returns a `FAILED` reservation to `RESERVED` with a fresh window (implement/04 §4.4 step 3).
   *
   * A provider-confirmed absence is the only condition that clears the way for one more dispatch
   * under the SAME effect key, so the retry re-enters `reserve()`, finds a live reservation and
   * cannot become a second effect. The previous absence receipt is kept for the audit trail; the
   * next settlement overwrites it with the receipt of the attempt that actually ran.
   *
   * @param input Tenant, key and the ISO-8601 expiry of the new window.
   * @returns `true` when the row was reopened; `false` when it is not a `FAILED` reservation.
   */
  async reopenReservation(input: EffectReservationReopen): Promise<boolean> {
    assertEffectKey(input.effect_key);

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query(REOPEN_RESERVATION, [
        input.tenant_id,
        input.effect_key,
        input.expires_at,
      ]);

      return result.rowCount === 1;
    });
  }

  /**
   * Escalates an indeterminate reservation to `EXPIRED` (implement/04 §4.4 step 4).
   *
   * Repeated reconciliation that cannot prove the outcome ends here: the reservation leaves the open
   * set so the durable task can park in `awaiting_human`, and `reserve()` keeps reporting
   * `RECONCILE_REQUIRED` for the key instead of dispatching a second effect. Call this only once the
   * window has lapsed — the row's `expired` flag is that condition — and note that `resolved_at`
   * records the escalation, not a settlement.
   *
   * @param input Tenant and effect key.
   * @returns `true` when a live `RESERVED` row was escalated; `false` otherwise.
   */
  async expireReservation(input: EffectReservationKey): Promise<boolean> {
    assertEffectKey(input.effect_key);

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query(EXPIRE_RESERVATION, [
        input.tenant_id,
        input.effect_key,
      ]);

      return result.rowCount === 1;
    });
  }

  /**
   * The unreserved insert: it never updates a row that another dispatch already owns.
   *
   * @returns The inserted row, or `null` when `(tenant_id, effect_key)` already existed.
   */
  private async insertWithin(
    client: PoolClient,
    input: EffectReservationRequest,
    request_fingerprint: string,
  ): Promise<EffectReservationRow | null> {
    const params: unknown[] = [
      input.tenant_id,
      input.effect_key,
      input.request_id,
      request_fingerprint,
      input.run_id,
      input.step_index,
      input.skill_id,
    ];
    let statement = INSERT_RESERVATION;

    if (input.expires_at !== undefined) {
      statement = INSERT_RESERVATION_WITH_EXPIRY;
      params.push(input.expires_at);
    }

    try {
      const result = await client.query<EffectReservationRow>(statement, params);

      return result.rows[0] ?? null;
    } catch (error) {
      // 23505 unique_violation is the only way this insert can lose an argument beyond the key
      // conflict the ON CONFLICT clause absorbs: the inbound request identity is already bound to a
      // different effect key (uq_effect_reservation_request), which this keyspace forbids.
      const code =
        typeof error === 'object' && error !== null
          ? (error as { code?: unknown }).code
          : undefined;

      if (code === '23505') {
        const constraint = (error as { constraint?: unknown }).constraint;

        throw new Error(
          'EFFECT_RESERVATION_IDENTITY_IN_USE: the inbound request identity ' +
            `(tenant_id, request_id, skill_id, step_index) is already bound to another effect key` +
            `${typeof constraint === 'string' ? ` (constraint ${constraint})` : ''}; a second action ` +
            'revision of the same inbound request cannot be reserved (implement/03 §1 DOMAIN 5).',
          { cause: error },
        );
      }

      throw error;
    }
  }

  /**
   * Reads one row, locking it when the caller is about to decide on it.
   */
  private async selectWithin(
    client: PoolClient,
    key: EffectReservationKey,
    mode: 'read' | 'lock',
  ): Promise<EffectReservationRow | null> {
    const statement = mode === 'lock' ? SELECT_RESERVATION_FOR_UPDATE : SELECT_RESERVATION;
    const result = await client.query<EffectReservationRow>(statement, [
      key.tenant_id,
      key.effect_key,
    ]);

    return result.rows[0] ?? null;
  }

  /**
   * One settlement path for both entry points: lock the row, decide the transition, then write it
   * with `resolved_at` on the database clock.
   *
   * The rules are deliberately asymmetric: a settled `SUCCEEDED` row is terminal, while a `FAILED`
   * row may still be proven succeeded by a later provider check — the receipt then belongs to the
   * new truth. Repeating the same settlement is a no-op, so a retried worker cannot rewrite a
   * stored receipt.
   */
  private async settleWithin(
    client: PoolClient,
    settlement: EffectReservationSettlement,
    settleable_from: readonly EffectReservationStatus[],
  ): Promise<SettlementResult> {
    const existing = await this.selectWithin(client, settlement, 'lock');

    if (existing === null) {
      return 'MISSING';
    }

    if (existing.status === settlement.status) {
      return 'UNCHANGED';
    }

    if (existing.status === 'SUCCEEDED' || !settleable_from.includes(existing.status)) {
      return 'REFUSED';
    }

    const result = await client.query(SETTLE_RESERVATION, [
      settlement.tenant_id,
      settlement.effect_key,
      settlement.status,
      serializeReceipt(settlement.receipt),
    ]);

    return result.rowCount === 1 ? 'SETTLED' : 'MISSING';
  }
}
