import { describe, expect, it, vi } from 'vitest';
import type {
  AgentActivationRepository,
  ConnectorBindingRepository,
  P5ProvisioningRepository,
  SkillCatalogRepository,
} from '@agentos/database';

import { createWorkerSkillGate } from './skill-availability.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

function workerGate(input: {
  readonly assignments?: readonly string[];
  readonly allowed_agents?: readonly string[];
  readonly active_agents?: readonly string[];
  readonly connector_kinds?: readonly string[];
  readonly api001BoundForTenant?: (tenant_id: string) => Promise<boolean>;
  readonly owner_inputs?: readonly { readonly input_id: string; readonly status: 'UNRESOLVED' | 'RESOLVED' }[];
}) {
  const catalog = {
    getSettings: vi.fn(async () => ({ enabled: true, connector_id: null, version: '1' })),
    getCatalogEntry: vi.fn(async () => ({
      retired: false,
      connector_kinds: input.connector_kinds ?? [],
      contract_version: '1',
      allowed_agents: input.allowed_agents ?? ['CS-01'],
    })),
    listAgentAssignments: vi.fn(async () => input.assignments ?? []),
  } as unknown as SkillCatalogRepository;
  const agents = {
    getState: vi.fn(async () => ({
      agents: (input.active_agents ?? ['CS-01']).map((code) => ({ code, is_active: true })),
    })),
  } as unknown as AgentActivationRepository;
  const provisioning = {
    listOwnerInputs: vi.fn(async () => input.owner_inputs ?? []),
  } as unknown as P5ProvisioningRepository;
  const connectors = {} as ConnectorBindingRepository;

  return {
    ...createWorkerSkillGate({
      dependencyFor: () => (input.connector_kinds ?? []).length > 0 ? 'API-001.PricingEngine' : null,
      ...(input.api001BoundForTenant === undefined
        ? {}
        : { api001BoundForTenant: input.api001BoundForTenant }),
      repositories: { catalog, agents, provisioning, connectors },
    }),
    catalog,
    agents,
    provisioning,
  };
}

describe('createWorkerSkillGate assignments and runtime connector availability', () => {
  it('uses contract allowed_agents by default while explicit assignments narrow that set', async () => {
    const defaults = workerGate({ allowed_agents: ['CS-01', 'CS-02'] });
    expect((await defaults.gate.available(TENANT, 'skill.care.search_faq')).reason).toBe('OK');
    expect(defaults.catalog.getCatalogEntry).toHaveBeenCalledWith('skill.care.search_faq');

    const narrowed = workerGate({ assignments: ['CS-02'], allowed_agents: ['CS-01', 'CS-02'], active_agents: ['CS-01'] });
    expect((await narrowed.gate.available(TENANT, 'skill.care.search_faq')).reason).toBe('AGENT_INACTIVE');

    const outsideContract = workerGate({ assignments: ['CS-02'], allowed_agents: ['CS-01'], active_agents: ['CS-02'] });
    expect((await outsideContract.gate.available(TENANT, 'skill.care.search_faq')).reason).toBe('NO_ASSIGNED_AGENT');
  });
  it('uses the tenant-scoped API-001 runtime fallback only when its ERP port is bound', async () => {
    const bound = workerGate({
      connector_kinds: ['ERP'],
      api001BoundForTenant: async (tenant_id) => tenant_id === TENANT,
    });
    expect((await bound.gate.available(TENANT, 'skill.sales.check_price')).reason).toBe('OK');

    const unbound = workerGate({
      connector_kinds: ['ERP'],
      api001BoundForTenant: async () => false,
    });
    expect((await unbound.gate.available(TENANT, 'skill.sales.check_price')).reason).toBe('CONNECTOR_UNBOUND');
  });

});
