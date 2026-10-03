import type { Pool, PoolClient, QueryResultRow } from 'pg';

import { getPlatformPool } from '../client.js';

/** The transaction callback used by platform projections. */
export type PlatformTransactionRunner = <T>(
  work: (client: PoolClient) => Promise<T>,
) => Promise<T>;

/** Fixed directory projection returned by platform_list_tenants/platform_get_tenant. */
export interface PlatformTenantRecord {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly status: string;
  readonly data_class: 'PRODUCTION' | 'DEMO' | 'TEST';
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

/**
 * Fixed usage projection grouped by company / UTC day / domain / model / currency.
 * Unrecorded cost rows (`cost_recorded === false`) carry no currency or cost and are
 * counted separately so they can never be summed into a currency total.
 */
export interface PlatformUsageRecord {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly usage_day: string;
  readonly domain: string | null;
  readonly model: string | null;
  readonly currency: string | null;
  readonly cost_recorded: boolean;
  readonly record_count: number;
  readonly input_tokens_total: number;
  readonly output_tokens_total: number;
  readonly cached_tokens_total: number;
  readonly tokens_total: number;
  readonly cost_total: string | null;
  readonly monthly_token_budget: number | null;
}
/** Fixed domain-only worker discovery projection. */
export interface PlatformActiveTenantRecord {
  readonly tenant_id: string;
  readonly enabled_domains: readonly string[];
}

/** Derived cross-company run list row (no customer data, no raw payloads). */
export interface PlatformRunListItem {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly run_id: string;
  readonly domain: string;
  readonly current_step: number;
  readonly state: string;
  readonly failure_class: string | null;
  readonly retry_eligible: boolean;
  readonly attempts: number;
  readonly max_retries: number;
  readonly duration_ms: number | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly correlation_id: string;
}

/** Cost totals stay separated by currency; unavailable records never enter a sum. */
export interface PlatformRunCostBreakdown {
  readonly currency: string | null;
  readonly cost_recorded: boolean;
  readonly record_count: number;
  readonly cost_total: string | null;
}

/** Derived single-run diagnostic detail row. */
export interface PlatformRunDetail {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly run_id: string;
  readonly domain: string;
  readonly correlation_id: string;
  readonly current_step: number;
  readonly state: string;
  readonly task_version: number;
  readonly failure_class: string | null;
  readonly retry_eligible: boolean;
  readonly attempts: number;
  readonly max_retries: number;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
  readonly conversation_id: string | null;
  readonly error_code: string | null;
  readonly duration_ms: number | null;
  readonly stage_event_count: number;
  readonly evidence_count: number;
  readonly cost_breakdown: readonly PlatformRunCostBreakdown[];
  readonly input_tokens_total: number;
  readonly output_tokens_total: number;
  readonly cached_tokens_total: number;
  readonly created_at: string;
  readonly updated_at: string;
}

/** Allowlisted operational step data; never includes the raw audit or receipt payload. */
export interface PlatformRunStepDiagnostic {
  readonly step_index: number;
  readonly agent: string;
  readonly skill: string;
  readonly tool_binding: string;
  readonly authority: string;
  readonly autonomy_decision: Readonly<Record<string, string>>;
  readonly execution_status: string;
  readonly effect_key: string | null;
  readonly reservation_status: string | null;
  readonly receipt_ref: string | null;
  readonly error_code: string | null;
}

export interface PlatformRunStageDiagnostic {
  readonly stage: string;
  readonly status: string;
  readonly started_at: string;
  readonly completed_at: string;
  readonly duration_ms: number;
  readonly agent_code: string | null;
  readonly skill_id: string | null;
  readonly summary_key: string | null;
  readonly error_class: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly evidence_refs: readonly string[];
}

export interface PlatformRunProviderCall {
  readonly provider: string;
  readonly model: string;
  readonly outcome: string;
  readonly latency_ms: number | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cached_tokens: number | null;
  readonly estimated_cost_amount: string | null;
  readonly currency: string | null;
  readonly cost_status: string | null;
}


/** Safe reference-only view of a run audit row. */
export interface PlatformRunAuditEntry {
  readonly audit_ref: string;
  readonly created_at: string;
  readonly agent: string;
  readonly skill: string;
  readonly tool_binding: string;
  readonly authority: string;
  readonly execution_status: string;
}

export interface PlatformRunApproval {
  readonly approval_id: string;
  readonly status: string;
  readonly effect_key: string;
  readonly created_at: string;
}

export interface PlatformRunHandoff {
  readonly handoff_id: string;
  readonly status: string;
  readonly effect_key: string;
  readonly created_at: string;
  readonly conversation_id: string;
}

export interface PlatformRunTraceDetails {
  readonly stages: readonly PlatformRunStageDiagnostic[];
  readonly provider_calls: readonly PlatformRunProviderCall[];
  readonly steps: readonly PlatformRunStepDiagnostic[];
  readonly audit_entries: readonly PlatformRunAuditEntry[];
  readonly approvals: readonly PlatformRunApproval[];
  readonly handoffs: readonly PlatformRunHandoff[];
  readonly effect_keys: readonly string[];
  readonly approval_id: string | null;
  readonly evidence_refs: readonly string[];
}

/** Platform-wide run state rollup row. */
export interface PlatformRunsSummaryRow {
  readonly state: string;
  readonly run_count: number;
  readonly tenant_count: number;
  readonly retry_eligible_count: number;
  readonly reconciliation_count: number;
}

/** One indeterminate-failure run awaiting reconciliation. */
export interface PlatformReconciliationItem {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly run_id: string;
  readonly domain: string;
  readonly state: string;
  readonly failure_class: string | null;
  readonly attempts: number;
  readonly max_retries: number;
  readonly reason: string;
  readonly correlation_id: string;
  readonly updated_at: string;
}

/** Derived per-company operational overview. */
export interface PlatformCompanyOverview {
  readonly tenant_id: string;
  readonly display_name: string;
  readonly status: string;
  readonly data_class: string;
  readonly created_at: string;
  readonly runs_total: number;
  readonly runs_failed: number;
  readonly runs_running: number;
  readonly runs_waiting: number;
  readonly retry_eligible_count: number;
  readonly reconciliation_count: number;
  readonly needs_attention: boolean;
  readonly last_activity_at: string | null;
}

interface ActiveTenantRow extends QueryResultRow {
  tenant_id: string;
  enabled_domains: string[];
}


interface TenantRow extends QueryResultRow {
  tenant_id: string;
  display_name: string;
  status: string;
  data_class: PlatformTenantRecord['data_class'];
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
  display_name: string;
  usage_day: Date | string;
  domain: string | null;
  model: string | null;
  currency: string | null;
  cost_recorded: boolean;
  record_count: string | number;
  input_tokens_total: string | number;
  output_tokens_total: string | number;
  cached_tokens_total: string | number;
  tokens_total: string | number;
  cost_total: string | number | null;
  monthly_token_budget: string | number | null;
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
    data_class: row.data_class,
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
    display_name: row.display_name,
    usage_day: row.usage_day instanceof Date
      ? row.usage_day.toISOString().slice(0, 10)
      : String(row.usage_day).slice(0, 10),
    domain: row.domain,
    model: row.model,
    currency: row.currency,
    cost_recorded: row.cost_recorded,
    record_count: Number(row.record_count),
    input_tokens_total: Number(row.input_tokens_total),
    output_tokens_total: Number(row.output_tokens_total),
    cached_tokens_total: Number(row.cached_tokens_total),
    tokens_total: Number(row.tokens_total),
    cost_total: row.cost_total === null ? null : String(row.cost_total),
    monthly_token_budget: row.monthly_token_budget === null
      ? null
      : Number(row.monthly_token_budget),
  };
}

