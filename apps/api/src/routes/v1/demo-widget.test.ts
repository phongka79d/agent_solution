import { createHmac } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { registerDemoWidgetRoutes } from './demo-widget.js';
import {
  DEMO_TENANT_ID,
  createDemoCredentialStore,
} from '../../runtime/demo-auth.js';

const ORIGIN = 'https://demo.example.test';
const ACCOUNTS = {
  companyAdminEmail: 'company.admin@example.test',
  companyAdminPassword: 'company-password-123',
  platformAdminEmail: 'platform.admin@example.test',
  platformAdminPassword: 'platform-password-123',
} as const;

const apps: FastifyInstance[] = [];
const originalEnv = {
  APP_ENV: process.env.APP_ENV,
  DEMO_MODE: process.env.DEMO_MODE,
  DEMO_WIDGET_ORIGINS: process.env.DEMO_WIDGET_ORIGINS,
};

function restoreEnv(key: keyof typeof originalEnv): void {
  const value = originalEnv[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function buildHarness(environment?: Readonly<Record<string, string | undefined>>) {
  const demoAuth = createDemoCredentialStore(ACCOUNTS);
  const operator = demoAuth.login(ACCOUNTS.companyAdminEmail, ACCOUNTS.companyAdminPassword, 'company');
  const approver = demoAuth.login(ACCOUNTS.platformAdminEmail, ACCOUNTS.platformAdminPassword, 'platform');
  if (operator === null || approver === null) throw new Error('demo test account credentials did not issue');

  const runtime = { ids: () => 'demo-widget-test-correlation' } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerDemoWidgetRoutes(app, {
    credentials: demoAuth,
    widgetSessions: {
      issue: ({ tenant_id, session_id, origin }) => demoAuth.issueWidget(session_id, origin, tenant_id),
      isDemoTenant: async () => true,
    },
    runtime,
    ...(environment === undefined ? {} : { env: () => environment }),
  });
  apps.push(app);
  return { app, demoAuth, operator, approver };
}

beforeEach(() => {
  process.env.APP_ENV = 'local';
  process.env.DEMO_MODE = 'true';
  process.env.DEMO_WIDGET_ORIGINS = ORIGIN;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const app of apps.splice(0)) await app.close();
  restoreEnv('APP_ENV');
  restoreEnv('DEMO_MODE');
  restoreEnv('DEMO_WIDGET_ORIGINS');
});

describe('POST /demo/widget-session', () => {
  it('mints the sanctioned verified C06 session in the canonical tenant', async () => {
    const { app, demoAuth, operator } = buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/demo/widget-session',
      headers: { authorization: `Bearer ${operator.access_token}`, origin: ORIGIN },
      payload: { persona: 'C06' },
    });

    expect(response.statusCode).toBe(201);
    const issued = response.json() as { access_token: string; session_id: string };
    expect(issued.session_id).toBe('sess-novamart-c06');
    expect(demoAuth.resolveWidgetSession(issued.access_token)).toMatchObject({
      tenant_id: DEMO_TENANT_ID,
      session_id: 'sess-novamart-c06',
      origin: ORIGIN,
    });
  });

  it('keeps C05, C06, and anonymous sessions distinct', async () => {
    const { app, operator } = buildHarness();
    const mint = (persona: string) => app.inject({
      method: 'POST',
      url: '/demo/widget-session',
      headers: { authorization: `Bearer ${operator.access_token}`, origin: ORIGIN },
      payload: { persona },
    });

    const [c05, c06, anonymous] = await Promise.all([mint('C05'), mint('C06'), mint('anonymous')]);
    expect(c05.statusCode).toBe(201);
    expect(c06.statusCode).toBe(201);
    expect(anonymous.statusCode).toBe(201);
    expect(c05.json().session_id).toBe('sess-novamart-c05');
    expect(c06.json().session_id).toBe('sess-novamart-c06');
    expect(c05.json().session_id).not.toBe(c06.json().session_id);
    expect(c05.json().session_id).not.toBe(anonymous.json().session_id);
  });

  it('rejects arbitrary customer claims and non-tenant operator roles', async () => {
    const { app, operator, approver } = buildHarness();
    const claimedCustomer = await app.inject({
      method: 'POST',
      url: '/demo/widget-session',
      headers: { authorization: `Bearer ${operator.access_token}`, origin: ORIGIN },
      payload: { persona: 'C06', customer_id: '99000000-0000-4000-8000-000000000005' },
    });
    expect(claimedCustomer.statusCode).toBe(400);
    expect(claimedCustomer.body).not.toContain('99000000-0000-4000-8000-000000000005');

    const unauthorizedRole = await app.inject({
      method: 'POST',
      url: '/demo/widget-session',
      headers: { authorization: `Bearer ${approver.access_token}`, origin: ORIGIN },
      payload: { persona: 'C06' },
    });
    expect(unauthorizedRole.statusCode).toBe(403);
    expect(unauthorizedRole.body).not.toContain('sess-novamart-c06');
  });

  it('reads DEMO_MODE and APP_ENV at request time', async () => {
    const { app, operator } = buildHarness();
    process.env.DEMO_MODE = 'false';

    const disabled = await app.inject({
      method: 'POST',
      url: '/demo/widget-session',
      headers: { authorization: `Bearer ${operator.access_token}`, origin: ORIGIN },
      payload: { persona: 'C06' },
    });

    expect(disabled.statusCode).toBe(403);
    expect(disabled.json().error_code).toBe('CAPABILITY_NOT_ENABLED');

    process.env.DEMO_MODE = 'true';
    process.env.APP_ENV = 'production';
    const production = await app.inject({
      method: 'POST',
      url: '/demo/widget-session',
      headers: { authorization: `Bearer ${operator.access_token}`, origin: ORIGIN },
      payload: { persona: 'C06' },
    });

    expect(production.statusCode).toBe(403);
    expect(production.json().error_code).toBe('CAPABILITY_NOT_ENABLED');
    expect(production.body).not.toContain('access_token');

  });
  it('requires an exact approved origin', async () => {
    const { app, operator } = buildHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/demo/widget-session',
      headers: { authorization: `Bearer ${operator.access_token}`, origin: 'https://demo.example.test.evil' },
      payload: { persona: 'C06' },
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('sess-novamart-c06');
  });
});

describe('GET /demo/catalog', () => {
  it('signs the mock ERP request over its canonical method, path, and body', async () => {
    const secret = 'local-demo-widget-hmac-secret-value';
    const fetchStub = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        items: [{
          sku_id: 'SKU-1',
          name: 'Demo item',
          brand: 'Demo brand',
          category: 'Demo category',
          use_case: 'Demo use',
          description: 'Demo description',
          currency: 'USD',
          list_price: 10,
          is_active: true,
        }],
      }),
    }));
    vi.stubGlobal('fetch', fetchStub);
    const { app, operator } = buildHarness({
      APP_ENV: 'local',
      DEMO_MODE: 'true',
      DEMO_WIDGET_ORIGINS: ORIGIN,
      MOCK_ERP_ENABLED: 'true',
      MOCK_SECRET_KEY: secret,
      ERP_API_BASE_URL: 'http://mock-erp.example.test/api/v1',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/demo/catalog',
      headers: { authorization: `Bearer ${operator.access_token}` },
    });

    expect(response.statusCode).toBe(200);
    const [, init] = fetchStub.mock.calls[0] as unknown as [
      string,
      { readonly headers: Readonly<Record<string, string>> },
    ];
    expect(init.headers['x-mock-signature']).toBe(
      createHmac('sha256', secret).update('GET /api/v1/catalog/items\n', 'utf8').digest('hex'),
    );
  });
});
