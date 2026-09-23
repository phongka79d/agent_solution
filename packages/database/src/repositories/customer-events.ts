import type { QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import { assertIdentifier, serializeJsonb } from './durable-workflows.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

/**
 * The web/app behavioural event stream on PostgreSQL (`agentos.customer_events`, implement/03 §1
 * DOMAIN 1 Entity 4, implement/06 §8.1 R04/R12 and §9.2).
 *
 * `customer_events` is an append-only ingestion journal: `source_event_id` is the immutable identity
 * the source supplies and `uq_customer_events_source (tenant_id, source_event_id)` is the
 * deduplication key of the whole stream. Three rules shape every method below:
 *
 *  * **A delivery is appended at most once.** `append()` inserts with `ON CONFLICT ... DO NOTHING`:
 *    a replayed or late delivery of an identity that is already stored inserts nothing, raises
 *    nothing and — critically — updates nothing, because a replay never rewrites history
 *    (implement/06 §9.2 "Ordering and late events" / "Replay safety").
 *  * **Ordering is durable, never the arrival order.** The timeline is ordered and paged by the
 *    `(occurred_at, id)` pair the source reported, so a late delivery is retained and projected at
 *    the position its own instant gives it.
 *  * **Tenant-scoped by construction.** Each call opens exactly one `withTenantContext()`
 *    transaction, so the transaction-local `app.current_tenant_id` binding and the `tenant_id`
 *    predicate always agree and RLS (NFR-006) denies an unbound read or write. A customer of
 *    another tenant is never another tenant's timeline.
 */

/** `agentos` is not on the connection `search_path`, so every statement is schema-qualified. */
const CUSTOMER_EVENTS = 'agentos.customer_events';

/** The owning document of every refusal this module raises. */
const CODE_OWNER = 'implement/03 §1 DOMAIN 1 Entity 4, implement/06 §8.1 R04/R12 and §9.2';

/** Separator of the `<occurred_at>|<event_id>` keyset cursor this module publishes and accepts. */
const CURSOR_SEPARATOR = '|';

/** Default page size of `listTimeline()`, and the largest page it accepts. */
const DEFAULT_TIMELINE_LIMIT = 50;
const MAX_TIMELINE_LIMIT = 200;

/** A canonical UUID: the type of `customer_events.id` and `customer_events.customer_id`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One `agentos.customer_events` row, published with its instant as an ISO-8601 UTC string. */
export interface CustomerEventTimelineItem {
  readonly event_id: string;
  readonly source_event_id: string;
  readonly event_name: string;
  readonly session_id: string;
  readonly channel: string;
  readonly occurred_at: string;
  readonly payload: Record<string, unknown>;
}

/** One page of the timeline: at most `limit` items and the cursor of the following page. */
export interface CustomerEventTimeline {
  readonly items: readonly CustomerEventTimelineItem[];
  readonly next_cursor: string | null;
}

/**
 * Input of `append()`; `customer_id` is `null` when the delivery carries no resolved identity (an
 * anonymous storefront session, implement/06 §8.1 R12).
 */
export interface AppendCustomerEventInput {
  readonly tenant_id: string;
  readonly source_event_id: string;
  readonly event_name: string;
  readonly session_id: string;
  readonly channel: string;
  readonly customer_id: string | null;
  readonly occurred_at: string;
  readonly payload: Record<string, unknown>;
}

/** Outcome of `append()`: whether this delivery was stored, and the event identity when it was. */
export interface CustomerEventAppendResult {
  readonly inserted: boolean;
  readonly event_id: string | null;
}

/** Input of `listTimeline()`; the page defaults to 50 rows and never exceeds 200. */
export interface CustomerEventTimelineQuery {
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly from?: string;
  readonly to?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

/** The stored receipt of one delivery identity: what a replay answers from (implement/06 §9.2). */
export interface CustomerEventReceipt {
  readonly event_id: string;
  readonly event_name: string;
  readonly occurred_at: string;
  /**
   * Digest the delivering platform recorded for the envelope it accepted, or `null` for a row
   * written before the digest was kept. It is what lets a redelivery prove it carries the same bytes
   * as the event that already holds its identity (implement/06 §8.1.1 R04).
   */
  readonly payload_sha256: string | null;
}

/**
 * The append of R04/R12. The unique key `(tenant_id, source_event_id)` decides the duplicate, and
 * `ON CONFLICT ... DO NOTHING` makes a replay a no-op at the row level: no column of the stored
 * event is touched, so a late or repeated delivery can never rewrite the history an earlier
 * projection read.
 */
const INSERT_EVENT = `INSERT INTO ${CUSTOMER_EVENTS} (
    tenant_id,
    source_event_id,
    event_name,
    session_id,
    channel,
    customer_id,
    occurred_at,
    payload
  )
  VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::jsonb)
  ON CONFLICT (tenant_id, source_event_id) DO NOTHING
  RETURNING id AS event_id`;

/** The stored receipt of one delivery identity, read by the deduplication key itself. */
const SELECT_EVENT_BY_SOURCE = `SELECT
    id AS event_id,
    event_name,
    occurred_at,
    payload->>'payload_sha256' AS payload_sha256
  FROM ${CUSTOMER_EVENTS}
  WHERE tenant_id = $1 AND source_event_id = $2`;

/**
 * The timeline page. The window and the keyset are all part of one predicate, so the page is a
 * single seek on `(tenant_id, customer_id, occurred_at)`:
 *
 *  * `from` / `to` are optional bounds on the event instant;
 *  * the cursor resumes strictly after `(occurred_at, id)`, the durable ordering key of §9.2;
 *  * the ordering is ascending and deterministic, because `id` breaks the tie between two events
 *    that share an instant.
 */
const SELECT_TIMELINE = `SELECT
    id AS event_id,
    source_event_id,
    event_name,
    session_id,
    channel,
    occurred_at,
    payload
  FROM ${CUSTOMER_EVENTS}
  WHERE tenant_id = $1
    AND customer_id = $2
    AND ($3::timestamptz IS NULL OR occurred_at >= $3::timestamptz)
    AND ($4::timestamptz IS NULL OR occurred_at <= $4::timestamptz)
    AND ($5::timestamptz IS NULL OR (occurred_at, id) > ($5::timestamptz, $6::uuid))
  ORDER BY occurred_at ASC, id ASC
  LIMIT $7`;

/** The identity of one appended event, as the deduplicating insert publishes it. */
interface InsertedEventRow extends QueryResultRow {
  event_id: string;
}

/** One timeline row exactly as `pg` returns it, before it is published. */
interface CustomerEventTimelineRow extends QueryResultRow {
  event_id: string;
  source_event_id: string;
  event_name: string;
  session_id: string;
  channel: string;
  occurred_at: Date;
  payload: Record<string, unknown>;
}

/** One stored receipt row exactly as `pg` returns it, before it is published. */
interface CustomerEventReceiptRow extends QueryResultRow {
  event_id: string;
  event_name: string;
  occurred_at: Date;
  payload_sha256: string | null;
}

/**
 * Publishes one timeline row with its instant as an ISO-8601 UTC string, so the entry survives
 * serialization into the Customer-360 timeline projection unchanged.
 */
function toTimelineItem(row: CustomerEventTimelineRow): CustomerEventTimelineItem {
  return {
    event_id: row.event_id,
    source_event_id: row.source_event_id,
    event_name: row.event_name,
    session_id: row.session_id,
    channel: row.channel,
    occurred_at: row.occurred_at.toISOString(),
    payload: row.payload,
  };
}

/** Publishes the stored receipt of one delivery identity. */
function toReceipt(row: CustomerEventReceiptRow): CustomerEventReceipt {
  return {
    event_id: row.event_id,
    event_name: row.event_name,
    occurred_at: row.occurred_at.toISOString(),
    payload_sha256: row.payload_sha256,
  };
}

/**
 * Validates an ISO-8601 instant bound into a `TIMESTAMPTZ` parameter.
 *
 * An unparseable instant would be rejected by the planner with a bare driver error, and the event's
 * own ordering key is what a late delivery is projected by, so it is refused here with the field
 * that is wrong.
 */
function assertInstant(value: unknown, column: string, code: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new Error(
      `${code}: ${column} must be an ISO-8601 instant so the durable ordering key of the event ` +
        `stream stays comparable (${CODE_OWNER}).`,
    );
  }

  return value;
}

/**
 * Parses the keyset cursor of `listTimeline()`.
 *
 * A cursor is `<occurred_at>|<event_id>`, and both halves are validated in the strictest form this
 * module publishes: the instant must be exactly the canonical ISO-8601 UTC string of the row, and
 * the identity must be its UUID. Anything else is refused rather than applied as a "close enough"
 * bound, because a wrong bound silently skips or repeats durable rows.
 *
 * @param cursor Candidate cursor, as handed back by a client.
 * @returns The `(occurred_at, event_id)` pair the next page resumes strictly after.
 * @throws Error `CUSTOMER_EVENT_CURSOR_INVALID` when the cursor is not one this module published.
 */
function parseTimelineCursor(
  cursor: unknown,
): { readonly occurred_at: string; readonly event_id: string } {
  const separator = typeof cursor === 'string' ? cursor.indexOf(CURSOR_SEPARATOR) : -1;
  const occurred_at_text = separator < 0 ? '' : (cursor as string).slice(0, separator);
  const event_id = separator < 0 ? '' : (cursor as string).slice(separator + 1);
  const occurred_at = new Date(occurred_at_text);

  if (
    separator < 0 ||
    Number.isNaN(occurred_at.getTime()) ||
    occurred_at.toISOString() !== occurred_at_text ||
    !UUID.test(event_id)
  ) {
    throw new Error(
      `CUSTOMER_EVENT_CURSOR_INVALID: ${String(cursor)} is not a timeline cursor; a cursor is ` +
        '`<occurred_at>|<event_id>`, carrying the canonical ISO-8601 UTC instant and the UUID of ' +
        `the row the previous page ended on (${CODE_OWNER}).`,
    );
  }

  return { occurred_at: occurred_at_text, event_id };
}

/**
 * Reads the customer identity of a delivery.
 *
 * `customer_events.customer_id` is a `UUID` column whose composite foreign key
 * `(tenant_id, customer_id)` is tenant-scoped (`migrations/0001_tenant_scoped_fks.sql`), so a
 * customer of another tenant can neither be written nor read through this module; a value that is
 * not a UUID is refused before any statement is sent, and `null` stays a real identity — the
 * anonymous session of R12.
 *
 * @param value Candidate customer id, or `null`.
 * @param code Error code for a malformed identity.
 * @returns The validated id, or `null`.
 */
function readCustomerId(value: unknown, code: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== 'string' || value.trim().length === 0 || !UUID.test(value)) {
    throw new Error(
      `${code}: customer_id must be the UUID of a customer of this tenant, or null for an ` +
        `anonymous session (${CODE_OWNER}).`,
    );
  }

  return value;
}

