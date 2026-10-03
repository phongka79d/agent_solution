import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';

import type { PlatformTransactionRunner } from './platform-directory.js';
import type { TenantTransactionRunner } from './effect-reservations.js';
import type { SkillCatalogManifestRow } from './skill-catalog.js';
import {
  SkillCatalogRefusal,
  SkillCatalogRepository,
  syncSkillCatalogAtBoot,
} from './skill-catalog.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const ACTOR = { actor_kind: 'OPERATOR', actor_id: 'operator-1', correlation_id: 'skill-catalog-test' };

function manifestRow(overrides: Partial<SkillCatalogManifestRow> = {}): SkillCatalogManifestRow {
  return {
    skill_id: 'skill.sales.check_price',
    display_key: 'skills.sales.check_price',
    domain: 'sales',
    effect_class: 'READ',
    required_authority: 'AUTH-1',
    autonomy_class: 'PROMOTABLE',
    completion: 'SYNC',
    receipt_ref: 'receipt.sales.check_price',
    tool_binding: 'PriceLookup',
    allowed_agents: ['SAL-01', 'SAL-02'],
    connector_kinds: ['erp'],
    config_schema: { properties: { currency: { type: 'string' } }, required: ['currency'] },
    contract_version: 1,
    contract_digest: DIGEST_A,
    ...overrides,
  };
}

/** Records every statement so a test can assert the shape of what the repository wrote. */
function recordingClient(handler: (sql: string, values: readonly unknown[]) => { rows: unknown[]; rowCount?: number }) {
  const statements: { sql: string; values: readonly unknown[] }[] = [];
  const client = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      statements.push({ sql, values });
      return handler(sql, values);
    },
  } as unknown as PoolClient;
  return { client, statements };
}

describe('SkillCatalogRepository.syncCatalog', () => {
  it('inserts catalog rows, retires unpublished ones, and reports the counts', async () => {
    const { client, statements } = recordingClient((sql) => {
      if (sql.includes('SELECT skill_id, contract_version, contract_digest')) {
        return { rows: [{ skill_id: 'skill.care.escalate_to_human', contract_version: '1', contract_digest: DIGEST_A }] };
      }
      if (sql.includes('SET retired = true')) return { rows: [{ skill_id: 'skill.care.escalate_to_human' }] };
      return { rows: [] };
    });
    const platformTransaction: PlatformTransactionRunner = (work) => work(client);

    const repository = new SkillCatalogRepository({ platformTransaction });
    const result = await repository.syncCatalog([manifestRow()]);

    expect(result).toEqual({ inserted: 1, updated: 0, unchanged: 0, retired: ['skill.care.escalate_to_human'] });
    const insert = statements.find((statement) => statement.sql.includes('INSERT INTO agentos.skill_catalog'));
    expect(insert?.values.slice(0, 9)).toEqual([
      'skill.sales.check_price',
      'skills.sales.check_price',
      'sales',
      'READ',
      'AUTH-1',
      'PROMOTABLE',
      'SYNC',
      'receipt.sales.check_price',
      'PriceLookup',
    ]);
  });

  it('leaves an unchanged contract alone without writing or auditing', async () => {
    const { client, statements } = recordingClient((sql) => {
      if (sql.includes('SELECT skill_id, contract_version, contract_digest')) {
        return { rows: [{ skill_id: 'skill.sales.check_price', contract_version: '1', contract_digest: DIGEST_A }] };
      }
      return { rows: [] };
    });
    const repository = new SkillCatalogRepository({ platformTransaction: (work) => work(client) });

    const result = await repository.syncCatalog([manifestRow()]);

    expect(result).toEqual({ inserted: 0, updated: 0, unchanged: 1, retired: [] });
    expect(statements.some((statement) => statement.sql.includes('INSERT INTO agentos.skill_catalog'))).toBe(false);
    expect(statements.some((statement) => statement.sql.includes('platform_append_audit'))).toBe(false);
  });

  it('refuses a digest change that did not bump the contract version', async () => {
    const { client } = recordingClient((sql) => {
      if (sql.includes('SELECT skill_id, contract_version, contract_digest')) {
        return { rows: [{ skill_id: 'skill.sales.check_price', contract_version: '1', contract_digest: DIGEST_A }] };
      }
      return { rows: [] };
    });
    const repository = new SkillCatalogRepository({ platformTransaction: (work) => work(client) });

    const refused = repository.syncCatalog([manifestRow({ contract_digest: DIGEST_B, contract_version: 1 })]);

    await expect(refused).rejects.toBeInstanceOf(SkillCatalogRefusal);
    await expect(refused).rejects.toMatchObject({
      code: 'SKILL_CONTRACT_DIGEST_CHANGED_WITHOUT_VERSION_BUMP',
      skill_id: 'skill.sales.check_price',
    });
  });

  it('accepts a digest change that bumped the version and audits the repin', async () => {
    const { client, statements } = recordingClient((sql) => {
      if (sql.includes('SELECT skill_id, contract_version, contract_digest')) {
        return { rows: [{ skill_id: 'skill.sales.check_price', contract_version: '1', contract_digest: DIGEST_A }] };
      }
      if (sql.includes('platform_append_audit')) return { rows: [{ event_id: 'audit-1' }] };
      return { rows: [] };
    });
    const repository = new SkillCatalogRepository({ platformTransaction: (work) => work(client) });

    const result = await repository.syncCatalog([manifestRow({ contract_digest: DIGEST_B, contract_version: 2 })]);

    expect(result.updated).toBe(1);
    const audit = statements.find((statement) => statement.sql.includes('platform_append_audit'));
    expect(audit?.values).toContain('skill.catalog.register');
    expect(audit?.values).toContain(JSON.stringify({ contract_version: '1', contract_digest: DIGEST_A }));
  });
});

