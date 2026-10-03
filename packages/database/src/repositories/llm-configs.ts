import type { PoolClient, QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import { appendConfigAudit, type ConfigAuditInput } from './platform-audit.js';
import { withPlatformRole, type PlatformTransactionRunner } from './platform-directory.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

export type LlmStructuredMode = 'json_object' | 'json_schema';
export type LlmProviderStatus = 'CONFIGURED' | 'VERIFIED' | 'FAILED';
export type LlmConfigMode = 'INHERIT' | 'CUSTOM';

export interface LlmConfigActor {
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly correlation_id: string;
  readonly reason?: string | null;
}

export interface PlatformLlmProviderInput {
  readonly provider_id: string;
  readonly display_name: string;
  readonly base_url: string;
  readonly reasoning_model: string;
  readonly fast_model: string;
  readonly timeout_ms: number;
  readonly structured_mode: LlmStructuredMode;
  readonly secret_id: string | null;
  readonly status?: LlmProviderStatus;
  readonly is_default: boolean;
}

export interface TenantLlmOverrideInput {
  readonly mode: LlmConfigMode;
  readonly provider_id?: string | null;
  readonly base_url?: string | null;
  readonly reasoning_model?: string | null;
  readonly fast_model?: string | null;
  readonly timeout_ms?: number | null;
  readonly structured_mode?: LlmStructuredMode | null;
  readonly secret_id?: string | null;
  readonly monthly_token_budget?: number | null;
}

export interface LlmProbeResult {
  readonly outcome: 'PASS' | 'FAIL';
  readonly latency_ms: number | null;
  readonly http_status: number | null;
  /** Sanitized class only; never an exception or response body. */
  readonly error_class: string | null;
}

export type LlmProbeScope =
  | { readonly kind: 'PLATFORM'; readonly provider_id: string }
  | { readonly kind: 'TENANT'; readonly tenant_id: string; readonly provider_id: string };

export interface PlatformLlmProviderRecord extends PlatformLlmProviderInput {
  readonly status: LlmProviderStatus;
  readonly config_version: string;
  readonly updated_at: string;
}

/** The sanitized stored probe plus when it ran (`agentos.llm_probe_results.tested_at`). */
export interface PlatformLlmProbeSummary extends LlmProbeResult {
  readonly probed_at: string;
}

/**
 * A platform provider as the control plane lists it: the configuration plus the two facts an
 * operator needs — the latest persisted probe, and the non-reversible handle of the stored
 * credential (`fingerprint`/`last4` from `platform_secrets`). Plaintext is never read here.
 */
export interface PlatformLlmProviderListing extends PlatformLlmProviderRecord {
  readonly last_probe: PlatformLlmProbeSummary | null;
  readonly secret_fingerprint: string | null;
  readonly secret_last4: string | null;
}

/** A stored tenant override: every column is present (null when not set), never omitted. */
export interface TenantLlmConfigRecord {
  readonly tenant_id: string;
  readonly mode: LlmConfigMode;
  readonly provider_id: string | null;
  readonly base_url: string | null;
  readonly reasoning_model: string | null;
  readonly fast_model: string | null;
  readonly timeout_ms: number | null;
  readonly structured_mode: LlmStructuredMode | null;
  readonly secret_id: string | null;
  readonly monthly_token_budget: number | null;
  readonly config_version: string;
  readonly updated_at: string;
}

interface PlatformProviderRow extends QueryResultRow {
  readonly provider_id: string;
  readonly display_name: string;
  readonly base_url: string;
  readonly reasoning_model: string;
  readonly fast_model: string;
  readonly timeout_ms: number;
  readonly structured_mode: LlmStructuredMode;
  readonly secret_id: string | null;
  readonly status: LlmProviderStatus;
  readonly is_default: boolean;
  readonly config_version: string | number;
  readonly updated_at: Date | string;
}

interface TenantConfigRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly provider_id: string | null;
  readonly mode: LlmConfigMode;
  readonly base_url: string | null;
  readonly reasoning_model: string | null;
  readonly fast_model: string | null;
  readonly timeout_ms: number | null;
  readonly structured_mode: LlmStructuredMode | null;
  readonly secret_id: string | null;
  readonly monthly_token_budget: string | number | null;
  readonly config_version: string | number;
  readonly updated_at: Date | string;
}

interface PlatformConfigBefore extends QueryResultRow {
  readonly provider_id: string;
  readonly display_name: string;
  readonly base_url: string;
  readonly reasoning_model: string;
  readonly fast_model: string;
  readonly timeout_ms: number;
  readonly structured_mode: LlmStructuredMode;
  readonly secret_id: string | null;
  readonly status: LlmProviderStatus;
  readonly is_default: boolean;
}

