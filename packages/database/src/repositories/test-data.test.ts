import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { TenantTransactionRunner } from './effect-reservations.js';
import { TestDataRepository } from './test-data.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

describe('TestDataRepository', () => {
  it('calls the audited reset function under the dedicated reset role and returns its dry-run counts', async () => {
    const result = {
      tenant_id: TENANT,
      dry_run: true,
      counts: { customers: 2, orders: 1, approvals: 0 },
    };
    const query = vi.fn(async (_sql: string, _values: readonly unknown[] = []) => ({ rows: [{ result }] }));
    const client = { query } as unknown as PoolClient;
    const boundTenants: string[] = [];
    const tenantTransaction: TenantTransactionRunner = async (tenant_id, work) => {
      boundTenants.push(tenant_id);
      return work(client);
    };
    const repository = new TestDataRepository({ tenantTransaction });

    await expect(repository.resetTestData(TENANT, 'operator-1', true)).resolves.toEqual(result);

    expect(boundTenants).toEqual([TENANT]);
    expect(query.mock.calls[0]).toEqual(['SET LOCAL ROLE agentos_test_reset']);
    expect(query.mock.calls[1]).toEqual([
      'SELECT agentos.reset_test_data($1::uuid, $2::text, $3::boolean) AS result',
      [TENANT, 'operator-1', true],
    ]);
  });
});
