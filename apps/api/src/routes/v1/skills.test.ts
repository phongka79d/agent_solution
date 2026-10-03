import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { ISkillContract } from '@agentos/skills';
import type { AutonomyPolicyRecord, ConnectorBindingRecord, SkillCatalogRecord, SkillTestResultRecord, TenantAutonomyControlRecord } from '@agentos/database';
import { ConnectorBindingRepository, SkillCatalogRefusal, SkillCatalogRepository } from '@agentos/database';

import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { createCredentialStore } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import type { SkillReadDispatcher } from '../../runtime/skills-port.js';
import { createSkillsPort } from '../../runtime/skills-port.js';
import type { CompanySkillView, SkillAvailabilityReason, SkillsPort } from './skills.js';
import { registerSkillRoutes } from './skills.js';
import { registerPlatformSkillsRoutes } from './platform-skills.js';

const TENANT = 'tenant-skills';
const TOKEN = 'skills-admin';

function catalogEntry(overrides: Partial<SkillCatalogRecord> = {}): SkillCatalogRecord {
  return {
    skill_id: 'skill.sales.check_price',
    display_key: 'skill.sales.check_price.label',
    domain: 'sales',
    effect_class: 'READ',
    required_authority: 'AUTH-0',
    autonomy_class: 'PROMOTABLE',
    completion: 'SYNC',
    receipt_ref: 'receipt.price',
    tool_binding: 'API-001.PricingEngine',
    allowed_agents: ['SAL-01', 'SAL-02'],
    connector_kinds: [],
    config_schema: { type: 'object', properties: { currency: { type: 'string' } }, required: ['currency'] },
    retired: false,
    contract_version: '1',
    contract_digest: 'a'.repeat(64),
    registered_at: new Date('2026-10-01T00:00:00Z'),
    updated_at: new Date('2026-10-01T00:00:00Z'),
    ...overrides,
  };
}

function contractOf(id: string, effect: 'READ' | 'EFFECT' = 'READ'): ISkillContract {
  return {
    skill_id: id,
    effect_class: effect,
    validateInput: (input: unknown) => input,
  } as unknown as ISkillContract;
}

