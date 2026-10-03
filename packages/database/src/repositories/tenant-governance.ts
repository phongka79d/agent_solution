import type { QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import { appendConfigAudit } from './platform-audit.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

interface TenantGovernanceSettingsRow extends QueryResultRow {
  tenant_id: string;
  require_distinct_approver: boolean;
  approval_expiry_hours: number;
  takeover_lease_seconds: number;
  version: number;
  updated_at: Date | string;
}

export interface TenantGovernanceSettingsRecord {
  readonly tenant_id: string;
  readonly require_distinct_approver: boolean;
  readonly approval_expiry_hours: number;
  readonly takeover_lease_seconds: number;
  readonly version: number;
  readonly updated_at: string;
}

export interface UpdateTenantGovernanceSettingsInput {
  readonly require_distinct_approver: boolean;
  readonly approval_expiry_hours: number;
  readonly takeover_lease_seconds: number;
  readonly expected_version: number;
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly correlation_id: string;
}

const SETTINGS_COLUMNS = `tenant_id::text AS tenant_id,
                          require_distinct_approver,
                          approval_expiry_hours,
                          takeover_lease_seconds,
                          version,
                          updated_at`;

function recordOf(row: TenantGovernanceSettingsRow): TenantGovernanceSettingsRecord {
  return {
    tenant_id: row.tenant_id,
    require_distinct_approver: row.require_distinct_approver,
    approval_expiry_hours: row.approval_expiry_hours,
    takeover_lease_seconds: row.takeover_lease_seconds,
    version: row.version,
    updated_at: row.updated_at instanceof Date
      ? row.updated_at.toISOString()
      : new Date(row.updated_at).toISOString(),
  };
}

/** Tenant-scoped governance settings with audited optimistic writes. */
export class TenantGovernanceRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner = withTenantContext) {
    this.runner = runner;
  }

  async get(tenant_id: string): Promise<TenantGovernanceSettingsRecord | null> {
    return this.runner(tenant_id, async (client) => {
      const result = await client.query<TenantGovernanceSettingsRow>(
        `SELECT ${SETTINGS_COLUMNS}
           FROM agentos.tenant_governance_settings
          WHERE tenant_id = $1`,
        [tenant_id],
      );
      const row = result.rows[0];
      return row === undefined ? null : recordOf(row);
    });
  }

  async update(
    tenant_id: string,
    input: UpdateTenantGovernanceSettingsInput,
  ): Promise<TenantGovernanceSettingsRecord | null> {
    if (
      typeof input.require_distinct_approver !== 'boolean'
      || !Number.isInteger(input.approval_expiry_hours)
      || input.approval_expiry_hours < 1
      || input.approval_expiry_hours > 720
      || !Number.isInteger(input.takeover_lease_seconds)
      || input.takeover_lease_seconds < 30
      || input.takeover_lease_seconds > 600
      || !Number.isSafeInteger(input.expected_version)
      || input.expected_version < 1
      || typeof input.actor_kind !== 'string'
      || input.actor_kind.length === 0
      || typeof input.actor_id !== 'string'
      || input.actor_id.length === 0
      || typeof input.correlation_id !== 'string'
      || input.correlation_id.length === 0
    ) {
      throw new Error('GOVERNANCE_SETTINGS_INVALID');
    }

    return this.runner(tenant_id, async (client) => {
      const currentResult = await client.query<TenantGovernanceSettingsRow>(
        `SELECT ${SETTINGS_COLUMNS}
           FROM agentos.tenant_governance_settings
          WHERE tenant_id = $1
          FOR UPDATE`,
        [tenant_id],
      );
      const current = currentResult.rows[0];
      if (current === undefined) throw new Error('GOVERNANCE_SETTINGS_NOT_FOUND');
      if (current.version !== input.expected_version) return null;

      const updatedResult = await client.query<TenantGovernanceSettingsRow>(
        `UPDATE agentos.tenant_governance_settings
            SET require_distinct_approver = $2,
                approval_expiry_hours = $3,
                takeover_lease_seconds = $4,
                version = version + 1,
                updated_at = clock_timestamp()
          WHERE tenant_id = $1 AND version = $5
          RETURNING ${SETTINGS_COLUMNS}`,
        [
          tenant_id,
          input.require_distinct_approver,
          input.approval_expiry_hours,
          input.takeover_lease_seconds,
          input.expected_version,
        ],
      );
      const updated = updatedResult.rows[0];
      if (updated === undefined) return null;
      await appendConfigAudit(client, {
        actor_kind: input.actor_kind,
        actor_id: input.actor_id,
        scope: 'company.governance',
        action: 'company.governance.update',
        target_tenant: tenant_id,
        target: 'tenant_governance_settings',
        outcome: 'ACCEPTED',
        reason: null,
        before: recordOf(current),
        after: recordOf(updated),
        correlation_id: input.correlation_id,
      });
      return recordOf(updated);
    });
  }
}
