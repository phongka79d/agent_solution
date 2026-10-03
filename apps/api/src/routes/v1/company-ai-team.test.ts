import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AgentActivationAction, AgentActivationDomain, AgentActivationSnapshot, ConnectorBindingRecord } from '@agentos/database';

import type { GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerCompanyAiTeamRoutes } from './company-ai-team.js';

const TENANT = 'tenant-ai-team';
const TOKEN = 'company-agents-manage';

function initialState(overrides: Partial<AgentActivationSnapshot> = {}): AgentActivationSnapshot {
  return {
    tenant_id: TENANT,
    domain: 'sales',
    data_class: 'PRODUCTION',
    capability_status: 'UNCONFIGURED',
    agents: [{ code: 'SAL-01', domain: 'sales', is_active: false, activation_status: 'NOT_ACTIVATED' }],
    erp_bound: false,
    llm_verified: false,
    ...overrides,
  };
}

function buildHarness(start: AgentActivationSnapshot = initialState(), options: {
  readonly binding?: ConnectorBindingRecord | null;
  readonly demoErpEligible?: boolean;
} = {}) {
  let state = start;
  const transition = vi.fn(async (input: {
    readonly tenant_id: string;
    readonly domain: AgentActivationDomain;
    readonly action: AgentActivationAction;
    readonly actor: { readonly actor_kind: string; readonly actor_id: string; readonly correlation_id: string };
  }) => {
    const paused = input.action === 'PAUSE';
    state = {
      ...state,
      capability_status: paused ? 'DISABLED' : 'ENABLED',
      agents: state.agents.map((agent) => ({
        ...agent,
        is_active: !paused,
        activation_status: paused ? 'PAUSED' : 'ACTIVE',
      })),
    };
    return state;
  });
  const port = {
    getState: vi.fn(async (tenant_id: string, domain: AgentActivationDomain) =>
      tenant_id === TENANT && domain === state.domain ? state : null,
    ),
    transition,
  };
  const runtime = {
    companyAiTeam: port,
    companyIntegrations: {
      getBinding: async () => options.binding ?? null,
      demoErpEligibleForTenant: async () => options.demoErpEligible === true,
    },
    ids: () => 'corr-ai-team',
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerCompanyAiTeamRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [{ token: TOKEN, tenant_id: TENANT, operator_id: 'operator-1', permissions: ['telemetry:read', 'agents:manage'] }],
      sessions: [],
      widgets: [],
    }),
    knowledge: { listAvailable: async () => [] },
  });
  return { app, port, readState: () => state };
}

describe('company AI Team activation routes', () => {
  it('refuses Sales activation without a bound ERP or an eligible DEMO mock', async () => {
    const { app, port } = buildHarness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/company/ai-team/sales/activate',
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        error_code: 'PREREQUISITES_UNMET',
        details: { unmet: [{ reason_key: 'ERP_NOT_CONNECTED', cta: { href: '/integrations' } }] },
      });
      expect(port.transition).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each(['pristine', 'absent', 'disconnected', 'configured', 'degraded', 'disabled', 'ineligible'])(
    'uses the shared DEMO ERP eligibility rule for %s bindings on activation and projection',
    async (scenario) => {
      const pristine: ConnectorBindingRecord = {
        tenant_id: TENANT, connector_id: 'API-001', status: 'UNBOUND', mode: 'MOCK',
        config: {}, secret_id: null, bound_at: null, probe_outcome: null,
        probe_latency_ms: null, probe_http_status: null, probe_error_class: null,
        probed_at: null, version: 1,
      };
      const bindings: Record<string, ConnectorBindingRecord | null> = {
        pristine,
        absent: null,
        disconnected: { ...pristine, version: 2 },
        configured: { ...pristine, config: { base_url: 'https://erp.example' } },
        degraded: { ...pristine, status: 'DEGRADED', probe_outcome: 'FAIL' },
        disabled: { ...pristine, status: 'DISABLED' },
        ineligible: pristine,
      };
      const binding = bindings[scenario];
      if (binding === undefined) throw new Error('unknown ERP binding fixture');
      const ready = scenario === 'pristine' || scenario === 'absent';
      const { app, port } = buildHarness(initialState({ data_class: 'DEMO' }), {
        binding, demoErpEligible: scenario !== 'ineligible',
      });
      try {
        const headers = { authorization: `Bearer ${TOKEN}` };
        const detail = await app.inject({ method: 'GET', url: '/company/ai-team/sales', headers });
        expect(detail.statusCode).toBe(200);
        expect(detail.json().unmet).toHaveLength(ready ? 0 : 1);
        const activated = await app.inject({ method: 'POST', url: '/company/ai-team/sales/activate', headers });
        expect(activated.statusCode).toBe(ready ? 200 : 409);
        if (ready) {
          expect(port.transition).toHaveBeenCalledOnce();
        } else {
          expect(activated.json()).toMatchObject({
            error_code: 'PREREQUISITES_UNMET', details: { unmet: [{ reason_key: 'ERP_NOT_CONNECTED' }] },
          });
          expect(port.transition).not.toHaveBeenCalled();
        }
      } finally {
        await app.close();
      }
    },
  );

  it('activates a ready domain and pause/resume keep persisted projection state aligned', async () => {
    const { app, port, readState } = buildHarness(initialState({ erp_bound: true }));
    try {
      const headers = { authorization: `Bearer ${TOKEN}` };
      const activated = await app.inject({ method: 'POST', url: '/company/ai-team/sales/activate', headers });
      expect(activated.statusCode).toBe(200);
      expect(activated.json()).toMatchObject({
        activation_status: 'ACTIVE',
        agent: { domain: 'sales', status: 'ACTIVE', enabled: true },
      });
      expect(readState().capability_status).toBe('ENABLED');
      expect(readState().agents[0]?.is_active).toBe(true);

      const paused = await app.inject({ method: 'POST', url: '/company/ai-team/sales/pause', headers });
      expect(paused.statusCode).toBe(200);
      expect(paused.json()).toMatchObject({
        activation_status: 'PAUSED',
        agent: { domain: 'sales', status: 'PAUSED', enabled: false },
      });

      const resumed = await app.inject({ method: 'POST', url: '/company/ai-team/sales/resume', headers });
      expect(resumed.statusCode).toBe(200);
      expect(resumed.json()).toMatchObject({
        activation_status: 'ACTIVE',
        agent: { domain: 'sales', status: 'ACTIVE', enabled: true },
      });
      expect(readState().capability_status).toBe('ENABLED');
      expect(port.transition.mock.calls.map(([input]) => input.action)).toEqual(['ACTIVATE', 'PAUSE', 'RESUME']);
    } finally {
      await app.close();
    }
  });
});