function testRecord(overrides: Partial<SkillTestResultRecord> = {}): SkillTestResultRecord {
  return {
    test_id: 'test-1',
    tenant_id: TENANT,
    skill_id: 'skill.sales.check_price',
    mode: 'CONNECTOR_DRY_RUN',
    outcome: 'PASS',
    latency_ms: null,
    detail: {},
    tested_by: 'operator-1',
    tested_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

interface StoreOverrides {
  readonly recordTest?: (input: Parameters<SkillCatalogRepository['recordTestResult']>[0]) => Promise<SkillTestResultRecord>;
}

function fakeStore(entry: SkillCatalogRecord | null, dataClass: 'PRODUCTION' | 'DEMO' | 'TEST', overrides: StoreOverrides = {}) {
  const recordTest = vi.fn(overrides.recordTest ?? (async (input) => testRecord({
    mode: input.mode,
    outcome: input.outcome,
    latency_ms: input.latency_ms,
    detail: { ...input.detail },
  })));
  const store = {
    getCatalogEntry: async () => entry,
    listCatalog: async () => (entry === null ? [] : [entry]),
    getSettings: async () => null,
    listSettings: async () => [],
    listAgentAssignments: async () => ['SAL-01'],
    upsertSettings: async () => { throw new Error('unexpected upsert'); },
    replaceAgentAssignments: async () => { throw new Error('unexpected replace'); },
    recordTestResult: recordTest,
    listTestResults: async () => [],
    skillHealth: async () => ({ window_start: '2026-10-01T00:00:00.000Z', success_count: 0, failure_count: 0, refusal_count: 0, awaiting_human_count: 0, success_rate: null, avg_latency_ms: null, p95_latency_ms: null, last_activity_at: null, last_error_class: null }),
    tenantDataClass: async () => dataClass,
  };
  return { store: store as unknown as SkillCatalogRepository, recordTest };
}

describe('createSkillsPort.test', () => {
  it('never dispatches an EFFECT skill; it performs a schema dry-run and stores the result', async () => {
    const dispatch = vi.fn(async () => ({ outcome: 'PASS' as const, latency_ms: 1, detail: {} }));
    const { store, recordTest } = fakeStore(catalogEntry({ effect_class: 'EFFECT' }), 'DEMO');
    const port = createSkillsPort({
      skills: store,
      contractOf: (id) => contractOf(id, 'EFFECT'),
      readDispatcher: { dispatch } satisfies SkillReadDispatcher,
    });
    const result = await port.test({
      tenant_id: TENANT,
      skill_id: 'skill.sales.create_order',
      input: { order_id: 'o-1' },
      actor: { actor_kind: 'OPERATOR', actor_id: 'operator-1', correlation_id: 'corr' },
    });
    expect(dispatch).not.toHaveBeenCalled();
    expect(result.mode).toBe('CONNECTOR_DRY_RUN');
    expect(result.outcome).toBe('PASS');
    expect(result.detail['reason']).toBe('SCHEMA_DRY_RUN_ONLY');
    expect(recordTest).toHaveBeenCalledTimes(1);
  });

  it('dispatches a READ skill only for a DEMO/TEST tenant', async () => {
    const dispatch = vi.fn(async () => ({ outcome: 'PASS' as const, latency_ms: 5, detail: { price: 100 } }));
    const demo = fakeStore(catalogEntry(), 'DEMO');
    const demoPort = createSkillsPort({
      skills: demo.store,
      contractOf: (id) => contractOf(id),
      readDispatcher: { dispatch } satisfies SkillReadDispatcher,
    });
    const passed = await demoPort.test({
      tenant_id: TENANT,
      skill_id: 'skill.sales.check_price',
      input: { sku: 's-1' },
      actor: { actor_kind: 'OPERATOR', actor_id: 'operator-1', correlation_id: 'corr' },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(passed.mode).toBe('READ_DISPATCH');
    expect(passed.outcome).toBe('PASS');

    const prod = fakeStore(catalogEntry(), 'PRODUCTION');
    const prodPort = createSkillsPort({
      skills: prod.store,
      contractOf: (id) => contractOf(id),
      readDispatcher: { dispatch } satisfies SkillReadDispatcher,
    });
    const refused = await prodPort.test({
      tenant_id: TENANT,
      skill_id: 'skill.sales.check_price',
      input: { sku: 's-1' },
      actor: { actor_kind: 'OPERATOR', actor_id: 'operator-1', correlation_id: 'corr' },
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(refused.outcome).toBe('REFUSED');
    expect(refused.detail['reason']).toBe('TEST_REQUIRES_DEMO_OR_TEST_DATA_CLASS');
  });

  it('rejects config keys the contract does not declare', async () => {
    const { store } = fakeStore(catalogEntry(), 'DEMO');
    const port = createSkillsPort({ skills: store, contractOf: (id) => contractOf(id) });
    await expect(port.updateSettings({
      tenant_id: TENANT,
      skill_id: 'skill.sales.check_price',
      enabled: true,
      config: { currency: 'VND', unknown_key: true },
      connector_id: null,
      expected_version: null,
      actor: { actor_kind: 'OPERATOR', actor_id: 'operator-1', correlation_id: 'corr' },
    })).rejects.toMatchObject({ failure: { error_code: 'VALIDATION_FAILED' } });
  });
});

describe('company skill DEMO connector availability', () => {
  it('inherits only a pristine eligible company connector, not a disconnect or explicit skill binding', async () => {
    const entry = catalogEntry({ connector_kinds: ['ERP'] });
    const settings = {
      tenant_id: TENANT, skill_id: entry.skill_id, enabled: true, config: { currency: 'VND' },
      connector_id: null, version: '1', updated_by: 'operator-1', updated_at: '2026-10-01T00:00:00Z',
      allowed_agents: entry.allowed_agents, effect_class: entry.effect_class,
    };
    const store = new SkillCatalogRepository();
    vi.spyOn(store, 'getCatalogEntry').mockResolvedValue(entry);
    vi.spyOn(store, 'listCatalog').mockResolvedValue([entry]);
    const settingsRead = vi.spyOn(store, 'getSettings').mockResolvedValue(settings);
    vi.spyOn(store, 'listSettings').mockResolvedValue([settings]);
    vi.spyOn(store, 'listAgentAssignments').mockResolvedValue(['SAL-01']);
    const pristine: ConnectorBindingRecord = {
      tenant_id: TENANT, connector_id: 'API-001', status: 'UNBOUND', mode: 'MOCK',
      config: {}, secret_id: null, bound_at: null, probe_outcome: null,
      probe_latency_ms: null, probe_http_status: null, probe_error_class: null,
      probed_at: null, version: 1,
    };
    const connectorRead = vi.fn<[string, string], Promise<ConnectorBindingRecord | null>>().mockResolvedValue(pristine);
    let eligible = true;
    const port = createSkillsPort({
      skills: store,
      contractOf: () => null,
      connectors: { get: connectorRead },
      demoErpEligibleForTenant: async () => eligible,
      autonomy: { list: async () => [], getControls: async () => null },
      agents: {
        getState: async (_tenant, domain) => ({
          tenant_id: TENANT, domain, data_class: 'DEMO', capability_status: 'ENABLED',
          agents: [{ code: 'SAL-01', domain, is_active: true, activation_status: 'ACTIVE' }],
          erp_bound: false, llm_verified: false,
        }),
      },
    });
    expect((await port.get(TENANT, entry.skill_id))?.availability.reason).toBe('OK');
    expect((await port.list(TENANT))[0]?.availability.reason).toBe('OK');
    connectorRead.mockResolvedValue(null);
    expect((await port.get(TENANT, entry.skill_id))?.availability.reason).toBe('OK');
    connectorRead.mockResolvedValue(pristine);
    eligible = false;
    expect((await port.get(TENANT, entry.skill_id))?.availability.reason).toBe('CONNECTOR_UNBOUND');
    eligible = true;
    connectorRead.mockResolvedValue({ ...pristine, version: 2 });
    expect((await port.get(TENANT, entry.skill_id))?.availability.reason).toBe('CONNECTOR_UNBOUND');
    expect((await port.list(TENANT))[0]?.availability.reason).toBe('CONNECTOR_UNBOUND');
    connectorRead.mockResolvedValue({ ...pristine, status: 'DEGRADED', probe_outcome: 'FAIL' });
    expect((await port.get(TENANT, entry.skill_id))?.availability.reason).toBe('CONNECTOR_UNHEALTHY');
    connectorRead.mockResolvedValue(pristine);
    settingsRead.mockResolvedValue({ ...settings, connector_id: 'API-001' });
    expect((await port.get(TENANT, entry.skill_id))?.availability.reason).toBe('CONNECTOR_UNBOUND');
  });
});

describe('company skill autonomy availability', () => {
  it.each(['skill.mkt.generate_content', 'skill.mkt.segment_audience'])('T4.5 admits baseline ERP reads, parks %s until promotion, and reflects tenant pause on list and detail', async (skillId) => {
    const read = catalogEntry({ connector_kinds: ['ERP'] });
    const draft = catalogEntry({
      skill_id: skillId,
      domain: 'marketing',
      effect_class: 'EFFECT',
      required_authority: 'AUTH-2',
      allowed_agents: ['MKT-01'],
    });
    const entries = [read, draft];
    const settings = entries.map((entry) => ({
      tenant_id: TENANT,
      skill_id: entry.skill_id,
      enabled: true,
      config: { currency: 'VND' },
      connector_id: null,
      version: '1',
      updated_by: 'operator-1',
      updated_at: '2026-10-01T00:00:00Z',
      allowed_agents: entry.allowed_agents,
      effect_class: entry.effect_class,
    }));
    const store = new SkillCatalogRepository();
    const connectors = new ConnectorBindingRepository();
    const binding: ConnectorBindingRecord = {
      tenant_id: TENANT, connector_id: 'API-001', status: 'BOUND', mode: 'MOCK',
      config: {}, secret_id: null, bound_at: '2026-10-01T00:00:00Z',
      probe_outcome: 'PASS', probe_latency_ms: 1, probe_http_status: 200,
      probe_error_class: null, probed_at: '2026-10-01T00:00:00Z', version: 1,
    };
    const connectorRead = vi.spyOn(connectors, 'get').mockResolvedValue(binding);
    vi.spyOn(store, 'getCatalogEntry').mockImplementation(async (id) => entries.find((entry) => entry.skill_id === id) ?? null);
    vi.spyOn(store, 'listCatalog').mockResolvedValue(entries);
    vi.spyOn(store, 'getSettings').mockImplementation(async (_tenant, id) => settings.find((entry) => entry.skill_id === id) ?? null);
    vi.spyOn(store, 'listSettings').mockResolvedValue(settings);
    vi.spyOn(store, 'listAgentAssignments').mockImplementation(async (_tenant, id) =>
      entries.find((entry) => entry.skill_id === id)?.allowed_agents ?? []);
    let policies: AutonomyPolicyRecord[] = [];
    let controls: TenantAutonomyControlRecord | null = null;
    const port = createSkillsPort({
      skills: store,
      contractOf: () => null,
      connectors,
      autonomy: {
        list: async (_tenant, skillId) => policies.filter((policy) => skillId === undefined || policy.skill_id === skillId),
        getControls: async () => controls,
      },
      agents: {
        getState: async (_tenant, domain) => ({
          tenant_id: TENANT,
          domain,
          data_class: 'TEST',
          capability_status: 'ENABLED',
          agents: (domain === 'sales' ? read : draft).allowed_agents.map((code) => ({
            code, domain, is_active: true, activation_status: 'ACTIVE',
          })),
          erp_bound: true,
          llm_verified: true,
        }),
      },
    });
    expect((await port.get(TENANT, read.skill_id))?.availability).toEqual({
      available: true, status: 'READY', reason: 'OK',
    });
    expect(connectorRead).toHaveBeenCalledWith(TENANT, 'API-001');
    expect((await port.list(TENANT)).find((entry) => entry.skill_id === draft.skill_id)?.availability).toEqual({
      available: false, status: 'NOT_READY', reason: 'PARKED_UNTIL_PROMOTED',
    });
    policies = [{
      tenant_id: TENANT,
      skill_id: draft.skill_id,
      policy_version: 'MINIMUM',
      policy_id: 'draft-policy',
      state: 'PROMOTED',
      previous_approved_state: 'MINIMUM',
      evidence_window_ref: 'window-1',
      approver_id: 'operator-2',
      reason: 'Approved draft capability',
      parameters: {},
      provenance: { source: 'SERVER_POLICY' },
      effective_at: '2026-10-01T01:00:00Z',
      rollback_policy_version: 'MINIMUM',
      rollback_state: 'MINIMUM',
      audit_ref: null,
      evidence_ref: null,
      policy_revision: 1,
    }];
    expect((await port.get(TENANT, draft.skill_id))?.availability).toEqual({
      available: true, status: 'READY', reason: 'OK',
    });
    controls = {
      tenant_id: TENANT, paused: true, kill_switch: false,
      actor: 'operator-2', reason: 'Pause', effective_at: '2026-10-01T02:00:00Z',
    };
    expect((await port.list(TENANT)).map((entry) => entry.availability)).toEqual([
      { available: false, status: 'NOT_READY', reason: 'AUTONOMY_PAUSED' },
      { available: false, status: 'NOT_READY', reason: 'AUTONOMY_PAUSED' },
    ]);
    controls = { ...controls, paused: false, kill_switch: true };
    expect((await port.get(TENANT, read.skill_id))?.availability.reason).toBe('AUTONOMY_PAUSED');
    controls = null;
    const promoted = policies[0];
    if (promoted === undefined) throw new Error('missing promoted policy fixture');
    policies = [{ ...promoted, state: 'DEMOTED' }];
    expect((await port.get(TENANT, draft.skill_id))?.availability.reason).toBe('PARKED_UNTIL_PROMOTED');
    expect((await port.get(TENANT, read.skill_id))?.availability.reason).toBe('OK');
    policies = [{ ...promoted, state: 'PAUSED' }];
    expect((await port.get(TENANT, draft.skill_id))?.availability.reason).toBe('AUTONOMY_PAUSED');
    // Offsets are chronological, not lexicographic; only the newest policy governs admission.
    policies = [promoted, { ...promoted, policy_version: 'older', state: 'DEMOTED', effective_at: '2026-10-01T02:00:00+02:00' }];
    expect((await port.get(TENANT, draft.skill_id))?.availability.reason).toBe('OK');
    policies = [promoted, { ...promoted, policy_version: 'tied', effective_at: '2026-10-01T03:00:00+02:00' }];
    expect((await port.get(TENANT, draft.skill_id))?.availability.reason).toBe('PARKED_UNTIL_PROMOTED');
    connectorRead.mockResolvedValue({ ...binding, status: 'UNBOUND' });
    expect((await port.get(TENANT, read.skill_id))?.availability.reason).toBe('CONNECTOR_UNBOUND');
    connectorRead.mockResolvedValue({ ...binding, status: 'DEGRADED' });
    expect((await port.get(TENANT, read.skill_id))?.availability.reason).toBe('CONNECTOR_UNHEALTHY');
  });

  it('T4.5 fails closed when autonomy cannot be read', async () => {
    const entry = catalogEntry();
    const store = new SkillCatalogRepository();
    vi.spyOn(store, 'getCatalogEntry').mockResolvedValue(entry);
    vi.spyOn(store, 'getSettings').mockResolvedValue({
      tenant_id: TENANT, skill_id: entry.skill_id, enabled: true, config: { currency: 'VND' },
      connector_id: null, version: '1', updated_by: 'operator-1', updated_at: '2026-10-01T00:00:00Z',
    });
    vi.spyOn(store, 'listAgentAssignments').mockResolvedValue(['SAL-01']);
    const port = createSkillsPort({
      skills: store,
      contractOf: () => null,
      autonomy: {
        list: async () => { throw new Error('autonomy unavailable'); },
        getControls: async () => null,
      },
      agents: {
        getState: async (_tenant, domain) => ({
          tenant_id: TENANT, domain, data_class: 'TEST', capability_status: 'ENABLED',
          agents: [{ code: 'SAL-01', domain, is_active: true, activation_status: 'ACTIVE' }],
          erp_bound: true, llm_verified: true,
        }),
      },
    });
    expect((await port.get(TENANT, entry.skill_id))?.availability).toEqual({
      available: false, status: 'NOT_READY', reason: 'AUTONOMY_PAUSED',
    });
  });
});

function fakeView(overrides: Partial<CompanySkillView> = {}): CompanySkillView {
  return {
    skill_id: 'skill.sales.check_price',
    display_key: 'skill.sales.check_price.label',
    domain: 'sales',
    effect_class: 'READ',
    required_authority: 'AUTH-0',
    autonomy_class: 'PROMOTABLE',
    completion: 'SYNC',
    connector_kinds: [],
    config_schema: {},
    allowed_agents: ['SAL-01'],
    enabled: true,
    config: {},
    connector_id: null,
    version: '1',
    assigned_agents: ['SAL-01'],
    availability: { available: true, status: 'READY', reason: 'OK' },
    ...overrides,
  };
}

function harness(port: Partial<SkillsPort>) {
  const runtime = { clock: () => new Date('2026-10-01T00:00:00Z'), ids: () => 'corr', audit: { record: async () => undefined } } as unknown as GatewayRuntime;
  const credentials = createCredentialStore({
    operators: [{ token: TOKEN, tenant_id: TENANT, operator_id: 'operator-1', permissions: ['telemetry:read', 'skills:manage'] }],
    sessions: [],
    widgets: [],
  });
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  const full = {
    list: async () => [fakeView()],
    get: async () => fakeView(),
    updateSettings: async () => fakeView(),
    replaceAgents: async () => ['SAL-01'],
    test: async () => ({ test_id: 't', skill_id: 's', mode: 'CONNECTOR_DRY_RUN', outcome: 'PASS', latency_ms: null, detail: {}, tested_by: 'o', tested_at: '2026-10-01T00:00:00.000Z' }),
    health: async () => ({ window_start: '2026-10-01T00:00:00.000Z', success_count: 0, failure_count: 0, refusal_count: 0, awaiting_human_count: 0, success_rate: null, avg_latency_ms: null, p95_latency_ms: null, last_activity_at: null, last_error_class: null }),
    testHistory: async () => [],
    dataClass: async () => 'DEMO',
    ...port,
  } as SkillsPort;
  registerSkillRoutes(app, { skills: full, credentials, runtime });
  return app;
}

describe('skills routes', () => {
  const auth = { authorization: `Bearer ${TOKEN}` };

  it('lists skills with effective status and reason', async () => {
    const app = harness({});
    const response = await app.inject({ method: 'GET', url: '/skills', headers: auth });
    expect(response.statusCode).toBe(200);
    expect(response.json().skills[0].availability).toEqual({ available: true, status: 'READY', reason: 'OK' });
  });

  const autonomyReasons: readonly SkillAvailabilityReason[] = ['PARKED_UNTIL_PROMOTED', 'AUTONOMY_PAUSED'];
  it.each(autonomyReasons)('T4.5 exposes unavailable autonomy state %s on list and detail', async (reason) => {
    const unavailable = fakeView({
      skill_id: 'skill.mkt.generate_content',
      domain: 'marketing',
      availability: { available: false, status: 'NOT_READY', reason },
    });
    const app = harness({ list: async () => [unavailable], get: async () => unavailable });
    try {
      const list = await app.inject({ method: 'GET', url: '/skills', headers: auth });
      const detail = await app.inject({ method: 'GET', url: `/skills/${unavailable.skill_id}`, headers: auth });
      expect(list.statusCode).toBe(200);
      expect(detail.statusCode).toBe(200);
      expect(list.json().skills[0].availability).toEqual(unavailable.availability);
      expect(detail.json().skill.availability).toEqual(unavailable.availability);
    } finally {
      await app.close();
    }
  });

  it('refuses a settings body that tries to change the effect class', async () => {
    const app = harness({});
    const response = await app.inject({
      method: 'PATCH',
      url: '/skills/skill.sales.check_price/settings',
      headers: auth,
      payload: { enabled: true, config: {}, effect_class: 'EFFECT' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error_code).toBe('VALIDATION_FAILED');
  });

  it('maps a contract version refusal to a gateway conflict before the route sees it', async () => {
    const { store } = fakeStore(catalogEntry(), 'DEMO');
    (store as unknown as { upsertSettings: () => Promise<never> }).upsertSettings = async () => {
      throw new SkillCatalogRefusal('SKILL_SETTINGS_VERSION_CONFLICT', 'skill.sales.check_price', 'stale');
    };
    const port = createSkillsPort({ skills: store, contractOf: (id) => contractOf(id) });
    await expect(port.updateSettings({
      tenant_id: TENANT,
      skill_id: 'skill.sales.check_price',
      enabled: false,
      config: { currency: 'VND' },
      connector_id: null,
      expected_version: '9',
      actor: { actor_kind: 'OPERATOR', actor_id: 'operator-1', correlation_id: 'corr' },
    })).rejects.toMatchObject({ failure: { error_code: 'VERSION_CONFLICT' } });
  });

  it('requires the manage permission for writes', async () => {
    const app = Fastify({ logger: false });
    const runtime = { clock: () => new Date(), ids: () => 'c', audit: { record: async () => undefined } } as unknown as GatewayRuntime;
    const credentials = createCredentialStore({
      operators: [{ token: 'reader', tenant_id: TENANT, operator_id: 'op', permissions: ['telemetry:read'] }],
      sessions: [],
      widgets: [],
    });
    app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
    registerSkillRoutes(app, { skills: {} as SkillsPort, credentials, runtime });
    const response = await app.inject({
      method: 'PUT',
      url: '/skills/skill.sales.check_price/agents',
      headers: { authorization: 'Bearer reader' },
      payload: { agents: ['SAL-01'] },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe('platform skill catalog route', () => {
  it('requires the platform scope', async () => {
    const runtime = { clock: () => new Date(), ids: () => 'c', audit: { record: async () => undefined } } as unknown as GatewayRuntime;
    const credentials = createCredentialStore({
      operators: [{ token: 'company-op', tenant_id: TENANT, operator_id: 'op', permissions: ['platform:admin'] }],
      sessions: [],
      widgets: [],
    });
    const app = Fastify({ logger: false });
    app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
    registerPlatformSkillsRoutes(app, {
      platformSkills: {
        listCatalog: async () => [],
        fleetHealth: async () => [],
        setEntitlement: async () => ({ tenant_id: 't', skill_id: 's', enabled: true, version: '1' }),
      },
      credentials,
      runtime,
    });
    const response = await app.inject({ method: 'GET', url: '/platform/skill-catalog', headers: { authorization: 'Bearer company-op' } });
    expect(response.statusCode).toBe(403);
  });

  it('returns fleet health metrics joined to the catalog without tenant identifiers', async () => {
    const runtime = { clock: () => new Date(), ids: () => 'c', audit: { record: async () => undefined } } as unknown as GatewayRuntime;
    const credentials = createCredentialStore({
      operators: [{
        token: 'platform-op',
        tenant_id: TENANT,
        operator_id: 'op',
        scope: 'platform',
        permissions: ['platform:admin'],
      }],
      sessions: [],
      widgets: [],
    });
    const app = Fastify({ logger: false });
    app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
    registerPlatformSkillsRoutes(app, {
      platformSkills: {
        listCatalog: async () => [catalogEntry()],
        fleetHealth: async () => [{
          skill_id: 'skill.sales.check_price',
          runs_24h: 13,
          success_rate_24h: 92.3,
          p95_ms_24h: 550,
        }],
        setEntitlement: async () => ({ tenant_id: 't', skill_id: 's', enabled: true, version: '1' }),
      },
      credentials,
      runtime,
    });
    const response = await app.inject({
      method: 'GET',
      url: '/platform/skill-catalog',
      headers: { authorization: 'Bearer platform-op' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      catalog: [{
        skill_id: 'skill.sales.check_price',
        runs_24h: 13,
        success_rate_24h: 92.3,
        p95_ms_24h: 550,
      }],
    });
    expect(response.body).not.toContain(TENANT);
  });
});