interface ProbeRow extends QueryResultRow {
  readonly probe_id: string;
}

/** A listing row adds the latest platform probe and the credential handle to the provider row. */
interface PlatformProviderListingRow extends PlatformProviderRow {
  readonly secret_fingerprint: string | null;
  readonly secret_last4: string | null;
  readonly probe_outcome: 'PASS' | 'FAIL' | null;
  readonly probe_latency_ms: number | null;
  readonly probe_http_status: number | null;
  readonly probe_error_class: string | null;
  readonly probed_at: Date | string | null;
}

export interface LlmConfigRepositoryOptions {
  readonly platformTransaction?: PlatformTransactionRunner;
  readonly tenantTransaction?: TenantTransactionRunner;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requireText(value: string, field: string, max = 512): void {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new TypeError(`LLM_CONFIG_INVALID: ${field} is required and must be at most ${max} characters.`);
  }
}

function validateUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('LLM_CONFIG_INVALID: base_url must be an absolute HTTPS URL.');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const localHttp = url.protocol === 'http:'
    && (process.env.APP_ENV === 'local' || process.env.APP_ENV === 'ci')
    && ['llm-stub', 'localhost', '127.0.0.1', '::1', 'host.docker.internal'].includes(host);
  if ((!localHttp && url.protocol !== 'https:') || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new TypeError('LLM_CONFIG_INVALID: base_url must be HTTPS without userinfo, query, or fragment.');
  }
}

function validateCommon(input: Pick<PlatformLlmProviderInput, 'base_url' | 'reasoning_model' | 'fast_model' | 'timeout_ms' | 'structured_mode'>): void {
  validateUrl(input.base_url);
  requireText(input.reasoning_model, 'reasoning_model', 128);
  requireText(input.fast_model, 'fast_model', 128);
  if (!Number.isSafeInteger(input.timeout_ms) || input.timeout_ms < 1000 || input.timeout_ms > 120000) {
    throw new TypeError('LLM_CONFIG_INVALID: timeout_ms must be between 1000 and 120000.');
  }
  if (input.structured_mode !== 'json_object' && input.structured_mode !== 'json_schema') {
    throw new TypeError('LLM_CONFIG_INVALID: structured_mode is invalid.');
  }
}

function validateActor(actor: LlmConfigActor): void {
  requireText(actor.actor_kind, 'actor_kind');
  requireText(actor.actor_id, 'actor_id');
  requireText(actor.correlation_id, 'correlation_id');
}

function platformRecord(row: PlatformProviderRow): PlatformLlmProviderRecord {
  return {
    provider_id: row.provider_id,
    display_name: row.display_name,
    base_url: row.base_url,
    reasoning_model: row.reasoning_model,
    fast_model: row.fast_model,
    timeout_ms: row.timeout_ms,
    structured_mode: row.structured_mode,
    secret_id: row.secret_id,
    status: row.status,
    is_default: row.is_default,
    config_version: String(row.config_version),
    updated_at: iso(row.updated_at),
  };
}

function platformListing(row: PlatformProviderListingRow): PlatformLlmProviderListing {
  const last_probe: PlatformLlmProbeSummary | null = row.probe_outcome === null || row.probed_at === null
    ? null
    : {
        outcome: row.probe_outcome,
        latency_ms: row.probe_latency_ms,
        http_status: row.probe_http_status,
        error_class: row.probe_error_class,
        probed_at: iso(row.probed_at),
      };
  return {
    ...platformRecord(row),
    last_probe,
    secret_fingerprint: row.secret_fingerprint,
    secret_last4: row.secret_last4,
  };
}

function tenantRecord(row: TenantConfigRow): TenantLlmConfigRecord {
  return {
    tenant_id: row.tenant_id,
    provider_id: row.provider_id,
    mode: row.mode,
    base_url: row.base_url,
    reasoning_model: row.reasoning_model,
    fast_model: row.fast_model,
    timeout_ms: row.timeout_ms,
    structured_mode: row.structured_mode,
    secret_id: row.secret_id,
    monthly_token_budget: row.monthly_token_budget === null ? null : Number(row.monthly_token_budget),
    config_version: String(row.config_version),
    updated_at: iso(row.updated_at),
  };
}

