import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import type {
  GatewayRuntime,
  PlatformCompanyCommandsPort,
  PlatformDirectoryPort,
} from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerPlatformCompaniesRoutes } from './platform-companies.js';

const TOKEN = 'platform-companies-token';
const COMPANY_B = '11111111-2222-3333-4444-555555555555';

function buildHarness() {
  const auditRecord = vi.fn(async () => undefined);
  const runtime = {
    ids: () => 'corr-platform-companies',
    audit: { record: auditRecord },
    clock: () => new Date(),
  } as unknown as GatewayRuntime;
  const platform = {
    listTenants: vi.fn(async () => [{
      tenant_id: COMPANY_B,
      display_name: 'Company B',
      status: 'ACTIVE',
      created_at: '2026-01-01T00:00:00.000Z',
      enabled_modules: ['care'],
    }]),
    getTenant: vi.fn(async () => null),
    readiness: vi.fn(async () => null),
    usage: vi.fn(async () => []),
    listRuns: vi.fn(async () => []),
    runDetail: vi.fn(async () => null),
    runsSummary: vi.fn(async () => []),
    reconciliationQueue: vi.fn(async () => []),
    companyOverview: vi.fn(async () => ({
      tenant_id: COMPANY_B,
      display_name: 'Company B',
      status: 'ACTIVE',
      data_class: 'PRODUCTION',
      created_at: '2026-01-01T00:00:00.000Z',
      runs_total: 5,
      runs_failed: 1,
      runs_running: 1,
      runs_waiting: 0,
      retry_eligible_count: 1,
      reconciliation_count: 0,
      needs_attention: true,
      last_activity_at: '2026-01-01T00:05:00.000Z',
    })),
  } as unknown as PlatformDirectoryPort;
  const pauseTenant = vi.fn(async () => ({ state: 'PAUSED' }));
  const resumeTenant = vi.fn(async () => ({ state: 'ACTIVE' }));
  const demote = vi.fn(async () => ({ state: 'MINIMUM' }));
  const inspect = vi.fn(async (input: { readonly tenant_id: string }) => ({
    tenant_id: input.tenant_id,
    paused: false,
    current: [],
    history: [],
  }));
  const requestPromotion = vi.fn(async () => ({ request: { status: 'PENDING' }, policy: null }));
  const decidePromotion = vi.fn(async () => ({ request: { status: 'APPROVED' }, policy: null }));
  const listPromotionRequests = vi.fn(async () => []);
  const suspend = vi.fn(async () => ({ tenant_id: COMPANY_B, status: 'SUSPENDED' }));
  const resume = vi.fn(async () => ({ tenant_id: COMPANY_B, status: 'ACTIVE' }));
  const companyCommands = { suspend, resume } as unknown as PlatformCompanyCommandsPort;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerPlatformCompaniesRoutes(app, {
    platform,
    companyCommands,
    autonomyAdmin: {
      pauseTenant,
      resumeTenant,
      demote,
      inspect,
      requestPromotion,
      decidePromotion,
      listPromotionRequests,
    },
    credentials: createCredentialStore({
      operators: [{
        token: TOKEN,
        tenant_id: '99999999-9999-9999-9999-999999999999',
        operator_id: 'platform-operator',
        scope: 'platform',
        permissions: ['platform:admin'],
      }],
      sessions: [],
      widgets: [],
    }),
    runtime,
  });
  return { app, auditRecord, pauseTenant, resumeTenant, demote, inspect, suspend, resume, platform };
}

describe('platform company commands', () => {
  it('pauses a company run autonomy in the target tenant and audits actor + target', async () => {
    const { app, pauseTenant, auditRecord } = buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: `/platform/companies/${COMPANY_B}/autonomy/pause`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { reason: 'incident' },
    });
    expect(response.statusCode).toBe(200);
    expect(pauseTenant).toHaveBeenCalledWith({
      tenant_id: COMPANY_B,
      operator_id: 'platform-operator',
      reason: 'incident',
    });
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: COMPANY_B,
      operation: 'autonomy.pause',
      operator_id: 'platform-operator',
      detail: expect.objectContaining({ target_tenant: COMPANY_B }),
    }));
  });

  it('suspends a company through the tenant lifecycle command and audits it', async () => {
    const { app, suspend, auditRecord } = buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: `/platform/companies/${COMPANY_B}/suspend`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { reason: 'billing hold' },
    });
    expect(response.statusCode).toBe(200);
    expect(suspend).toHaveBeenCalledWith({ tenant_id: COMPANY_B, reason: 'billing hold' });
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      tenant_id: COMPANY_B,
      operation: 'companies.suspend',
      detail: expect.objectContaining({ target_tenant: COMPANY_B, status: 'SUSPENDED' }),
    }));
  });

  it('requires a reason before suspending a company', async () => {
    const { app, suspend, auditRecord } = buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: `/platform/companies/${COMPANY_B}/suspend`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {},
    });
    expect(response.statusCode).toBe(400);
    expect(suspend).not.toHaveBeenCalled();
    expect(auditRecord).not.toHaveBeenCalled();
  });

  it('reads target-company autonomy through the platform inspection port', async () => {
    const { app, inspect } = buildHarness();
    const response = await app.inject({
      method: 'GET',
      url: `/platform/companies/${COMPANY_B}/autonomy`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tenant_id: COMPANY_B, paused: false, current: [], history: [] });
    expect(inspect).toHaveBeenCalledWith({ tenant_id: COMPANY_B });
  });

  it('returns the derived company overview', async () => {
    const { app } = buildHarness();
    const response = await app.inject({
      method: 'GET',
      url: `/platform/companies/${COMPANY_B}/overview`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tenant_id: COMPANY_B, needs_attention: true });
  });
});
