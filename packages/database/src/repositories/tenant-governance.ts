import type { QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

interface TenantGovernanceSettingsRow extends QueryResultRow {
  tenant_id: string;
  require_distinct_approver: boolean;
  updated_at: Date;
}

export interface TenantGovernanceSettingsRecord {
  readonly tenant_id: string;
  readonly require_distinct_approver: boolean;
  readonly updated_at: string;
}

/** Tenant-scoped read-only access to the D2 governance setting. */
export class TenantGovernanceRepository {
  private readonly runner: TenantTransactionRunner;

  constructor(runner: TenantTransactionRunner = withTenantContext) {
    this.runner = runner;
  }

  async get(tenant_id: string): Promise<TenantGovernanceSettingsRecord | null> {
    return this.runner(tenant_id, async (client) => {
      const result = await client.query<TenantGovernanceSettingsRow>(
        `SELECT tenant_id::text AS tenant_id,
                require_distinct_approver,
                updated_at
           FROM agentos.tenant_governance_settings
          WHERE tenant_id = $1`,
        [tenant_id],
      );
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        tenant_id: row.tenant_id,
        require_distinct_approver: row.require_distinct_approver,
        updated_at: row.updated_at.toISOString(),
      };
    });
  }
}
