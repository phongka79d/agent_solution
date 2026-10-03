import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { CompanyActivityPageOptions, CompanyProjectionSources } from '@agentos/database';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerCompanyRoutes } from './company.js';

const TENANT = 'tenant-company';
const OTHER_TOKEN = 'company-no-telemetry';
const READ_TOKEN = 'company-telemetry-read';
const RUN_TOKEN = 'company-run-read';

const sources: CompanyProjectionSources = {
  approvals: [{ id: 'approval-1', run_id: 'run-1', skill_name: 'skill.sales.offer', decision: 'PENDING', created_at: '2026-09-30T00:00:00.000Z', decided_at: null }],
  handoffs: [],
  connectors: [{ connector_id: 'SHOPIFY', status: 'UNBOUND' }],
  owner_inputs: [],
  reconciliations: [],
  parked_drafts: [],
  agents: [{ code: 'SAL-01', domain: 'sales', is_active: true }],
  runs_today: [{ run_id: 'run-1', domain: 'sales', state: 'completed', occurred_at: '2026-09-30T00:00:00.000Z' }],
  conversations_today: [{ conversation_id: 'conv-1', state: 'open', occurred_at: '2026-09-30T00:00:00.000Z' }],
  campaigns_today: [],
  activity: [{ kind: 'RUN_OUTCOME', run_id: 'run-1', domain: 'sales', state: 'completed', occurred_at: '2026-09-30T00:00:00.000Z' }],
};

function buildHarness() {
  const getSources = vi.fn(async (tenant_id: string, activityPage?: CompanyActivityPageOptions) => {
    expect(tenant_id).toBe(TENANT);
    if (activityPage !== undefined) expect(activityPage).toEqual({ limit: 1, cursor: 'next-page' });
    return sources;
  });
  const runtime = {
    audit: { record: vi.fn(async () => undefined) },
    ids: () => 'corr-company-test',
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerCompanyRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [
        { token: READ_TOKEN, tenant_id: TENANT, operator_id: 'operator-read', permissions: ['telemetry:read'] },
        { token: RUN_TOKEN, tenant_id: TENANT, operator_id: 'operator-run', permissions: ['run:read'] },
        { token: OTHER_TOKEN, tenant_id: TENANT, operator_id: 'operator-other', permissions: [] },
      ],
      sessions: [],
      widgets: [],
    }),
    projections: { getSources },
  });
  return { app, getSources };
}

describe('company projection routes', () => {
  it('requires telemetry:read and always binds source reads to principal tenant', async () => {
    const { app, getSources } = buildHarness();
    try {
      const allowed = await app.inject({ method: 'GET', url: '/company/attention', headers: { authorization: `Bearer ${READ_TOKEN}` } });
      const denied = await app.inject({ method: 'GET', url: '/company/attention', headers: { authorization: `Bearer ${OTHER_TOKEN}` } });
      expect(denied.statusCode).toBe(403);
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().items[0]).toMatchObject({ type: 'APPROVAL_PENDING', title_key: 'company.attention.approval_pending' });
      const removedIntegrations = await app.inject({ method: 'GET', url: '/company/integrations', headers: { authorization: `Bearer ${READ_TOKEN}` } });
      expect(removedIntegrations.statusCode).toBe(404);
      expect(getSources).toHaveBeenCalledWith(TENANT);
    } finally {
      await app.close();
    }
  });

  it('requires run:read and rejects a mismatched client tenant hint', async () => {
    const { app, getSources } = buildHarness();
    try {
      const allowed = await app.inject({ method: 'GET', url: '/company/activity?limit=1&cursor=next-page', headers: { authorization: `Bearer ${RUN_TOKEN}` } });
      const rejected = await app.inject({ method: 'GET', url: '/company/activity?limit=1&tenant_id=wrong', headers: { authorization: `Bearer ${RUN_TOKEN}` } });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json().items).toHaveLength(1);
      expect(rejected.statusCode).toBe(403);
      expect(getSources).toHaveBeenCalledWith(TENANT, { limit: 1, cursor: 'next-page' });
    } finally {
      await app.close();
    }
  });
});
