import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it } from 'vitest';

import { CompanyCrmProjectionRepository } from './company-crm-projections.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CUSTOMER = '01920000-0000-7000-8000-0000000000c1';

function harness(rows: readonly QueryResultRow[] = []) {
  const calls: Array<{ sql: string; params: readonly unknown[] }> = [];
  const client = {
    query: async <R extends QueryResultRow>(sql: string, params: readonly unknown[] = []) => {
      calls.push({ sql, params });
      return { rows: rows as R[], rowCount: rows.length } as unknown as QueryResult<R>;
    },
  } as unknown as PoolClient;
  const tenants: string[] = [];
  const repository = new CompanyCrmProjectionRepository(async (tenant, work) => {
    tenants.push(tenant);
    return work(client);
  });
  return { repository, calls, tenants };
}

describe('CompanyCrmProjectionRepository', () => {
  it('returns no profile when the customer 360 source view has no row', async () => {
    const { repository, tenants } = harness();
    await expect(repository.getCustomerProfile(TENANT, CUSTOMER)).resolves.toBeNull();
    expect(tenants).toEqual([TENANT]);
  });

  it('binds campaign list reads to the tenant and durable marketing task source', async () => {
    const { repository, calls, tenants } = harness();
    await repository.listCampaigns({ tenant_id: TENANT, limit: 10 });
    expect(tenants).toEqual([TENANT]);
    expect(calls[0]?.params[0]).toBe(TENANT);
    expect(calls[0]?.sql).toContain("t.state_payload->'signal'->'payload'->>'module' = 'marketing'");
    expect(calls[0]?.sql).toContain('t.tenant_id = $1');
  });
});
