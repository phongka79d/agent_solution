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

  it.each(['TEST', 'DEMO', 'PRODUCTION'])('selects and preserves the customer root class %s on list and profile reads', async (data_class) => {
    const { repository, calls, tenants } = harness([{
      customer_id: CUSTOMER,
      tenant_id: TENANT,
      data_class,
      created_at: '2026-01-01T00:00:00.000Z',
    }]);

    const page = await repository.listCustomers({ tenant_id: TENANT });
    const profile = await repository.getCustomerProfile(TENANT, CUSTOMER);

    expect(page.items[0]?.data_class).toBe(data_class);
    expect(profile?.data_class).toBe(data_class);
    expect(tenants).toEqual([TENANT, TENANT]);
    expect(calls[0]?.sql).toContain('c.data_class::text AS data_class');
    expect(calls[1]?.sql).toContain('c.data_class::text AS data_class');
    expect(calls[1]?.params).toEqual([TENANT, CUSTOMER]);
  });

  it('returns computed inactive audiences inside the requested tenant context', async () => {
    const { repository, calls, tenants } = harness([]);
    await expect(repository.listCampaignSegments(TENANT)).resolves.toEqual([]);
    expect(tenants).toEqual([TENANT]);
    expect(calls[0]?.params).toEqual([TENANT]);
    expect(calls[0]?.sql).toContain('agentos.customer_360_profiles');
    expect(calls[0]?.sql).toContain("VALUES (30), (60), (90), (180)");
    expect(calls[0]?.sql).toContain('last_paid_purchase_at');
    expect(calls[0]?.sql).toContain('consent.consent_type =');
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
