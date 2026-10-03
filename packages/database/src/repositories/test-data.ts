import type { QueryResultRow } from 'pg';

import { withTenantContext } from '../rls.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

export interface TestDataResetResult {
  readonly tenant_id: string;
  readonly dry_run: boolean;
  readonly counts: Readonly<Record<string, number>>;
}

export interface TestDataRepositoryOptions {
  readonly tenantTransaction?: TenantTransactionRunner;
}

interface ResetRow extends QueryResultRow {
  readonly result: TestDataResetResult;
}

export class TestDataRepository {
  private readonly tenantTransaction: TenantTransactionRunner;

  constructor(options: TestDataRepositoryOptions = {}) {
    this.tenantTransaction = options.tenantTransaction ?? withTenantContext;
  }

  async resetTestData(tenant_id: string, actor: string, dry_run: boolean): Promise<TestDataResetResult> {
    if (typeof actor !== 'string' || actor.trim().length === 0 || actor.trim() !== actor || actor.length > 256) {
      throw new TypeError('TEST_DATA_ACTOR_INVALID');
    }
    if (typeof dry_run !== 'boolean') throw new TypeError('TEST_DATA_DRY_RUN_INVALID');

    return this.tenantTransaction(tenant_id, async (client) => {
      await client.query('SET LOCAL ROLE agentos_test_reset');
      const result = await client.query<ResetRow>(
        'SELECT agentos.reset_test_data($1::uuid, $2::text, $3::boolean) AS result',
        [tenant_id, actor, dry_run],
      );
      const row = result.rows[0];
      if (!row) throw new Error('TEST_DATA_RESET_RESULT_MISSING');
      return row.result;
    });
  }
}
