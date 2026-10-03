import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { PlatformTransactionRunner, RedisInjectedClient, TenantTransactionRunner } from '@agentos/database';
import { SkillCatalogRepository } from '@agentos/database';

import { createCredentialStore } from '../gateway/principal.js';
import { buildServer } from '../server.js';
import { createGatewayComposition, parseLlmBudgetConfig } from './composition.js';
import { DEMO_TENANT_ID } from './demo-auth.js';

const ENV = {
  SESSION_SECRET: 'test-session-secret-000000',
  PLATFORM_SECRET: 'test-platform-secret-00000',
};

const EMPTY_REDIS: RedisInjectedClient = {
  set: async () => null,
  get: async () => null,
  pttl: async () => -2,
  eval: async () => 0,
};
const EMPTY_DATABASE_RUNNER: TenantTransactionRunner = async () => {
  throw new Error('test database runner must not be called while checking composition bindings');
};

describe('parseLlmBudgetConfig', () => {
  it('defaults the per-run token budget while leaving the tenant budget unlimited', () => {
    expect(parseLlmBudgetConfig({})).toEqual({ per_run_token_budget: 4096 });
  });
});

describe('createGatewayComposition', () => {
  it('wires suspend and resume to the platform runner, never the tenant runner', async () => {
    const platformTransaction: PlatformTransactionRunner = vi.fn(async () => {
      throw new Error('platform lifecycle runner reached');
    });
    const tenantTransaction: TenantTransactionRunner = vi.fn(async () => {
      throw new Error('tenant runner must not handle platform lifecycle commands');
    });
    const composition = createGatewayComposition(ENV, {
      databaseRunner: tenantTransaction,
      platformDatabaseRunner: platformTransaction,
    });
    try {
      await expect(composition.companyCommands.suspend({ tenant_id: DEMO_TENANT_ID }))
        .rejects.toThrow('platform lifecycle runner reached');
      await expect(composition.companyCommands.resume({ tenant_id: DEMO_TENANT_ID }))
        .rejects.toThrow('platform lifecycle runner reached');
      expect(platformTransaction).toHaveBeenCalledTimes(2);
      expect(tenantTransaction).not.toHaveBeenCalled();
    } finally {
      await composition.close();
    }
  });

  it.each(['development', 'test', 'production'])('refuses explicit and default demo auth in APP_ENV=production with NODE_ENV=%s', (nodeEnv) => {
    const env = { ...ENV, APP_ENV: 'production', NODE_ENV: nodeEnv };
    expect(() => createGatewayComposition(env)).toThrow('AUTH_PROVIDER_PRODUCTION_REQUIRES_DB');
    expect(() => createGatewayComposition({ ...env, AUTH_PROVIDER: 'demo' })).toThrow('AUTH_PROVIDER_PRODUCTION_REQUIRES_DB');
    expect(() => createGatewayComposition({ ...env, AUTH_PROVIDER: 'demo', DEMO_MODE: 'true' }))
      .toThrow('AUTH_PROVIDER_PRODUCTION_REQUIRES_DB');
  });

  it('accepts durable auth in production without exposing demo login', async () => {
    const composition = createGatewayComposition({
      ...ENV,
      APP_ENV: 'production',
      NODE_ENV: 'production',
      AUTH_PROVIDER: 'db',
    }, { databaseRunner: EMPTY_DATABASE_RUNNER });
    const app = buildServer(composition);
    try {
      const session = await app.inject({ method: 'GET', url: '/api/v1/auth/session' });
      expect(session.statusCode).toBe(401);
      expect(session.json()).toMatchObject({ error_code: 'AUTHENTICATION_FAILED' });
      const demoLogin = await app.inject({
        method: 'POST',
        url: '/api/v1/demo/login',
        payload: { email: 'company.admin@example.test', password: 'tenant-password', audience: 'company' },
      });
      expect(demoLogin.statusCode).toBe(404);
      const demoWidget = await app.inject({
        method: 'POST', url: '/api/v1/demo/widget-session', payload: { persona: 'anonymous' },
      });
      expect(demoWidget.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it('requires a database for durable authentication in production', () => {
    expect(() => createGatewayComposition({
      ...ENV,
      APP_ENV: 'production',
      AUTH_PROVIDER: 'db',
    })).toThrow('AUTH_PROVIDER: durable identity requires DATABASE_URL');
  });

  it.each(['local', 'ci'])('retains default demo authentication for APP_ENV=%s regardless of Node runtime mode', async (appEnv) => {
    const composition = createGatewayComposition({
      ...ENV,
      APP_ENV: appEnv,
      NODE_ENV: 'production',
      DEMO_MODE: 'true',
      DEMO_COMPANY_ADMIN_EMAIL: 'company.admin@example.test',
      DEMO_COMPANY_ADMIN_PASSWORD: 'tenant-password',
      DEMO_PLATFORM_ADMIN_EMAIL: 'platform.admin@example.test',
      DEMO_PLATFORM_ADMIN_PASSWORD: 'platform-password',
    });
    try {
      const session = composition.demoAuth?.login('company.admin@example.test', 'tenant-password', 'company');
      if (session === undefined || session === null) throw new Error('local/CI demo login must remain available');
      expect(session.membership).toMatchObject({
        tenant_id: '99999999-9999-4999-8999-999999999999',
        data_class: 'DEMO',
        scope: 'company',
      });
      expect(composition.credentials.resolveOperator(session.access_token)).toMatchObject({
        tenant_id: session.membership.tenant_id,
        scope: 'company',
      });
    } finally {
      await composition.close();
    }
  });
  const widgetDataClasses: readonly ('DEMO' | 'TEST' | 'PRODUCTION' | null)[] = ['DEMO', 'TEST', 'PRODUCTION', null];
  it.each(widgetDataClasses)(
    'DB auth in ci mints anonymous widgets only for DEMO data, not %s',
    async (dataClass) => {
      const readDataClass = vi.spyOn(SkillCatalogRepository.prototype, 'tenantDataClass').mockResolvedValue(dataClass);
      const origin = 'https://demo.example.test';
      const env = {
        ...ENV, AUTH_PROVIDER: 'db', APP_ENV: 'ci', DEMO_MODE: 'true', DEMO_WIDGET_ORIGINS: origin,
      };
      const composition = createGatewayComposition(env, {
        databaseRunner: EMPTY_DATABASE_RUNNER,
        credentials: createCredentialStore({
          operators: [{
            token: 'db-widget-operator', tenant_id: DEMO_TENANT_ID, operator_id: 'db-company-admin',
            scope: 'company', permissions: ['conversation:takeover'],
          }, {
            token: 'db-widget-platform', tenant_id: DEMO_TENANT_ID, operator_id: 'db-platform-admin',
            scope: 'platform', permissions: ['conversation:takeover'],
          }, {
            token: 'db-widget-no-permission', tenant_id: DEMO_TENANT_ID, operator_id: 'db-company-reader',
            scope: 'company', permissions: [],
          }],
          sessions: [], widgets: [], session_secret: ENV.SESSION_SECRET,
        }),
      });
      const app = buildServer(composition);
      try {
        expect(composition.demoAuth).toBeUndefined();
        for (const token of ['db-widget-platform', 'db-widget-no-permission']) {
          const refused = await app.inject({
            method: 'POST', url: '/api/v1/demo/widget-session',
            headers: { authorization: `Bearer ${token}`, origin }, payload: { persona: 'anonymous' },
          });
          expect(refused.statusCode).toBe(403);
          expect(refused.body).not.toContain('access_token');
        }
        expect(readDataClass).not.toHaveBeenCalled();
        const response = await app.inject({
          method: 'POST', url: '/api/v1/demo/widget-session',
          headers: { authorization: 'Bearer db-widget-operator', origin },
          payload: { persona: 'anonymous' },
        });
        expect(readDataClass).toHaveBeenCalledWith(DEMO_TENANT_ID);
        if (dataClass === 'DEMO') {
          expect(response.statusCode).toBe(201);
          const issued = response.json<{ access_token: string; session_id: string }>();
          expect(issued.session_id).toMatch(/^demo-anon-/);
          const credential = composition.credentials.resolveWidgetSession(issued.access_token);
          expect(credential).toMatchObject({ tenant_id: DEMO_TENANT_ID, origin, session_id: issued.session_id });
          expect(credential).not.toHaveProperty('customer_id');
          const badOrigin = await app.inject({
            method: 'POST', url: '/api/v1/demo/widget-session',
            headers: { authorization: 'Bearer db-widget-operator', origin: `${origin}.evil` },
            payload: { persona: 'anonymous' },
          });
          expect(badOrigin.statusCode).toBe(401);
          expect(badOrigin.body).not.toContain('access_token');
          env.APP_ENV = 'production';
          const production = await app.inject({
            method: 'POST', url: '/api/v1/demo/widget-session',
            headers: { authorization: 'Bearer db-widget-operator', origin },
            payload: { persona: 'anonymous' },
          });
          expect(production.statusCode).toBe(403);
          expect(production.json()).toMatchObject({ error_code: 'CAPABILITY_NOT_ENABLED' });
          expect(production.body).not.toContain('access_token');
        } else {
          expect(response.statusCode).toBe(403);
          expect(response.json()).toMatchObject({ error_code: 'CAPABILITY_NOT_ENABLED' });
          expect(response.body).not.toContain('access_token');
        }
        const demoLogin = await app.inject({
          method: 'POST', url: '/api/v1/demo/login',
          payload: { email: 'company.admin@example.test', password: 'tenant-password', audience: 'company' },
        });
        expect(demoLogin.statusCode).toBe(404);
      } finally {
        readDataClass.mockRestore();
        await app.close();
      }
    },
  );

  it('binds durable intake and approval decisions without Redis', async () => {
    const composition = createGatewayComposition(ENV, { redis: EMPTY_REDIS });

    expect(composition.unbound).not.toContain('runs.reconcile');
    expect(composition.unbound).not.toContain('approvals.decide');
    expect(composition.unbound).not.toContain('runs.start');
    expect(composition.unbound).not.toContain('runs.read');
    expect(composition.unbound).not.toContain('runs.list');
    expect(composition.unbound).not.toContain('approvals.list');
    expect(composition.unbound).not.toContain('identity.resolveCustomer');
    expect(composition.unbound).not.toContain('takeover.acquire/renew/release/holder');

    expect(composition.runtime.runs.reconcile).toBeTypeOf('function');
    expect(composition.runtime.approvals.decide).toBeTypeOf('function');
    const turnRateLimiter = composition.turnRateLimiter;
    if (turnRateLimiter === undefined) {
      throw new Error('the configured Redis client must back the conversation turn limiter');
    }
    expect(await turnRateLimiter.consume('tenant-a', 'session-a')).toBe(false);

    await composition.close();
  });

  it('binds P5 route ports only when a database runner is configured', async () => {
    const withoutDatabase = createGatewayComposition(ENV);
    expect(withoutDatabase.provisioning).toBeUndefined();
    expect(withoutDatabase.autonomyAdmin).toBeUndefined();
    await withoutDatabase.close();

    const withDatabase = createGatewayComposition(ENV, { databaseRunner: EMPTY_DATABASE_RUNNER });
    expect(withDatabase.provisioning?.createShell).toBeTypeOf('function');
    expect(withDatabase.provisioning?.getShell).toBeTypeOf('function');
    expect(withDatabase.autonomyAdmin?.inspect).toBeTypeOf('function');
    await withDatabase.close();
  });

  const dataClasses: readonly ('DEMO' | 'TEST' | 'PRODUCTION' | null)[] = ['DEMO', 'TEST', 'PRODUCTION', null];
  it.each(dataClasses)('scopes environment ERP eligibility to DEMO, not %s', async (dataClass) => {
    const readDataClass = vi.spyOn(SkillCatalogRepository.prototype, 'tenantDataClass').mockResolvedValue(dataClass);
    const composition = createGatewayComposition({
      ...ENV, MOCK_ERP_ENABLED: 'true', ERP_API_BASE_URL: 'http://mock-erp:8081/api/v1',
      MOCK_SECRET_KEY: 'test-mock-erp-key-00000',
    }, { databaseRunner: EMPTY_DATABASE_RUNNER });
    try {
      expect(await composition.runtime.companyIntegrations?.demoErpEligibleForTenant?.('tenant-erp'))
        .toBe(dataClass === 'DEMO');
      expect(readDataClass).toHaveBeenCalledWith('tenant-erp');
    } finally {
      readDataClass.mockRestore();
      await composition.close();
    }
  });

  it('mounts the knowledge lifecycle in a database-backed API composition', async () => {
    const composition = createGatewayComposition(ENV, {
      databaseRunner: EMPTY_DATABASE_RUNNER,
      credentials: createCredentialStore({
        operators: [{
          token: 'knowledge-reader-token',
          tenant_id: '9a2f7ed4-1fe4-4f8c-8d63-008450000002',
          operator_id: 'knowledge-reader',
          scope: 'company',
          permissions: [],
        }],
        sessions: [],
        widgets: [],
      }),
    });
    const app = buildServer(composition);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/knowledge/documents',
        headers: { authorization: 'Bearer knowledge-reader-token' },
        payload: {
          namespace: 'customer-care',
          type: 'FAQ',
          slug: 'stack-contract',
          title: 'Stack contract',
          body: '# Stack contract',
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error_code: 'INSUFFICIENT_AUTHORITY' });
    } finally {
      await app.close();
    }
  });
  it('issues database-auth widget sessions only for TEST customers', async () => {
    const composition = createGatewayComposition({
      ...ENV,
      AUTH_PROVIDER: 'db',
      DATABASE_URL: 'postgresql://unused.invalid/test',
    }, { databaseRunner: EMPTY_DATABASE_RUNNER, redis: EMPTY_REDIS });
    const issuer = composition.widgetSessions;
    if (issuer === undefined) throw new Error('DB auth must bind the Test Customer Lab widget-session issuer');

    const issued = await issuer.issue({
      tenant_id: 'tenant-a',
      customer_id: 'customer-a',
      data_class: 'TEST',
      session_id: 'testlab-customer-a-session-a',
      origin: 'https://store.example.test',
    });
    expect(composition.credentials.resolveWidgetSession(issued.access_token)).toEqual({
      token: issued.access_token,
      tenant_id: 'tenant-a',
      customer_id: 'customer-a',
      session_id: 'testlab-customer-a-session-a',
      origin: 'https://store.example.test',
      expires_at_ms: expect.any(Number),
    });
    await expect(issuer.issue({
      tenant_id: 'tenant-a',
      customer_id: 'customer-b',
      data_class: 'PRODUCTION',
      session_id: 'testlab-customer-b-session-b',
      origin: 'https://store.example.test',
    })).rejects.toThrow('TEST_CUSTOMER_NOT_TEST_DATA');

    await composition.close();
  });

  it('keeps takeover fail-closed when no Redis store is configured', async () => {
    const composition = createGatewayComposition(ENV);

    expect(composition.unbound).toContain('takeover.acquire/renew/release/holder');
    await expect(composition.runtime.takeover.holder('tenant-a', 'conversation-a')).rejects.toMatchObject({
      port: 'takeover.holder',
      name: 'UnboundPortError',
    });

    await composition.close();
  });
  it('reports an unbound provider without inventing an empty model or ledger counts', async () => {
    const composition = createGatewayComposition({
      ...ENV,
      APP_ENV: 'local',
      DEMO_MODE: 'true',
      DEMO_COMPANY_ADMIN_EMAIL: 'company.admin@example.test',
      DEMO_COMPANY_ADMIN_PASSWORD: 'tenant-password',
      DEMO_PLATFORM_ADMIN_EMAIL: 'platform.admin@example.test',
      DEMO_PLATFORM_ADMIN_PASSWORD: 'platform-password',
    });
    const snapshot = await composition.readiness.snapshot({ tenant_id: '99999999-9999-4999-8999-999999999999' });
    expect(snapshot.provider.configured).toBe(false);
    expect(snapshot.provider.models).toEqual([]);
    expect(snapshot.ledger).toEqual({ status: 'UNAVAILABLE', stage_event_count: null, provider_call_count: null });
    await composition.close();
  });

  it('keeps the offline demo provider-free even when boot schema placeholders are present', async () => {
    const composition = createGatewayComposition({
      ...ENV,
      APP_ENV: 'local',
      DEMO_MODE: 'true',
      DEMO_PROVIDER_MODE: 'offline',
      DEMO_COMPANY_ADMIN_EMAIL: 'company.admin@example.test',
      DEMO_COMPANY_ADMIN_PASSWORD: 'tenant-password',
      DEMO_PLATFORM_ADMIN_EMAIL: 'platform.admin@example.test',
      DEMO_PLATFORM_ADMIN_PASSWORD: 'platform-password',
      OPENAI_API_KEY: 'offline-provider-disabled',
      OPENAI_BASE_URL: 'http://127.0.0.1:9/v1',
      PRIMARY_REASONING_MODEL: 'offline-model',
    });
    expect(composition.intentProposer).toBeUndefined();
    expect((await composition.readiness.snapshot({ tenant_id: 'tenant-a' })).provider.configured).toBe(false);
    await composition.close();
  });
  it('requires migration to account environment variables when legacy variables remain', () => {
    expect(() => createGatewayComposition({
      ...ENV,
      APP_ENV: 'local',
      DEMO_MODE: 'true',
      DEMO_TENANT_OPERATOR_PASSWORD: 'legacy-tenant',
      DEMO_MARKETING_APPROVER_PASSWORD: 'legacy-approver',
    })).toThrow(
      'DEMO_AUTH_ENV_MIGRATION_REQUIRED: DEMO_COMPANY_ADMIN_EMAIL, DEMO_COMPANY_ADMIN_PASSWORD, DEMO_PLATFORM_ADMIN_EMAIL, DEMO_PLATFORM_ADMIN_PASSWORD',
    );
  });

  it('uses tenant webhook secrets in production and only allows the global fallback in local/CI', async () => {
    const tenantSecret = 'tenant-specific-webhook-secret';
    const body = '{"event":"created"}';
    const tenantSignature = createHmac('sha256', tenantSecret).update(body, 'utf8').digest('hex');
    const globalSignature = createHmac('sha256', ENV.PLATFORM_SECRET).update(body, 'utf8').digest('hex');
    const channelSecrets = {
      resolve: async () => null,
      resolvePlatform: async (tenant_id: string) => tenant_id === 'tenant-a' ? tenantSecret : null,
    };

    const production = createGatewayComposition(
      { ...ENV, APP_ENV: 'production', AUTH_PROVIDER: 'db' },
      { channelSecrets, databaseRunner: EMPTY_DATABASE_RUNNER },
    );
    const tenantAccepted = await production.runtime.webhooks.verify({
      tenant_id: 'tenant-a',
      channel: null,
      raw_body: body,
      headers: { 'x-signature-sha256': tenantSignature },
    });
    const unknownTenant = await production.runtime.webhooks.verify({
      tenant_id: 'tenant-unknown',
      channel: null,
      raw_body: body,
      headers: { 'x-signature-sha256': tenantSignature },
    });
    await production.close();

    const noFallback = createGatewayComposition(
      { ...ENV, APP_ENV: 'production', AUTH_PROVIDER: 'db' },
      { databaseRunner: EMPTY_DATABASE_RUNNER },
    );
    const globalRejected = await noFallback.runtime.webhooks.verify({
      tenant_id: 'tenant-a',
      channel: null,
      raw_body: body,
      headers: { 'x-signature-sha256': globalSignature },
    });
    await noFallback.close();

    const local = createGatewayComposition({ ...ENV, APP_ENV: 'local' });
    const localAccepted = await local.runtime.webhooks.verify({
      tenant_id: 'tenant-a',
      channel: null,
      raw_body: body,
      headers: { 'x-signature-sha256': globalSignature },
    });
    await local.close();

    expect(tenantAccepted).toEqual({ ok: true });
    expect(unknownTenant).toEqual({ ok: false, error_code: 'SIGNATURE_INVALID' });
    expect(globalRejected).toEqual({ ok: false, error_code: 'SIGNATURE_INVALID' });
    expect(localAccepted).toEqual({ ok: true });
  });
});