/**
 * Runs a platform transaction as `agentos_platform`.
 *
 * When `PLATFORM_DATABASE_URL` is configured, its dedicated login is the connection
 * identity before the transaction-local role switch. Without it, the legacy `DATABASE_URL`
 * pool is used; that fallback is only compatible with databases that still grant the app
 * role membership in `agentos_platform`.
 */
export async function withPlatformRole<T>(
  work: (client: PoolClient) => Promise<T>,
  pool: Pick<Pool, 'connect'> = getPlatformPool(),
): Promise<T> {
  const client = await pool.connect();
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
  async listActiveTenants(): Promise<readonly PlatformActiveTenantRecord[]> {
    return this.transaction(async (client) => {
      const result = await client.query<ActiveTenantRow>(
        'SELECT * FROM agentos.platform_active_tenants()',
      );
      return result.rows.map((row) => ({
        tenant_id: row.tenant_id,
        enabled_domains: row.enabled_domains,
      }));
    });
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

  async listRuns(input: {
    tenant_id?: string;
    state?: string;
    domain?: string;
    limit?: number;
    before?: string;
    search?: string;
  }): Promise<readonly PlatformRunListItem[]> {
    return this.transaction(async (client) => {
      const result = await client.query<RunListItemRow>(
        'SELECT * FROM agentos.platform_list_runs($1::uuid, $2, $3, $4::int, $5::timestamptz, $6)',
        [
          input.tenant_id ?? null,
          input.state ?? null,
          input.domain ?? null,
          input.limit ?? null,
          input.before ?? null,
          input.search?.trim() || null,
        ],
      );
      return result.rows.map(toRunListItem);
    });
  }

  async runDetail(tenant_id: string, run_id: string): Promise<PlatformRunDetail | null> {
    requireTenantId(tenant_id);
    return this.transaction(async (client) => {
      const result = await client.query<RunDetailRow>(
        'SELECT * FROM agentos.platform_run_detail($1::uuid, $2::varchar)',
        [tenant_id, run_id],
      );
      const row = result.rows[0];
      return row === undefined ? null : toRunDetail(row);
    });
  }
  async runTraceDetails(tenant_id: string, run_id: string): Promise<PlatformRunTraceDetails> {
    requireTenantId(tenant_id);
    return this.transaction(async (client) => {
      const result = await client.query<RunTraceDetailsRow>(
        'SELECT * FROM agentos.platform_run_trace_details($1::uuid, $2::varchar)',
        [tenant_id, run_id],
      );
      const row = result.rows[0];
      return row === undefined
        ? {
          stages: [],
          provider_calls: [],
          steps: [],
          audit_entries: [],
          approvals: [],
          handoffs: [],
          effect_keys: [],
          approval_id: null,
          evidence_refs: [],
        }
        : {
          stages: row.stages ?? [],
          provider_calls: row.provider_calls ?? [],
          steps: row.steps ?? [],
          audit_entries: row.audit_entries ?? [],
          approvals: row.approvals ?? [],
          handoffs: row.handoffs ?? [],
          effect_keys: row.effect_keys ?? [],
          approval_id: row.approval_id,
          evidence_refs: row.evidence_refs ?? [],
        };
    });
  }


  async runsSummary(): Promise<readonly PlatformRunsSummaryRow[]> {
    return this.transaction(async (client) => {
      const result = await client.query<SummaryRow>('SELECT * FROM agentos.platform_runs_summary()');
      return result.rows.map((row) => ({
        state: row.state,
        run_count: Number(row.run_count),
        tenant_count: Number(row.tenant_count),
        retry_eligible_count: Number(row.retry_eligible_count),
        reconciliation_count: Number(row.reconciliation_count),
      }));
    });
  }

  async reconciliationQueue(input: {
    tenant_id?: string;
    limit?: number;
  } = {}): Promise<readonly PlatformReconciliationItem[]> {
    return this.transaction(async (client) => {
      const result = await client.query<ReconciliationRow>(
        'SELECT * FROM agentos.platform_reconciliation_queue($1::uuid, $2::int)',
        [input.tenant_id ?? null, input.limit ?? null],
      );
      return result.rows.map((row) => ({
        tenant_id: row.tenant_id,
        display_name: row.display_name,
        run_id: row.run_id,
        domain: row.domain,
        state: row.state,
        failure_class: row.failure_class,
        attempts: Number(row.attempts),
        max_retries: Number(row.max_retries),
        reason: row.reason,
        correlation_id: row.correlation_id,
        updated_at: iso(row.updated_at),
      }));
    });
  }

  async companyOverview(tenant_id: string): Promise<PlatformCompanyOverview | null> {
    requireTenantId(tenant_id);
    return this.transaction(async (client) => {
      const result = await client.query<CompanyOverviewRow>(
        'SELECT * FROM agentos.platform_company_overview($1::uuid)',
        [tenant_id],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        tenant_id: row.tenant_id,
        display_name: row.display_name,
        status: row.status,
        data_class: row.data_class,
        created_at: iso(row.created_at),
        runs_total: Number(row.runs_total),
        runs_failed: Number(row.runs_failed),
        runs_running: Number(row.runs_running),
        runs_waiting: Number(row.runs_waiting),
        retry_eligible_count: Number(row.retry_eligible_count),
        reconciliation_count: Number(row.reconciliation_count),
        needs_attention: row.needs_attention,
        last_activity_at: row.last_activity_at === null ? null : iso(row.last_activity_at),
      };
    });
  }
}

interface RunListItemRow extends QueryResultRow {
  tenant_id: string;
  display_name: string;
  run_id: string;
  domain: string;
  current_step: string | number;
  state: string;
  failure_class: string | null;
  retry_eligible: boolean;
  attempts: string | number;
  max_retries: string | number;
  duration_ms: string | number | null;
  created_at: Date | string;
  updated_at: Date | string;
  correlation_id: string;
}

interface RunDetailRow extends QueryResultRow {
  tenant_id: string;
  display_name: string;
  run_id: string;
  domain: string;
  correlation_id: string;
  current_step: string | number;
  state: string;
  task_version: string | number;
  failure_class: string | null;
  retry_eligible: boolean;
  attempts: string | number;
  max_retries: string | number;
  lease_owner: string | null;
  lease_expires_at: Date | string | null;
  conversation_id: string | null;
  error_code: string | null;
  duration_ms: string | number | null;
  stage_event_count: string | number;
  evidence_count: string | number;
  cost_breakdown: readonly PlatformRunCostBreakdown[] | null;
  input_tokens_total: string | number;
  output_tokens_total: string | number;
  cached_tokens_total: string | number;
  created_at: Date | string;
  updated_at: Date | string;
}
interface RunTraceDetailsRow extends QueryResultRow {
  stages: readonly PlatformRunStageDiagnostic[] | null;
  provider_calls: readonly PlatformRunProviderCall[] | null;
  steps: readonly PlatformRunStepDiagnostic[] | null;
  audit_entries: readonly PlatformRunAuditEntry[] | null;
  approvals: readonly PlatformRunApproval[] | null;
  handoffs: readonly PlatformRunHandoff[] | null;
  effect_keys: readonly string[] | null;
  approval_id: string | null;
  evidence_refs: readonly string[] | null;
}

interface SummaryRow extends QueryResultRow {
  state: string;
  run_count: string | number;
  tenant_count: string | number;
  retry_eligible_count: string | number;
  reconciliation_count: string | number;
}

interface ReconciliationRow extends QueryResultRow {
  tenant_id: string;
  display_name: string;
  run_id: string;
  domain: string;
  state: string;
  failure_class: string | null;
  attempts: string | number;
  max_retries: string | number;
  reason: string;
  correlation_id: string;
  updated_at: Date | string;
}

interface CompanyOverviewRow extends QueryResultRow {
  tenant_id: string;
  display_name: string;
  status: string;
  data_class: string;
  created_at: Date | string;
  runs_total: string | number;
  runs_failed: string | number;
  runs_running: string | number;
  runs_waiting: string | number;
  retry_eligible_count: string | number;
  reconciliation_count: string | number;
  needs_attention: boolean;
  last_activity_at: Date | string | null;
}

function toRunListItem(row: RunListItemRow): PlatformRunListItem {
  return {
    tenant_id: row.tenant_id,
    display_name: row.display_name,
    run_id: row.run_id,
    domain: row.domain,
    current_step: Number(row.current_step),
    state: row.state,
    failure_class: row.failure_class,
    retry_eligible: row.retry_eligible,
    attempts: Number(row.attempts),
    max_retries: Number(row.max_retries),
    duration_ms: row.duration_ms === null ? null : Number(row.duration_ms),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    correlation_id: row.correlation_id,
  };
}

function toRunDetail(row: RunDetailRow): PlatformRunDetail {
  return {
    tenant_id: row.tenant_id,
    display_name: row.display_name,
    run_id: row.run_id,
    domain: row.domain,
    correlation_id: row.correlation_id,
    current_step: Number(row.current_step),
    state: row.state,
    task_version: Number(row.task_version),
    failure_class: row.failure_class,
    retry_eligible: row.retry_eligible,
    attempts: Number(row.attempts),
    max_retries: Number(row.max_retries),
    lease_owner: row.lease_owner,
    lease_expires_at: row.lease_expires_at === null ? null : iso(row.lease_expires_at),
    conversation_id: row.conversation_id,
    error_code: row.error_code,
    duration_ms: row.duration_ms === null ? null : Number(row.duration_ms),
    stage_event_count: Number(row.stage_event_count),
    evidence_count: Number(row.evidence_count),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    cost_breakdown: row.cost_breakdown ?? [],
    input_tokens_total: Number(row.input_tokens_total),
    output_tokens_total: Number(row.output_tokens_total),
    cached_tokens_total: Number(row.cached_tokens_total),
  };
}
