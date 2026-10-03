import type { PoolClient, QueryResultRow } from 'pg';
import type { TenantTransactionRunner } from './effect-reservations.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDatabase = vi.hoisted(() => {
  const statements: { sql: string; values?: readonly unknown[] }[] = [];
  const defaultQuery = async (
    sql: string,
    values?: readonly unknown[],
  ): Promise<{ rows: QueryResultRow[] }> => {
    statements.push(values === undefined ? { sql } : { sql, values });
    if (sql.includes('SELECT agentos.provision_tenant_shell(')) {
      return { rows: [{ tenant_id: '00000000-0000-4000-8000-000000000001' }] };
    }
    if (sql.includes('WITH seeded_settings AS')) return { rows: [{ seeded: 0 }] };
    return { rows: [] };
  };
  const query = vi.fn(defaultQuery);
  const release = vi.fn();
  return { statements, query, release, defaultQuery };
});

vi.mock('../client.js', () => ({
  getPool: () => ({ connect: async () => mockDatabase }),
  getPlatformPool: () => ({ connect: async () => mockDatabase }),
}));

import { P5ProvisioningRepository } from './p5-provisioning.js';

describe('P5ProvisioningRepository', () => {
  beforeEach(() => {
    mockDatabase.statements.length = 0;
    mockDatabase.query.mockReset();
    mockDatabase.query.mockImplementation(mockDatabase.defaultQuery);
    mockDatabase.release.mockClear();
  });

  it('passes the requested data class to tenant shell provisioning', async () => {
    const repository = new P5ProvisioningRepository();

    await expect(repository.provisionTenantShell({
      idempotency_key: 'a'.repeat(64),
      request_fingerprint: 'b'.repeat(64),
      display_name: 'Demo tenant',
      data_class: 'DEMO',
    })).resolves.toBe('00000000-0000-4000-8000-000000000001');

    expect(mockDatabase.statements).toContainEqual({
      sql: expect.stringContaining('$4::agentos.data_class'),
      values: ['a'.repeat(64), 'b'.repeat(64), 'Demo tenant', 'DEMO'],
    });
    expect(mockDatabase.release).toHaveBeenCalledOnce();
  });
  it('defaults existing provisioning calls to PRODUCTION', async () => {
    const repository = new P5ProvisioningRepository();

    await repository.provisionTenantShell({
      idempotency_key: 'c'.repeat(64),
      request_fingerprint: 'd'.repeat(64),
      display_name: 'Production tenant',
    });

    expect(mockDatabase.statements).toContainEqual({
      sql: expect.stringContaining('$4::agentos.data_class'),
      values: ['c'.repeat(64), 'd'.repeat(64), 'Production tenant', 'PRODUCTION'],
    });
  });

  it('provisions READ settings and contract agents atomically without enabling non-READ skills', async () => {
    const tenant_id = '00000000-0000-4000-8000-000000000001';
    const catalog = [
      { skill_id: 'skill.sales.search_product', effect_class: 'READ', agents: ['SAL-01', 'SAL-02'], retired: false },
      { skill_id: 'skill.care.search_faq', effect_class: 'READ', agents: ['CS-01'], retired: false },
      { skill_id: 'skill.sales.create_order', effect_class: 'EFFECT', agents: ['SAL-01'], retired: false },
      { skill_id: 'skill.care.escalate_to_human', effect_class: 'APPROVAL', agents: ['CS-01'], retired: false },
      { skill_id: 'skill.platform.inspect', effect_class: 'INTERNAL', agents: ['CS-01'], retired: false },
      { skill_id: 'skill.sales.retired_read', effect_class: 'READ', agents: ['SAL-01'], retired: true },
    ];
    const settings = new Map<string, boolean>();
    const assignments = new Map<string, string[]>();
    let context: unknown;
    mockDatabase.query.mockImplementation(async (sql, values) => {
      if (sql.includes("set_config('app.current_tenant_id'")) context = values?.[0];
      if (sql.includes('WITH seeded_settings AS')) {
        mockDatabase.statements.push(values === undefined ? { sql } : { sql, values });
        expect(context).toBe(tenant_id);
        expect(values).toEqual([tenant_id, 'tenant-provisioning']);
        expect(sql).toContain("(c.effect_class = 'READ')");
        expect(sql).toContain('WHERE c.retired = false');
        expect(sql).toContain('ON CONFLICT (tenant_id, skill_id) DO NOTHING');
        expect(sql).toContain('FROM seeded_settings AS s');
        expect(sql).toContain('unnest(c.allowed_agents)');
        expect(sql).toContain("WHERE c.effect_class = 'READ'");
        expect(sql).toContain('ON CONFLICT (tenant_id, skill_id, agent_code) DO NOTHING');
        let seeded = 0;
        for (const skill of catalog) {
          if (skill.retired || settings.has(skill.skill_id)) continue;
          settings.set(skill.skill_id, skill.effect_class === 'READ');
          if (skill.effect_class === 'READ') assignments.set(skill.skill_id, [...skill.agents]);
          seeded += 1;
        }
        return { rows: [{ seeded }] };
      }
      if (sql.includes('platform_append_audit')) {
        mockDatabase.statements.push(values === undefined ? { sql } : { sql, values });
        return { rows: [{ event_id: 'baseline-audit' }] };
      }
      return mockDatabase.defaultQuery(sql, values);
    });
    const input = {
      idempotency_key: 'e'.repeat(64),
      request_fingerprint: 'f'.repeat(64),
      display_name: 'New company',
    };
    const repository = new P5ProvisioningRepository();

    await expect(repository.provisionTenantShell(input)).resolves.toBe(tenant_id);
    expect([...settings]).toEqual([
      ['skill.sales.search_product', true],
      ['skill.care.search_faq', true],
      ['skill.sales.create_order', false],
      ['skill.care.escalate_to_human', false],
      ['skill.platform.inspect', false],
    ]);
    expect([...assignments]).toEqual([
      ['skill.sales.search_product', ['SAL-01', 'SAL-02']],
      ['skill.care.search_faq', ['CS-01']],
    ]);
    const firstCommit = mockDatabase.statements.findIndex(({ sql }) => sql === 'COMMIT');
    const baseline = mockDatabase.statements.findIndex(({ sql }) => sql.includes('WITH seeded_settings AS'));
    expect(baseline).toBeGreaterThan(0);
    expect(firstCommit).toBeGreaterThan(baseline);

    // Re-provisioning must preserve both a disabled skill and deliberately narrowed assignments.
    settings.set('skill.sales.search_product', false);
    assignments.set('skill.sales.search_product', ['SAL-02']);
    assignments.set('skill.care.search_faq', []);
    await expect(repository.provisionTenantShell(input)).resolves.toBe(tenant_id);
    expect(settings.get('skill.sales.search_product')).toBe(false);
    expect(assignments.get('skill.sales.search_product')).toEqual(['SAL-02']);
    expect(assignments.get('skill.care.search_faq')).toEqual([]);
    expect(settings.size).toBe(5);
    expect(mockDatabase.statements.filter(({ sql }) => sql.includes('platform_append_audit'))).toHaveLength(1);
    expect(mockDatabase.statements.filter(({ sql }) => sql === 'COMMIT')).toHaveLength(2);
  });

  it('rolls back the tenant shell when baseline skill provisioning fails', async () => {
    const failure = new Error('binding write failed');
    mockDatabase.query.mockImplementation(async (sql, values) => {
      if (sql.includes('WITH seeded_settings AS')) throw failure;
      return mockDatabase.defaultQuery(sql, values);
    });

    await expect(new P5ProvisioningRepository().provisionTenantShell({
      idempotency_key: 'a'.repeat(64),
      request_fingerprint: 'b'.repeat(64),
      display_name: 'New company',
    })).rejects.toBe(failure);

    expect(mockDatabase.statements.some(({ sql }) => sql === 'ROLLBACK')).toBe(true);
    expect(mockDatabase.statements.some(({ sql }) => sql === 'COMMIT')).toBe(false);
    expect(mockDatabase.release).toHaveBeenCalledOnce();
  });
  it('resolves an owner input once with CAS and a redacted audit event in the same tenant transaction', async () => {
    const statements: { readonly sql: string; readonly values?: readonly unknown[] }[] = [];
    const current = {
      tenant_id: 'tenant-a',
      input_id: 'careOnboardingItinerary',
      status: 'UNRESOLVED',
      version: '1',
      resolved_value: null,
      resolved_value_ref: null,
      resolved_by: null,
      resolved_at: null,
    };
    const updated = {
      ...current,
      status: 'RESOLVED',
      version: '2',
      resolved_value: { itinerary: [{ step: 'owner-defined' }] },
      resolved_by: 'operator-1',
      resolved_at: new Date('2026-09-30T12:00:00.000Z'),
    };
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      statements.push(values === undefined ? { sql } : { sql, values });
      if (sql.includes('FOR UPDATE')) return { rows: [current] };
      if (sql.startsWith('UPDATE agentos.unresolved_owner_inputs')) return { rows: [updated] };
      if (sql.includes('platform_append_audit')) return { rows: [{ event_id: 'audit-1' }] };
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;
    const tenants: string[] = [];
    const runner: TenantTransactionRunner = async (tenant_id, work) => {
      tenants.push(tenant_id);
      return work(client);
    };

    const result = await new P5ProvisioningRepository(runner).resolveOwnerInput({
      tenant_id: 'tenant-a',
      input_id: 'careOnboardingItinerary',
      expected_version: 1,
      value: { itinerary: [{ step: 'owner-defined' }] },
      actor_kind: 'OPERATOR',
      actor_id: 'operator-1',
      correlation_id: 'correlation-1',
    });

    expect(tenants).toEqual(['tenant-a']);
    expect(result).toMatchObject({ status: 'RESOLVED', input: { version: 2, status: 'RESOLVED' } });
    expect(statements.map(({ sql }) => sql.includes('platform_append_audit') ? 'audit' : sql.startsWith('UPDATE') ? 'update' : 'lock'))
      .toEqual(['lock', 'update', 'audit']);
    const audit = statements.find(({ sql }) => sql.includes('platform_append_audit'));
    expect(audit?.values).toEqual([
      'OPERATOR',
      'operator-1',
      'company.owner_inputs',
      'RESOLVE',
      'tenant-a',
      'careOnboardingItinerary',
      'ACCEPTED',
      null,
      JSON.stringify({ status: 'UNRESOLVED', version: 1 }),
      JSON.stringify({ status: 'RESOLVED', version: 2, value_kind: 'INLINE' }),
      'correlation-1',
    ]);
    expect(audit?.values).not.toContain(JSON.stringify({ itinerary: [{ step: 'owner-defined' }] }));
  });

  it('does not update or audit a stale owner-input version', async () => {
    const statements: string[] = [];
    const current = {
      tenant_id: 'tenant-a',
      input_id: 'careOnboardingItinerary',
      status: 'UNRESOLVED',
      version: '2',
      resolved_value: null,
      resolved_value_ref: null,
      resolved_by: null,
      resolved_at: null,
    };
    const query = vi.fn(async (sql: string) => {
      statements.push(sql);
      return sql.includes('FOR UPDATE') ? { rows: [current] } : { rows: [] };
    });
    const client = { query } as unknown as PoolClient;
    const runner: TenantTransactionRunner = async (_tenant_id, work) => work(client);

    await expect(new P5ProvisioningRepository(runner).resolveOwnerInput({
      tenant_id: 'tenant-a',
      input_id: 'careOnboardingItinerary',
      expected_version: 1,
      value_ref: 'vault://itinerary',
      actor_kind: 'OPERATOR',
      actor_id: 'operator-1',
      correlation_id: 'correlation-1',
    })).resolves.toEqual({ status: 'VERSION_CONFLICT' });

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('FOR UPDATE');
  });

});
