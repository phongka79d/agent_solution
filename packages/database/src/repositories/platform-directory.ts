import type { PoolClient, QueryResultRow } from 'pg';

import { getPool } from '../client.js';

/** The transaction callback used by platform projections. */
export type PlatformTransactionRunner = <T>(
  work: (client: PoolClient) => Promise<T>,
) => Promise<T>;

/** Fixed directory projection returned by platform_list_tenants/platform_get_tenant. */
export interface PlatformTenantRecord {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly status: string;
  readonly created_at: string;
  readonly enabled_modules: readonly string[] | null;
}

/** Fixed readiness projection; null means the authoritative source has no rows. */
export interface PlatformTenantReadinessRecord {
  readonly tenant_id: string;
  readonly capability_count: number | null;
  readonly capability_statuses: Readonly<Record<string, string>> | null;
  readonly connector_count: number | null;
  readonly connector_statuses: Readonly<Record<string, string>> | null;
  readonly owner_input_count: number | null;
  readonly owner_input_statuses: Readonly<Record<string, string>> | null;
  readonly workspace_status: string | null;
  readonly residency_status: string | null;
}

/** Fixed usage projection. Null aggregates indicate that source has no rows in the window. */
export interface PlatformUsageRecord {
  readonly tenant_id: string;
  readonly runs_count: number | null;
  readonly token_cost_records_count: number | null;
  readonly estimated_cost_total: string | null;
  readonly input_tokens_total: number | null;
  readonly output_tokens_total: number | null;
  readonly cached_tokens_total: number | null;
}

interface TenantRow extends QueryResultRow {
  tenant_id: string;
  display_name: string;
  status: string;
  created_at: Date | string;
  enabled_modules: string[] | null;
}

interface ReadinessRow extends QueryResultRow {
  tenant_id: string;
  capability_count: string | number | null;
  capability_statuses: Record<string, string> | null;
  connector_count: string | number | null;
  connector_statuses: Record<string, string> | null;
  owner_input_count: string | number | null;
  owner_input_statuses: Record<string, string> | null;
  workspace_status: string | null;
  residency_status: string | null;
}

interface UsageRow extends QueryResultRow {
  tenant_id: string;
  runs_count: string | number | null;
  token_cost_records_count: string | number | null;
  estimated_cost_total: string | number | null;
  input_tokens_total: string | number | null;
  output_tokens_total: string | number | null;
  cached_tokens_total: string | number | null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function count(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function requireTenantId(tenant_id: string): void {
  if (typeof tenant_id !== 'string' || tenant_id.trim().length === 0) {
    throw new Error('PLATFORM_TENANT_ID_REQUIRED: tenant id is required.');
  }
}

function toTenant(row: TenantRow): PlatformTenantRecord {
  return {
    tenant_id: row.tenant_id,
    display_name: row.display_name,
    status: row.status,
    created_at: iso(row.created_at),
    enabled_modules: row.enabled_modules,
  };
}

function toReadiness(row: ReadinessRow): PlatformTenantReadinessRecord {
  return {
    tenant_id: row.tenant_id,
    capability_count: count(row.capability_count),
    capability_statuses: row.capability_statuses,
    connector_count: count(row.connector_count),
    connector_statuses: row.connector_statuses,
    owner_input_count: count(row.owner_input_count),
    owner_input_statuses: row.owner_input_statuses,
    workspace_status: row.workspace_status,
    residency_status: row.residency_status,
  };
}

function toUsage(row: UsageRow): PlatformUsageRecord {
  return {
    tenant_id: row.tenant_id,
    runs_count: count(row.runs_count),
    token_cost_records_count: count(row.token_cost_records_count),
    estimated_cost_total: row.estimated_cost_total === null ? null : String(row.estimated_cost_total),
    input_tokens_total: count(row.input_tokens_total),
    output_tokens_total: count(row.output_tokens_total),
    cached_tokens_total: count(row.cached_tokens_total),
  };
}

/**
 * Runs a platform projection under a transaction-local, non-inheriting role.
 * The role change is intentionally inside the transaction and is cleared by COMMIT/ROLLBACK.
 */
export async function withPlatformRole<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE agentos_platform');
    await client.query('SET LOCAL search_path TO agentos, public');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original database error if the connection is already broken.
    }
    throw error;
  } finally {
    client.release();
  }
}

export interface PlatformDirectoryRepositoryOptions {
  readonly transaction?: PlatformTransactionRunner;
}

/** Calls only the fixed SECURITY DEFINER directory/aggregate functions. */
export class PlatformDirectoryRepository {
  private readonly transaction: PlatformTransactionRunner;

  constructor(options: PlatformDirectoryRepositoryOptions = {}) {
    this.transaction = options.transaction ?? withPlatformRole;
  }

  async listTenants(): Promise<readonly PlatformTenantRecord[]> {
    return this.transaction(async (client) => {
      const result = await client.query<TenantRow>('SELECT * FROM agentos.platform_list_tenants()');
      return result.rows.map(toTenant);
    });
  }

  async getTenant(tenant_id: string): Promise<PlatformTenantRecord | null> {
    requireTenantId(tenant_id);
    return this.transaction(async (client) => {
      const result = await client.query<TenantRow>('SELECT * FROM agentos.platform_get_tenant($1::uuid)', [tenant_id]);
      const row = result.rows[0];
      return row === undefined ? null : toTenant(row);
    });
  }

  async readiness(tenant_id: string): Promise<PlatformTenantReadinessRecord | null> {
    requireTenantId(tenant_id);
    return this.transaction(async (client) => {
      const result = await client.query<ReadinessRow>(
        'SELECT * FROM agentos.platform_tenant_readiness($1::uuid)',
        [tenant_id],
      );
      const row = result.rows[0];
      return row === undefined ? null : toReadiness(row);
    });
  }

  async usage(from: string, to: string): Promise<readonly PlatformUsageRecord[]> {
    const start = Date.parse(from);
    const end = Date.parse(to);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      throw new Error('PLATFORM_USAGE_WINDOW_INVALID: from and to must form a non-empty time window.');
    }
    return this.transaction(async (client) => {
      const result = await client.query<UsageRow>(
        'SELECT * FROM agentos.platform_usage($1::timestamptz, $2::timestamptz)',
        [from, to],
      );
      return result.rows.map(toUsage);
    });
  }
}
