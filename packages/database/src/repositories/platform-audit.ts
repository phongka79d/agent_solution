import type { PoolClient, QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import { withPlatformRole, type PlatformTransactionRunner } from './platform-directory.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_BIGINT = 9_223_372_036_854_775_807n;


export interface ConfigAuditInput {
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly scope: string;
  readonly action: string;
  readonly target_tenant: string | null;
  readonly target: string | null;
  readonly outcome: string;
  readonly reason: string | null;
  /** Callers must redact these projections before calling the database writer. */
  readonly before: unknown | null;
  readonly after: unknown | null;
  readonly correlation_id: string;
}

export interface PlatformAuditEvent {
  readonly event_id: string;
  readonly chain_seq: string;
  readonly prev_hash: string;
  readonly hash: string;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly scope: string;
  readonly action: string;
  readonly tenant_id: string | null;
  readonly target: string | null;
  readonly outcome: string;
  readonly reason: string | null;
  readonly before_state: unknown | null;
  readonly after_state: unknown | null;
  readonly correlation_id: string;
  readonly created_at: string;
}

export interface AuditPageQuery {
  readonly cursor?: string;
  readonly limit?: number;
  readonly scope?: string;
}

export interface PlatformAuditPageQuery extends AuditPageQuery {
  readonly tenant_id?: string;
}

export interface PlatformAuditPage {
  readonly items: readonly PlatformAuditEvent[];
  readonly next_cursor: string | null;
  /**
   * Whether every returned event reproduced its own stored `hash` and linked to the event
   * returned immediately after it (the older neighbour). The database recomputes the digest
   * with the exact `agentos.platform_append_audit` formula, so a page that was never probed
   * against the writer's payload cannot report `true` by accident.
   */
  readonly chain_verified: boolean;
}

export type PlatformAuditRow = QueryResultRow & Omit<PlatformAuditEvent, 'created_at'> & {
  readonly created_at: Date | string;
  readonly recomputed_hash: string;
};

/**
 * Rebuilds one event's `hash` from the row's own columns using the writer's exact definition
 * (migration `0029_platform_audit_events.sql`): `sha256(prev_hash || '|' || payload)`, where the
 * payload is the `jsonb_build_array` of the stored fields and a UTC microsecond timestamp.
 *
 * Postgres renders that JSON text, so the comparison is byte-exact with the append function
 * without re-implementing `jsonb` formatting in TypeScript. The tenant column differs between the
 * platform table (`target_tenant`) and the GUC-filtered view (`tenant_id`).
 */
function chainVerifyColumn(tenantColumn: 'tenant_id' | 'target_tenant'): string {
  return `encode(sha256(convert_to(
                   prev_hash || '|' || jsonb_build_array(
                     chain_seq, event_id, actor_kind, actor_id, scope, action,
                     ${tenantColumn}, target, outcome, reason, before_state, after_state,
                     correlation_id,
                     to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                   )::text, 'UTF8')), 'hex') AS recomputed_hash`;
}

/** Append an already-redacted config event using the database writer in the caller's transaction. */
export async function appendConfigAudit(client: PoolClient, input: ConfigAuditInput): Promise<string> {
  const before = input.before === null || input.before === undefined ? null : JSON.stringify(input.before);
  const after = input.after === null || input.after === undefined ? null : JSON.stringify(input.after);
  if (before === undefined || after === undefined) {
    throw new TypeError('PLATFORM_AUDIT_JSON_INVALID: before/after must be JSON serializable.');
  }
  const result = await client.query<{ readonly event_id: string }>(
    `SELECT agentos.platform_append_audit(
       $1::text, $2::text, $3::text, $4::text, $5::uuid, $6::text,
       $7::text, $8::text, $9::jsonb, $10::jsonb, $11::text
     ) AS event_id`,
    [
      input.actor_kind,
      input.actor_id,
      input.scope,
      input.action,
      input.target_tenant,
      input.target,
      input.outcome,
      input.reason,
      before,
      after,
      input.correlation_id,
    ],
  );
  const row = result.rows[0];
  if (row === undefined || typeof row.event_id !== 'string') {
    throw new Error('PLATFORM_AUDIT_APPEND_FAILED: database writer returned no event id.');
  }
  return row.event_id;
}

function parseLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new TypeError(`PLATFORM_AUDIT_LIMIT_INVALID: limit must be between 1 and ${MAX_LIMIT}.`);
  }
  return value;
}

