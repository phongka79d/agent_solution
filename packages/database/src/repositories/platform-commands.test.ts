import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  query: vi.fn(),
  release: vi.fn(),
  appConnect: vi.fn(),
  platformConnect: vi.fn(),
}));
vi.mock('../client.js', () => ({
  getPool: () => ({ connect: database.appConnect }),
  getPlatformPool: () => ({ connect: database.platformConnect }),
}));

import { PlatformCompanyRepository } from './platform-commands.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const lifecycleSql = readFileSync(new URL('../../migrations/0066_platform_tenant_lifecycle.sql', import.meta.url), 'utf8');

describe('PlatformCompanyRepository', () => {
  beforeEach(() => {
    database.query.mockReset();
    database.release.mockReset();
    database.appConnect.mockReset();
    database.platformConnect.mockReset();
    database.platformConnect.mockResolvedValue(database);
  });

  it.each([
    { command: 'suspend', status: 'SUSPENDED' },
    { command: 'resume', status: 'ACTIVE' },
  ])('runs $command through the platform role and tenant-fenced function', async ({ command, status }) => {
    database.query.mockImplementation(async (sql: string) => ({
      rows: sql.includes('platform_set_tenant_status') ? [{ tenant_id: TENANT, status }] : [],
    }));
    const repository = new PlatformCompanyRepository();
    const result = command === 'suspend' ? await repository.suspend(TENANT) : await repository.resume(TENANT);
    expect(result).toEqual({ tenant_id: TENANT, status });
    expect(database.appConnect).not.toHaveBeenCalled();
    expect(database.platformConnect).toHaveBeenCalledOnce();
    expect(database.query.mock.calls).toEqual([
      ['BEGIN'],
      ['SET LOCAL ROLE agentos_platform'],
      ['SET LOCAL search_path TO agentos, public'],
      ["SELECT set_config('app.current_tenant_id', $1, true)", [TENANT]],
      ['SELECT tenant_id, status FROM agentos.platform_set_tenant_status($1::uuid, $2::text)', [TENANT, status]],
      ['COMMIT'],
    ]);
    expect(database.release).toHaveBeenCalledOnce();
  });

  it('rolls back when the explicitly targeted company does not exist', async () => {
    database.query.mockResolvedValue({ rows: [] });
    await expect(new PlatformCompanyRepository().suspend(TENANT)).rejects.toThrow('PLATFORM_TENANT_NOT_FOUND');
    expect(database.query).toHaveBeenCalledWith('ROLLBACK');
    expect(database.query).not.toHaveBeenCalledWith('COMMIT');
    expect(database.release).toHaveBeenCalledOnce();
  });

  it('rejects an empty target before obtaining any connection', async () => {
    await expect(new PlatformCompanyRepository().resume(' ')).rejects.toThrow('PLATFORM_TENANT_ID_REQUIRED');
    expect(database.platformConnect).not.toHaveBeenCalled();
  });

  it('keeps the lifecycle capability platform-only and context-fenced without table grants', () => {
    expect(lifecycleSql).toContain('SECURITY DEFINER');
    expect(lifecycleSql).toContain('SET search_path = pg_catalog, agentos, pg_temp');
    expect(lifecycleSql).toContain("current_setting('app.current_tenant_id', TRUE) IS DISTINCT FROM p_tenant::text");
    expect(lifecycleSql).toContain("p_status NOT IN ('SUSPENDED', 'ACTIVE')");
    expect(lifecycleSql).toContain('WHERE target.tenant_id = p_tenant');
    expect(lifecycleSql).toContain('FROM PUBLIC, agentos_app');
    expect(lifecycleSql).toContain('TO agentos_platform');
    expect(lifecycleSql).not.toMatch(/GRANT\s+(?:ALL|UPDATE|SELECT)/i);
  });
});