function auditContext(actor: LlmConfigActor, scope: string, tenant_id: string | null, target: string, action: string, before: unknown, after: unknown): ConfigAuditInput {
  return {
    actor_kind: actor.actor_kind,
    actor_id: actor.actor_id,
    scope,
    action,
    target_tenant: tenant_id,
    target,
    outcome: 'ACCEPTED',
    reason: actor.reason ?? null,
    before,
    after,
    correlation_id: actor.correlation_id,
  };
}

function platformAuditView(row: PlatformConfigBefore | undefined): unknown | null {
  if (row === undefined) return null;
  return {
    display_name: row.display_name,
    base_url: row.base_url,
    reasoning_model: row.reasoning_model,
    fast_model: row.fast_model,
    timeout_ms: row.timeout_ms,
    structured_mode: row.structured_mode,
    credential_configured: row.secret_id !== null,
    status: row.status,
    is_default: row.is_default,
  };
}

export class LlmConfigRepository {
  constructor(private readonly options: LlmConfigRepositoryOptions = {}) {}

  async getPlatformDefault(): Promise<PlatformLlmProviderRecord | null> {
    return (this.options.platformTransaction ?? withPlatformRole)(async (client) => {
      const result = await client.query<PlatformProviderRow>(
        `SELECT provider_id, display_name, base_url, reasoning_model, fast_model, timeout_ms,
                structured_mode, secret_id::text AS secret_id, status, is_default,
                config_version::text AS config_version, updated_at
           FROM agentos.platform_llm_providers
          WHERE is_default = true
          LIMIT 1`,
      );
      const row = result.rows[0];
      return row === undefined ? null : platformRecord(row);
    });
  }
  async listPlatformProviders(): Promise<readonly PlatformLlmProviderListing[]> {
    return (this.options.platformTransaction ?? withPlatformRole)(async (client) => {
      const result = await client.query<PlatformProviderListingRow>(
        `SELECT p.provider_id, p.display_name, p.base_url, p.reasoning_model, p.fast_model, p.timeout_ms,
                p.structured_mode, p.secret_id::text AS secret_id, p.status, p.is_default,
                p.config_version::text AS config_version, p.updated_at,
                s.fingerprint AS secret_fingerprint, s.last4 AS secret_last4,
                probe.outcome AS probe_outcome, probe.latency_ms AS probe_latency_ms,
                probe.http_status AS probe_http_status, probe.error_class AS probe_error_class,
                probe.tested_at AS probed_at
           FROM agentos.platform_llm_providers AS p
           LEFT JOIN agentos.platform_secrets AS s ON s.secret_id = p.secret_id
           LEFT JOIN LATERAL (
             SELECT r.outcome, r.latency_ms, r.http_status, r.error_class, r.tested_at
               FROM agentos.llm_probe_results AS r
              WHERE r.scope = 'PLATFORM' AND r.provider_id = p.provider_id
              ORDER BY r.tested_at DESC, r.probe_id DESC
              LIMIT 1
           ) AS probe ON TRUE
          ORDER BY p.provider_id`,
      );
      return result.rows.map(platformListing);
    });
  }

  async getPlatformProvider(provider_id: string): Promise<PlatformLlmProviderRecord | null> {
    return (this.options.platformTransaction ?? withPlatformRole)(async (client) => {
      const result = await client.query<PlatformProviderRow>(
        `SELECT provider_id, display_name, base_url, reasoning_model, fast_model, timeout_ms,
                structured_mode, secret_id::text AS secret_id, status, is_default,
                config_version::text AS config_version, updated_at
           FROM agentos.platform_llm_providers
          WHERE provider_id = $1`,
        [provider_id],
      );
      const row = result.rows[0];
      return row === undefined ? null : platformRecord(row);
    });
  }

