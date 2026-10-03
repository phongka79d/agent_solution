import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../migrations/0067_provisioning_baseline_authority.sql', import.meta.url), 'utf8');
const idempotencyMigration = readFileSync(new URL('../../migrations/0065_provisioning_event_idempotency.sql', import.meta.url), 'utf8');

describe('provisioning baseline authority migration guards', () => {
  it('derives the minimum covering clearance from canonical non-external contracts, never AUTH-4', () => {
    expect(migration).toContain('CREATE OR REPLACE FUNCTION agentos.baseline_authority_for_agent(p_agent TEXT)');
    expect(migration).toContain('MAX(RIGHT(contract.required_authority, 1)::integer)');
    expect(migration).toContain('COALESCE(MAX(RIGHT(contract.required_authority, 1)::integer), 0)');
    expect(migration).toContain('FROM agentos.skill_catalog AS contract');
    expect(migration).toContain('WHERE NOT contract.retired');
    expect(migration).toContain('p_agent = ANY(contract.allowed_agents)');
    expect(migration).toContain("contract.effect_class IN ('READ', 'INTERNAL')");
    expect(migration).toContain("contract.required_authority IN ('AUTH-0', 'AUTH-1', 'AUTH-2', 'AUTH-3')");
    expect(migration).toContain('FROM PUBLIC, agentos_app, agentos_platform');
  });

  it('only seeds new agent rows and preserves grants and provisioning event idempotency on replay', () => {
    expect(migration).toContain('agentos.baseline_authority_for_agent(v_agent_code), FALSE)');
    expect(migration).toContain('ON CONFLICT (tenant_id, code) DO NOTHING');
    expect(migration).not.toMatch(/UPDATE\s+agentos\.agents/i);
    expect(migration).toContain('WHERE NOT EXISTS (');
    expect(migration).toContain("event.event_type = 'TENANT_PROVISIONED'");
  });

  it('preserves the complete 0065 shell implementation except for the new-agent authority expression', () => {
    const shellDefinition = 'CREATE OR REPLACE FUNCTION agentos.provision_tenant_shell_impl(';
    const expectedShell = idempotencyMigration.slice(idempotencyMigration.indexOf(shellDefinition))
      .replace("'AUTH-0', FALSE)", 'agentos.baseline_authority_for_agent(v_agent_code), FALSE)');
    expect(migration.slice(migration.indexOf(shellDefinition)).trim()).toBe(expectedShell.trim());
  });
});