/**
 * The behavioural event journal and its tenant-scoped timeline (implement/03 §1 DOMAIN 1 Entity 4).
 *
 * Every method opens exactly one tenant-scoped transaction through `withTenantContext`, so the
 * `tenant_id` predicate of every statement is bound to the same tenant the row-level security
 * policy reads, and no lookup of this module can be answered from another tenant's rows.
 */
export class CustomerEventRepository {
  private readonly runInTenantTransaction: TenantTransactionRunner;

  /**
   * @param runInTenantTransaction Binds a tenant to the transaction every statement runs in.
   * Defaults to the package's `withTenantContext` binder.
   */
  constructor(runInTenantTransaction: TenantTransactionRunner = withTenantContext) {
    this.runInTenantTransaction = runInTenantTransaction;
  }

  /**
   * Appends one delivery to the event journal, deduplicated by its own identity
   * (implement/06 §8.1 R04/R12).
   *
   * A delivery whose `(tenant_id, source_event_id)` is already stored is reported as
   * `{ inserted: false, event_id: null }`: the stored row is neither re-inserted, updated, nor read
   * back here, because the replay route answers from `findByIdempotencyKey()` instead. Nothing is
   * raised for a duplicate — a redelivery is an expected outcome of an at-least-once connector, not
   * an error.
   *
   * @param input Tenant, source identity, canonical event name, session and channel of the delivery.
   * @returns Whether this call stored the delivery, and the stored event identity when it did.
   * @throws Error `CUSTOMER_EVENT_SOURCE_ID_REQUIRED` / `CUSTOMER_EVENT_NAME_REQUIRED` (and the
   * other `CUSTOMER_EVENT_*` refusals) when the delivery cannot address a durable row.
   * @throws Error `CUSTOMER_EVENT_PAYLOAD_INVALID` when the payload is not JSON-serializable.
   */
  async append(input: AppendCustomerEventInput): Promise<CustomerEventAppendResult> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'CUSTOMER_EVENT_TENANT_ID_REQUIRED');
    assertIdentifier(
      input.source_event_id,
      'source_event_id',
      128,
      'CUSTOMER_EVENT_SOURCE_ID_REQUIRED',
    );
    assertIdentifier(input.event_name, 'event_name', 64, 'CUSTOMER_EVENT_NAME_REQUIRED');
    assertIdentifier(input.session_id, 'session_id', 128, 'CUSTOMER_EVENT_SESSION_REQUIRED');
    assertIdentifier(input.channel, 'channel', 32, 'CUSTOMER_EVENT_CHANNEL_REQUIRED');
    const customer_id = readCustomerId(input.customer_id, 'CUSTOMER_EVENT_CUSTOMER_ID_INVALID');
    const occurred_at = assertInstant(
      input.occurred_at,
      'occurred_at',
      'CUSTOMER_EVENT_OCCURRED_AT_INVALID',
    );
    const payload = serializeJsonb(input.payload, 'CUSTOMER_EVENT_PAYLOAD_INVALID');

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<InsertedEventRow>(INSERT_EVENT, [
        input.tenant_id,
        input.source_event_id,
        input.event_name,
        input.session_id,
        input.channel,
        customer_id,
        occurred_at,
        payload,
      ]);
      const inserted = result.rows[0];

      return inserted === undefined
        ? { inserted: false, event_id: null }
        : { inserted: true, event_id: inserted.event_id };
    });
  }

  /**
   * Reads one page of a customer's timeline, oldest first (implement/06 §8.1 R15, §9.2).
   *
   * The page is ordered and paged by `(occurred_at, id)`: the instant the source reported, never the
   * ingestion instant, so a late delivery is read at its own position. The cursor is the exact key
   * of the last row of the previous page, and the page is read with one row more than requested so
   * `next_cursor` is `null` exactly when no further row exists.
   *
   * @param input Tenant, customer, the optional instant window, page size and resume cursor.
   * @returns The page, oldest first, and the cursor of the following page (`null` at the end).
   * @throws Error `CUSTOMER_EVENT_CURSOR_INVALID` when a cursor is not one this module published.
   * @throws Error `CUSTOMER_EVENT_LIMIT_INVALID` when `limit` is not an integer in 1..200.
   */
  async listTimeline(input: CustomerEventTimelineQuery): Promise<CustomerEventTimeline> {
    assertIdentifier(input.tenant_id, 'tenant_id', 36, 'CUSTOMER_EVENT_TENANT_ID_REQUIRED');
    const customer_id = readCustomerId(input.customer_id, 'CUSTOMER_EVENT_CUSTOMER_ID_INVALID');

    if (customer_id === null) {
      throw new Error(
        'CUSTOMER_EVENT_CUSTOMER_ID_REQUIRED: listTimeline() reads the timeline of exactly one ' +
          `customer; a null customer_id addresses no durable rows (${CODE_OWNER}).`,
      );
    }

    const from =
      input.from === undefined
        ? null
        : assertInstant(input.from, 'from', 'CUSTOMER_EVENT_RANGE_INVALID');
    const to =
      input.to === undefined ? null : assertInstant(input.to, 'to', 'CUSTOMER_EVENT_RANGE_INVALID');
    const limit = input.limit === undefined ? DEFAULT_TIMELINE_LIMIT : input.limit;

    if (
      typeof limit !== 'number' ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > MAX_TIMELINE_LIMIT
    ) {
      throw new Error(
        `CUSTOMER_EVENT_LIMIT_INVALID: limit must be an integer between 1 and ` +
          `${MAX_TIMELINE_LIMIT} (default ${DEFAULT_TIMELINE_LIMIT}); received ` +
          `${String(input.limit)}.`,
      );
    }

    const cursor = input.cursor === undefined ? null : parseTimelineCursor(input.cursor);

    return this.runInTenantTransaction(input.tenant_id, async (client) => {
      const result = await client.query<CustomerEventTimelineRow>(SELECT_TIMELINE, [
        input.tenant_id,
        customer_id,
        from,
        to,
        cursor === null ? null : cursor.occurred_at,
        cursor === null ? null : cursor.event_id,
        limit + 1,
      ]);
      const rows = result.rows.slice(0, limit);
      const last = rows[rows.length - 1];

      return {
        items: rows.map(toTimelineItem),
        next_cursor:
          result.rows.length > limit && last !== undefined
            ? `${last.occurred_at.toISOString()}${CURSOR_SEPARATOR}${last.event_id}`
            : null,
      };
    });
  }

  /**
   * Reads the stored receipt of one delivery identity (implement/06 §9.2 deduplication).
   *
   * This is what a replayed delivery answers from: the durable event that already carries this
   * `(tenant_id, source_event_id)` is published by identity, canonical name and instant, so the
   * route can acknowledge the replay without re-deriving anything or reading the whole row.
   *
   * @param tenant_id Tenant that owns the event; also enforced by row-level security.
   * @param source_event_id Immutable identity the source supplied with the delivery.
   * @returns The stored receipt, or `null` when this tenant has not stored that delivery.
   */
  async findByIdempotencyKey(
    tenant_id: string,
    source_event_id: string,
  ): Promise<CustomerEventReceipt | null> {
    assertIdentifier(tenant_id, 'tenant_id', 36, 'CUSTOMER_EVENT_TENANT_ID_REQUIRED');
    assertIdentifier(
      source_event_id,
      'source_event_id',
      128,
      'CUSTOMER_EVENT_SOURCE_ID_REQUIRED',
    );

    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<CustomerEventReceiptRow>(SELECT_EVENT_BY_SOURCE, [
        tenant_id,
        source_event_id,
      ]);
      const row = result.rows[0];

      return row === undefined ? null : toReceipt(row);
    });
  }
}