function parseCursor(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!/^[1-9]\d{0,18}$/.test(value)) {
    throw new TypeError('PLATFORM_AUDIT_CURSOR_INVALID: cursor must be a positive chain sequence.');
  }
  const parsed = BigInt(value);
  if (parsed > MAX_BIGINT) {
    throw new TypeError('PLATFORM_AUDIT_CURSOR_INVALID: cursor exceeds the database sequence range.');
  }
  return parsed.toString();
}
function toEvent(row: PlatformAuditRow): PlatformAuditEvent {
  return {
    event_id: row.event_id,
    chain_seq: row.chain_seq,
    prev_hash: row.prev_hash,
    hash: row.hash,
    actor_kind: row.actor_kind,
    actor_id: row.actor_id,
    scope: row.scope,
    action: row.action,
    tenant_id: row.tenant_id,
    target: row.target,
    outcome: row.outcome,
    reason: row.reason,
    before_state: row.before_state,
    after_state: row.after_state,
    correlation_id: row.correlation_id,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : new Date(row.created_at).toISOString(),
  };
}

function pageFromRows(rows: readonly PlatformAuditRow[], limit: number): PlatformAuditPage {
  const hasMore = rows.length > limit;
  const selected = hasMore ? rows.slice(0, limit) : rows;
  let chain_verified = true;
  for (let index = 0; index < selected.length && chain_verified; index += 1) {
    const row = selected[index];
    const predecessor = selected[index + 1];
    if (row === undefined || row.recomputed_hash !== row.hash) {
      chain_verified = false;
    } else if (predecessor !== undefined && row.prev_hash !== predecessor.hash) {
      chain_verified = false;
    }
  }
  return {
    items: selected.map(toEvent),
    next_cursor: hasMore ? selected[selected.length - 1]?.chain_seq ?? null : null,
    chain_verified,
  };
}

export interface PlatformAuditRepositoryOptions {
  readonly tenantTransaction?: TenantTransactionRunner;
  readonly platformTransaction?: PlatformTransactionRunner;
}

/** Reads tenant-visible audit rows through the GUC-filtered view and platform rows under role scope. */
export class PlatformAuditRepository {
  private readonly runInTenantTransaction: TenantTransactionRunner;
  private readonly runInPlatformTransaction: PlatformTransactionRunner;

  constructor(options: PlatformAuditRepositoryOptions = {}) {
    this.runInTenantTransaction = options.tenantTransaction ?? withTenantContext;
    this.runInPlatformTransaction = options.platformTransaction ?? withPlatformRole;
  }

  async listForTenant(tenant_id: string, query: AuditPageQuery = {}): Promise<PlatformAuditPage> {
    const limit = parseLimit(query.limit);
    const cursor = parseCursor(query.cursor);
    return this.runInTenantTransaction(tenant_id, async (client) => {
      const result = await client.query<PlatformAuditRow>(
        `SELECT event_id, chain_seq::text AS chain_seq, prev_hash, hash, actor_kind, actor_id,
                scope, action, tenant_id, target, outcome, reason, before_state, after_state,
                correlation_id, created_at,
                ${chainVerifyColumn('tenant_id')}
           FROM agentos.tenant_audit_events AS events
          WHERE tenant_id = $1
            AND ($2::text IS NULL OR scope = $2)
            AND ($3::bigint IS NULL OR chain_seq < $3::bigint)
          -- Qualified: the bare name would bind to the ::text output alias and sort lexically.
          ORDER BY events.chain_seq DESC
          LIMIT $4`,
        [tenant_id, query.scope ?? null, cursor, limit + 1],
      );
      return pageFromRows(result.rows, limit);
    });
  }

  async listForPlatform(query: PlatformAuditPageQuery = {}): Promise<PlatformAuditPage> {
    const limit = parseLimit(query.limit);
    const cursor = parseCursor(query.cursor);
    return this.runInPlatformTransaction(async (client) => {
      const result = await client.query<PlatformAuditRow>(
        `SELECT event_id, chain_seq::text AS chain_seq, prev_hash, hash, actor_kind, actor_id,
                scope, action, target_tenant AS tenant_id, target, outcome, reason,
                before_state, after_state, correlation_id, created_at,
                ${chainVerifyColumn('target_tenant')}
           FROM agentos.platform_audit_events AS events
          WHERE ($1::uuid IS NULL OR target_tenant = $1::uuid)
            AND ($2::text IS NULL OR scope = $2)
            AND ($3::bigint IS NULL OR chain_seq < $3::bigint)
          ORDER BY events.chain_seq DESC
          LIMIT $4`,
        [query.tenant_id ?? null, query.scope ?? null, cursor, limit + 1],
      );
      return pageFromRows(result.rows, limit);
    });
  }
}