describe('SkillCatalogRepository tenant binding', () => {
  it('raises a version conflict instead of overwriting a settings row written by someone else', async () => {
    const { client } = recordingClient((sql) => {
      if (sql.includes('SELECT effect_class FROM agentos.skill_catalog')) return { rows: [{ effect_class: 'EFFECT' }] };
      if (sql.includes('FROM agentos.tenant_skill_settings')) {
        return {
          rows: [{
            tenant_id: TENANT,
            skill_id: 'skill.sales.check_price',
            enabled: true,
            config: {},
            connector_id: null,
            version: '3',
            updated_by: 'someone-else',
            updated_at: new Date(0),
          }],
        };
      }
      return { rows: [] };
    });
    const tenantTransaction: TenantTransactionRunner = async (tenant_id, work) => {
      expect(tenant_id).toBe(TENANT);
      return work(client);
    };
    const repository = new SkillCatalogRepository({ tenantTransaction });

    await expect(repository.upsertSettings({
      tenant_id: TENANT,
      skill_id: 'skill.sales.check_price',
      enabled: false,
      config: {},
      connector_id: null,
      expected_version: '2',
      actor: ACTOR,
    })).rejects.toMatchObject({ code: 'SKILL_SETTINGS_VERSION_CONFLICT' });
  });

  it('refuses an agent outside the contract ceiling before the database trigger fires', async () => {
    const { client } = recordingClient((sql) => {
      if (sql.includes('SELECT allowed_agents FROM agentos.skill_catalog')) {
        return { rows: [{ allowed_agents: ['SAL-01', 'SAL-02'] }] };
      }
      return { rows: [] };
    });
    const repository = new SkillCatalogRepository({ tenantTransaction: (_tenant, work) => work(client) });

    await expect(
      repository.replaceAgentAssignments(TENANT, 'skill.sales.check_price', ['SAL-01', 'CS-01'], ACTOR),
    ).rejects.toMatchObject({
      code: 'SKILL_ASSIGNMENT_EXCEEDS_CONTRACT',
      skill_id: 'skill.sales.check_price',
    });
  });

  it('seeds READ settings with contract assignments and leaves non-READ settings disabled', async () => {
    const { client, statements } = recordingClient((sql, values) => {
      if (sql.includes('platform_append_audit')) return { rows: [{ event_id: 'audit-1' }] };
      if (sql.includes('WITH seeded_settings AS')) {
        expect(values).toEqual([TENANT, ACTOR.actor_id]);
        return { rows: [{ seeded: 5 }] };
      }
      throw new Error(`Unexpected baseline statement: ${sql}`);
    });
    const tenants: string[] = [];
    const repository = new SkillCatalogRepository({
      tenantTransaction: (tenant_id, work) => {
        tenants.push(tenant_id);
        return work(client);
      },
    });

    await expect(repository.seedDefaultSettings(TENANT, ACTOR)).resolves.toBe(5);
    expect(tenants).toEqual([TENANT]);
    const insert = statements.find((statement) => statement.sql.includes('WITH seeded_settings AS'));
    expect(insert?.sql).toContain("(c.effect_class = 'READ')");
    expect(insert?.sql).toContain('ON CONFLICT (tenant_id, skill_id) DO NOTHING');
    expect(insert?.sql).toContain('c.retired = false');
    expect(insert?.sql).toContain('INSERT INTO agentos.tenant_skill_agents');
    expect(insert?.sql).toContain('FROM seeded_settings AS s');
    expect(insert?.sql).toContain('unnest(c.allowed_agents)');
    expect(insert?.sql).toContain("WHERE c.effect_class = 'READ'");
    expect(insert?.sql).toContain('ON CONFLICT (tenant_id, skill_id, agent_code) DO NOTHING');
    expect(insert?.sql).not.toContain('DO UPDATE');
    const audit = statements.find((statement) => statement.sql.includes('platform_append_audit'));
    expect(audit?.values).toEqual([
      ACTOR.actor_kind, ACTOR.actor_id, 'COMPANY', 'skill.settings.seed_defaults', TENANT, '*',
      'ACCEPTED', null, null, JSON.stringify({ seeded: 5 }), ACTOR.correlation_id,
    ]);
  });

  it('does not reassign existing skills or emit another audit on repeated baseline seeding', async () => {
    let calls = 0;
    const { client, statements } = recordingClient((sql) => {
      if (sql.includes('platform_append_audit')) return { rows: [{ event_id: 'audit-1' }] };
      if (sql.includes('WITH seeded_settings AS')) {
        calls += 1;
        return { rows: [{ seeded: calls === 1 ? 5 : 0 }] };
      }
      throw new Error(`Unexpected baseline statement: ${sql}`);
    });
    const repository = new SkillCatalogRepository({ tenantTransaction: (_tenant, work) => work(client) });

    await expect(repository.seedDefaultSettings(TENANT, ACTOR)).resolves.toBe(5);
    await expect(repository.seedDefaultSettings(TENANT, ACTOR)).resolves.toBe(0);
    const inserts = statements.filter((statement) => statement.sql.includes('WITH seeded_settings AS'));
    expect(inserts).toHaveLength(2);
    for (const insert of inserts) {
      // Assignment defaults belong only to settings inserted by this call. An existing company's
      // disabled setting or even an intentionally empty assignment set must never be revived.
      expect(insert.sql).toContain('RETURNING skill_id');
      expect(insert.sql).toContain('FROM seeded_settings AS s');
      expect(insert.sql).toContain('JOIN agentos.skill_catalog AS c ON c.skill_id = s.skill_id');
      expect(insert.sql).not.toContain('DO UPDATE');
      expect(insert.sql).not.toContain('DELETE FROM');
    }
    expect(statements.filter((statement) => statement.sql.includes('platform_append_audit'))).toHaveLength(1);
  });

  it('inserts demo skill settings only when absent, preserving disabled operator settings on rerun', async () => {
    const setting = { exists: false, enabled: false };
    const { client, statements } = recordingClient((sql) => {
      if (sql.includes('platform_append_audit')) return { rows: [{ event_id: 'audit-1' }] };
      if (sql.includes('INSERT INTO agentos.tenant_skill_settings')) {
        if (!setting.exists) {
          setting.exists = true;
          setting.enabled = true;
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('DO UPDATE')) setting.enabled = true;
        return { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    });
    const repository = new SkillCatalogRepository({ tenantTransaction: (_tenant, work) => work(client) });

    await expect(repository.seedDemoSettings(TENANT, ACTOR)).resolves.toBe(1);
    // The existing row now represents an operator-disabled setting. The second insert conflicts
    // and does not change it or emit an audit event.
    setting.enabled = false;
    await expect(repository.seedDemoSettings(TENANT, ACTOR)).resolves.toBe(0);
    expect(setting.enabled).toBe(false);

    const inserts = statements.filter((statement) =>
      statement.sql.includes('INSERT INTO agentos.tenant_skill_settings'),
    );
    expect(inserts).toHaveLength(2);
    for (const insert of inserts) {
      expect(insert.sql).toContain('ON CONFLICT (tenant_id, skill_id) DO NOTHING');
      expect(insert.sql).not.toContain('DO UPDATE');
      expect(insert.sql).toContain('SELECT $1, c.skill_id, true');
    }
    const auditStatements = statements.filter((statement) => statement.sql.includes('platform_append_audit'));
    expect(auditStatements).toHaveLength(1);
  });


  it('records a test outcome against the tenant and skill', async () => {
    const { client, statements } = recordingClient((sql) => {
      if (sql.includes('INSERT INTO agentos.skill_test_results')) {
        return {
          rows: [{
            test_id: '22222222-2222-4222-8222-222222222222',
            tenant_id: TENANT,
            skill_id: 'skill.sales.check_price',
            mode: 'CONNECTOR_DRY_RUN',
            outcome: 'PASS',
            latency_ms: 12,
            detail: { checked: 'schema' },
            tested_by: ACTOR.actor_id,
            tested_at: new Date(0),
          }],
        };
      }
      return { rows: [] };
    });
    const repository = new SkillCatalogRepository({ tenantTransaction: (_tenant, work) => work(client) });

    const record = await repository.recordTestResult({
      tenant_id: TENANT,
      skill_id: 'skill.sales.check_price',
      mode: 'CONNECTOR_DRY_RUN',
      outcome: 'PASS',
      latency_ms: 12,
      detail: { checked: 'schema' },
      tested_by: ACTOR.actor_id,
    });

    expect(record).toMatchObject({ skill_id: 'skill.sales.check_price', outcome: 'PASS' });
    const insert = statements.find((statement) => statement.sql.includes('INSERT INTO agentos.skill_test_results'));
    expect(insert?.values).toEqual([
      TENANT,
      'skill.sales.check_price',
      'CONNECTOR_DRY_RUN',
      'PASS',
      12,
      JSON.stringify({ checked: 'schema' }),
      ACTOR.actor_id,
    ]);
  });
});

describe('syncSkillCatalogAtBoot', () => {
  it('composes a repository over the injected runners', async () => {
    const { client } = recordingClient(() => ({ rows: [] }));
    const result = await syncSkillCatalogAtBoot([manifestRow()], {
      platformTransaction: (work) => work(client),
    });
    expect(result.inserted).toBe(1);
  });
});
