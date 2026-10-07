import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { PlatformTransactionRunner } from './platform-directory.js';
import { PlatformDirectoryRepository } from './platform-directory.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CREATED_AT = new Date('2026-09-23T00:00:00.000Z');

describe('PlatformDirectoryRepository', () => {
  it('calls every projection through the injected platform transaction', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('platform_list_tenants')) {
        return { rows: [{ tenant_id: TENANT, display_name: 'Acme', status: 'PROVISIONED', created_at: CREATED_AT, enabled_modules: null }] };
      }
      if (sql.includes('platform_get_tenant')) {
        return { rows: [{ tenant_id: TENANT, display_name: 'Acme', status: 'PROVISIONED', created_at: CREATED_AT, enabled_modules: ['care'] }] };
      }
      if (sql.includes('platform_tenant_readiness')) {
        return { rows: [{
          tenant_id: TENANT,
          capability_count: '2',
          capability_statuses: { care: 'CONFIGURED' },
          connector_count: null,
          connector_statuses: null,
          owner_input_count: '1',
          owner_input_statuses: { policy: 'UNRESOLVED' },
          workspace_status: 'UNCONFIGURED',
          residency_status: null,
        }] };
      }
      return { rows: [{
        tenant_id: TENANT,
        runs_count: '3',
        token_cost_records_count: null,
        estimated_cost_total: null,
        input_tokens_total: null,
        output_tokens_total: null,
        cached_tokens_total: null,
      }] };
    });
    const client = { query } as unknown as PoolClient;
    const calls: number[] = [];
    const transaction: PlatformTransactionRunner = async (work) => {
      calls.push(1);
      return work(client);
    };
    const repository = new PlatformDirectoryRepository({ transaction });

    await expect(repository.listTenants()).resolves.toEqual([{
      tenant_id: TENANT,
      display_name: 'Acme',
      status: 'PROVISIONED',
      created_at: CREATED_AT.toISOString(),
      enabled_modules: null,
    }]);
    await expect(repository.getTenant(TENANT)).resolves.toEqual(expect.objectContaining({ enabled_modules: ['care'] }));
    await expect(repository.readiness(TENANT)).resolves.toEqual(expect.objectContaining({ capability_count: 2, connector_count: null }));
    await expect(repository.usage('2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')).resolves.toEqual([expect.objectContaining({ runs_count: 3 })]);

    expect(calls).toHaveLength(4);
    expect(query).toHaveBeenCalledWith('SELECT * FROM agentos.platform_get_tenant($1::uuid)', [TENANT]);
  });

  it('rejects an empty or reversed usage window before opening a transaction', async () => {
    const transactionMock = vi.fn<[(client: PoolClient) => Promise<unknown>], Promise<unknown>>();
    const transaction: PlatformTransactionRunner = async <T>(
      work: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      const result = await transactionMock(work);
      return result as T;
    };
    const repository = new PlatformDirectoryRepository({ transaction });

    await expect(repository.usage('not-a-time', '2026-10-01T00:00:00.000Z')).rejects.toThrow('PLATFORM_USAGE_WINDOW_INVALID');
    await expect(repository.usage('2026-10-02T00:00:00.000Z', '2026-10-01T00:00:00.000Z')).rejects.toThrow('PLATFORM_USAGE_WINDOW_INVALID');
    expect(transactionMock).not.toHaveBeenCalled();
  });
});