  async upsertPlatformProvider(input: PlatformLlmProviderInput, actor: LlmConfigActor): Promise<PlatformLlmProviderRecord> {
    requireText(input.provider_id, 'provider_id', 128);
    requireText(input.display_name, 'display_name', 128);
    validateCommon(input);
    validateActor(actor);
    if (input.status !== undefined && !['CONFIGURED', 'VERIFIED', 'FAILED'].includes(input.status)) {
      throw new TypeError('LLM_CONFIG_INVALID: status is invalid.');
    }
    return (this.options.platformTransaction ?? withPlatformRole)(async (client) => {
      if (input.is_default) {
        const previous = await client.query<PlatformConfigBefore>(
          `UPDATE agentos.platform_llm_providers
              SET is_default = false, config_version = config_version + 1, updated_at = CURRENT_TIMESTAMP
            WHERE is_default = true AND provider_id <> $1
            RETURNING provider_id, display_name, base_url, reasoning_model, fast_model, timeout_ms,
                      structured_mode, secret_id::text AS secret_id, status, is_default`,
          [input.provider_id],
        );
        for (const row of previous.rows) {
          await appendConfigAudit(client, auditContext(actor, 'PLATFORM', null, row.provider_id,
            'llm.provider.default_removed', platformAuditView(row), { is_default: false }));
        }
      }
      const beforeResult = await client.query<PlatformConfigBefore>(
        `SELECT provider_id, display_name, base_url, reasoning_model, fast_model, timeout_ms,
                structured_mode, secret_id::text AS secret_id, status, is_default
           FROM agentos.platform_llm_providers WHERE provider_id = $1`,
        [input.provider_id],
      );
      const result = await client.query<PlatformProviderRow>(
        `INSERT INTO agentos.platform_llm_providers
           (provider_id, display_name, base_url, reasoning_model, fast_model, timeout_ms,
            structured_mode, secret_id, status, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (provider_id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           base_url = EXCLUDED.base_url,
           reasoning_model = EXCLUDED.reasoning_model,
           fast_model = EXCLUDED.fast_model,
           timeout_ms = EXCLUDED.timeout_ms,
           structured_mode = EXCLUDED.structured_mode,
           secret_id = EXCLUDED.secret_id,
           status = EXCLUDED.status,
           is_default = EXCLUDED.is_default,
           config_version = agentos.platform_llm_providers.config_version + 1,
           updated_at = CURRENT_TIMESTAMP
         RETURNING provider_id, display_name, base_url, reasoning_model, fast_model, timeout_ms,
                   structured_mode, secret_id::text AS secret_id, status, is_default,
                   config_version::text AS config_version, updated_at`,
        [input.provider_id, input.display_name, input.base_url, input.reasoning_model, input.fast_model,
          input.timeout_ms, input.structured_mode, input.secret_id, input.status ?? 'CONFIGURED', input.is_default],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('LLM_CONFIG_PERSISTENCE_FAILED');
      const before = beforeResult.rows[0];
      await appendConfigAudit(client, auditContext(actor, 'PLATFORM', null, input.provider_id,
        'llm.provider.upsert', platformAuditView(before), platformAuditView(row)));
      return platformRecord(row);
    });
  }

  async getTenantOverride(tenant_id: string): Promise<TenantLlmConfigRecord | null> {
    return (this.options.tenantTransaction ?? withTenantContext)(tenant_id, async (client) => {
      const result = await client.query<TenantConfigRow>(
        `SELECT tenant_id::text AS tenant_id, mode, provider_id, base_url, reasoning_model, fast_model, timeout_ms,
                structured_mode, secret_id::text AS secret_id, monthly_token_budget::text AS monthly_token_budget,
                config_version::text AS config_version, updated_at
           FROM agentos.tenant_llm_configs
          WHERE tenant_id = $1`,
        [tenant_id],
      );
      const row = result.rows[0];
      return row === undefined ? null : tenantRecord(row);
    });
  }

  async putTenantOverride(tenant_id: string, input: TenantLlmOverrideInput, actor: LlmConfigActor): Promise<TenantLlmConfigRecord> {
    validateActor(actor);
    if (input.mode !== 'INHERIT' && input.mode !== 'CUSTOM') {
      throw new TypeError('LLM_CONFIG_INVALID: mode is invalid.');
    }
    if (input.mode === 'CUSTOM') {
      if (
        input.provider_id == null || input.base_url == null || input.reasoning_model == null
        || input.fast_model == null || input.timeout_ms == null || input.structured_mode == null || input.secret_id == null
      ) throw new TypeError('LLM_CONFIG_INVALID: custom mode requires provider_id, complete provider config, and secret_id.');
      requireText(input.provider_id, 'provider_id', 128);
      validateCommon({
        base_url: input.base_url,
        reasoning_model: input.reasoning_model,
        fast_model: input.fast_model,
        timeout_ms: input.timeout_ms,
        structured_mode: input.structured_mode,
      });
      requireText(input.secret_id, 'secret_id', 64);
    }
    if (input.monthly_token_budget != null && (!Number.isSafeInteger(input.monthly_token_budget) || input.monthly_token_budget <= 0)) {
      throw new TypeError('LLM_CONFIG_INVALID: monthly_token_budget must be a positive safe integer.');
    }

    return (this.options.tenantTransaction ?? withTenantContext)(tenant_id, async (client) => {
      const beforeResult = await client.query<TenantConfigRow>(
        `SELECT tenant_id::text AS tenant_id, mode, provider_id, base_url, reasoning_model, fast_model, timeout_ms,
                structured_mode, secret_id::text AS secret_id, monthly_token_budget::text AS monthly_token_budget,
                config_version::text AS config_version, updated_at
           FROM agentos.tenant_llm_configs WHERE tenant_id = $1`,
        [tenant_id],
      );
      const result = await client.query<TenantConfigRow>(
        `INSERT INTO agentos.tenant_llm_configs
           (tenant_id, mode, provider_id, base_url, reasoning_model, fast_model, timeout_ms,
            structured_mode, secret_id, monthly_token_budget)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id) DO UPDATE SET
           mode = EXCLUDED.mode,
           provider_id = EXCLUDED.provider_id,
           base_url = EXCLUDED.base_url,
           reasoning_model = EXCLUDED.reasoning_model,
           fast_model = EXCLUDED.fast_model,
           timeout_ms = EXCLUDED.timeout_ms,
           structured_mode = EXCLUDED.structured_mode,
           secret_id = EXCLUDED.secret_id,
           monthly_token_budget = EXCLUDED.monthly_token_budget,
           config_version = agentos.tenant_llm_configs.config_version + 1,
           updated_at = CURRENT_TIMESTAMP
         RETURNING tenant_id::text AS tenant_id, mode, provider_id, base_url, reasoning_model, fast_model, timeout_ms,
                   structured_mode, secret_id::text AS secret_id, monthly_token_budget::text AS monthly_token_budget,
                   config_version::text AS config_version, updated_at`,
        [tenant_id, input.mode, input.mode === 'CUSTOM' ? input.provider_id ?? null : null,
          input.mode === 'CUSTOM' ? input.base_url ?? null : null,
          input.mode === 'CUSTOM' ? input.reasoning_model ?? null : null,
          input.mode === 'CUSTOM' ? input.fast_model ?? null : null,
          input.mode === 'CUSTOM' ? input.timeout_ms ?? null : null,
          input.mode === 'CUSTOM' ? input.structured_mode ?? null : null,
          input.mode === 'CUSTOM' ? input.secret_id ?? null : null, input.monthly_token_budget ?? null],
      );
      const row = result.rows[0];
      if (row === undefined) throw new Error('LLM_CONFIG_PERSISTENCE_FAILED');
      const prior = beforeResult.rows[0];
      const auditView = (record: TenantLlmConfigRecord | null): unknown | null => record === null ? null : {
        mode: record.mode,
        provider_id: record.provider_id,
        base_url: record.base_url,
        reasoning_model: record.reasoning_model,
        fast_model: record.fast_model,
        timeout_ms: record.timeout_ms,
        structured_mode: record.structured_mode,
        credential_configured: record.secret_id !== null,
        // The audit writer (0029) refuses keys containing secret-like words such as "token".
        monthly_budget: record.monthly_token_budget,
      };
      await appendConfigAudit(client, auditContext(actor, 'company.llm', tenant_id, 'llm.config', 'llm.config.update',
        prior === undefined ? null : auditView(tenantRecord(prior)), auditView(tenantRecord(row))));
      return tenantRecord(row);
    });
  }

  async recordProbe(scope: LlmProbeScope, result: LlmProbeResult): Promise<void> {
    if (result.outcome !== 'PASS' && result.outcome !== 'FAIL') throw new TypeError('LLM_PROBE_INVALID');
    if (result.latency_ms !== null && (!Number.isSafeInteger(result.latency_ms) || result.latency_ms < 0)) {
      throw new TypeError('LLM_PROBE_INVALID');
    }
    if (result.http_status !== null && (!Number.isSafeInteger(result.http_status) || result.http_status < 100 || result.http_status > 599)) {
      throw new TypeError('LLM_PROBE_INVALID');
    }
    const values = [scope.kind, scope.kind === 'TENANT' ? scope.tenant_id : null, scope.provider_id,
      result.outcome, result.latency_ms, result.http_status, result.error_class];
    const insert = async (client: PoolClient): Promise<void> => {
      await client.query<ProbeRow>(
        `INSERT INTO agentos.llm_probe_results
           (scope, tenant_id, provider_id, outcome, latency_ms, http_status, error_class)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING probe_id::text AS probe_id`,
        values,
      );
    };
    if (scope.kind === 'PLATFORM') {
      await (this.options.platformTransaction ?? withPlatformRole)(insert);
    } else {
      await (this.options.tenantTransaction ?? withTenantContext)(scope.tenant_id, insert);
    }
  }
}
