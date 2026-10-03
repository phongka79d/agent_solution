import type { PoolClient, QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import { appendConfigAudit } from './platform-audit.js';
import { canonicalizeJson } from './canonical-json.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

interface TenantProfileRow extends QueryResultRow {
  readonly tenant_id: string;
  readonly company_name: string;
  readonly industry: string | null;
  readonly locale: string;
  readonly timezone: string;
  readonly currency: string;
  readonly brand_profile: Readonly<Record<string, unknown>>;
  readonly version: string;
  readonly updated_at: Date | string;
}

export interface TenantProfileRecord {
  readonly tenant_id: string;
  readonly company_name: string;
  readonly industry: string | null;
  readonly locale: string;
  readonly timezone: string;
  readonly currency: string;
  readonly brand_profile: Readonly<Record<string, unknown>>;
  readonly version: number;
  readonly updated_at: string;
}

export interface TenantProfileValues {
  readonly company_name: string;
  readonly industry: string | null;
  readonly locale: string;
  readonly timezone: string;
  readonly currency: string;
  readonly brand_profile: Readonly<Record<string, unknown>>;
}

export interface UpdateTenantProfileInput {
  readonly tenant_id: string;
  readonly values: TenantProfileValues;
  readonly expected_version: number;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly correlation_id: string;
}

export type UpdateTenantProfileResult =
  | { readonly status: 'UPDATED'; readonly profile: TenantProfileRecord }
  | { readonly status: 'VERSION_CONFLICT'; readonly current_version: number };

function toRecord(row: TenantProfileRow): TenantProfileRecord {
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error('TENANT_PROFILE_VERSION_INVALID: stored version is outside the safe integer range.');
  }
  return {
    tenant_id: row.tenant_id,
    company_name: row.company_name,
    industry: row.industry,
    locale: row.locale,
    timezone: row.timezone,
    currency: row.currency.trim(),
    brand_profile: row.brand_profile,
    version,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(row.updated_at).toISOString(),
  };
}

function profileValues(profile: TenantProfileRecord): TenantProfileValues {
  return {
    company_name: profile.company_name,
    industry: profile.industry,
    locale: profile.locale,
    timezone: profile.timezone,
    currency: profile.currency,
    brand_profile: profile.brand_profile,
  };
}

function sameValues(left: TenantProfileValues, right: TenantProfileValues): boolean {
  return left.company_name === right.company_name
    && left.industry === right.industry
    && left.locale === right.locale
    && left.timezone === right.timezone
    && left.currency === right.currency
    && canonicalizeJson(left.brand_profile) === canonicalizeJson(right.brand_profile);
}

/** Tenant-scoped company profile reads and audited optimistic-concurrency updates. */
export class TenantProfileRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner = withTenantContext) {
    this.runner = runner;
  }

  /** Session workspace names come from tenant metadata, including tenants without a profile. */
  async getDisplayName(tenant_id: string): Promise<string | null> {
    return this.runner(tenant_id, async (client) => {
      const result = await client.query<{ display_name: string }>(
        'SELECT display_name FROM agentos.tenants WHERE tenant_id = $1',
        [tenant_id],
      );
      return result.rows[0]?.display_name ?? null;
    });
  }

  async get(tenant_id: string): Promise<TenantProfileRecord | null> {
    return this.runner(tenant_id, async (client) => {
      const result = await client.query<TenantProfileRow>(
        `SELECT tenant_id::text AS tenant_id, company_name, industry, locale, timezone,
                currency, brand_profile, version::text AS version, updated_at
           FROM agentos.tenant_profiles
          WHERE tenant_id = $1`,
        [tenant_id],
      );
      const row = result.rows[0];
      return row === undefined ? null : toRecord(row);
    });
  }

  async update(input: UpdateTenantProfileInput): Promise<UpdateTenantProfileResult> {
    return this.runner(input.tenant_id, async (client) => {
      const currentResult = await client.query<TenantProfileRow>(
        `SELECT tenant_id::text AS tenant_id, company_name, industry, locale, timezone,
                currency, brand_profile, version::text AS version, updated_at
           FROM agentos.tenant_profiles
          WHERE tenant_id = $1
          FOR UPDATE`,
        [input.tenant_id],
      );
      const currentRow = currentResult.rows[0];
      if (currentRow === undefined) throw new Error('TENANT_PROFILE_NOT_FOUND: profile row is missing.');
      const before = toRecord(currentRow);
      if (before.version !== input.expected_version) {
        return { status: 'VERSION_CONFLICT', current_version: before.version };
      }
      if (sameValues(profileValues(before), input.values)) return { status: 'UPDATED', profile: before };

      const updatedResult = await client.query<TenantProfileRow>(
        `UPDATE agentos.tenant_profiles
            SET company_name = $2,
                industry = $3,
                locale = $4,
                timezone = $5,
                currency = $6,
                brand_profile = $7::jsonb,
                version = version + 1,
                updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $1 AND version = $8::bigint
          RETURNING tenant_id::text AS tenant_id, company_name, industry, locale, timezone,
                    currency, brand_profile, version::text AS version, updated_at`,
        [
          input.tenant_id,
          input.values.company_name,
          input.values.industry,
          input.values.locale,
          input.values.timezone,
          input.values.currency,
          JSON.stringify(input.values.brand_profile),
          input.expected_version,
        ],
      );
      const updatedRow = updatedResult.rows[0];
      if (updatedRow === undefined) {
        const latest = await client.query<{ readonly version: string }>(
          'SELECT version::text AS version FROM agentos.tenant_profiles WHERE tenant_id = $1',
          [input.tenant_id],
        );
        const current_version = Number(latest.rows[0]?.version ?? before.version);
        return { status: 'VERSION_CONFLICT', current_version };
      }
      const profile = toRecord(updatedRow);
      await appendConfigAudit(client as PoolClient, {
        actor_kind: input.actor_kind,
        actor_id: input.actor_id,
        scope: 'company.profile',
        action: 'UPDATE',
        target_tenant: input.tenant_id,
        target: 'tenant_profiles',
        outcome: 'ACCEPTED',
        reason: null,
        before: { ...profileValues(before), version: before.version },
        after: { ...profileValues(profile), version: profile.version },
        correlation_id: input.correlation_id,
      });
      return { status: 'UPDATED', profile };
    });
  }
}
