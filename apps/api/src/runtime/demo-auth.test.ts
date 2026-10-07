import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import type { GatewayRuntime } from '../gateway/ports.js';
import { registerDemoAuthRoutes } from '../routes/v1/demo-auth.js';
import { replyFailure } from '../gateway/http.js';
import {
  DEMO_SESSION_TTL_MS,
  DEMO_TENANT_ID,
  createDemoCredentialStore,
} from './demo-auth.js';
import { createGatewayComposition } from './composition.js';

const ACCOUNTS = {
  companyAdminEmail: 'company.admin@example.test',
  companyAdminPassword: 'company-password-123',
  platformAdminEmail: 'platform.admin@example.test',
  platformAdminPassword: 'platform-password-123',
} as const;

const SECRETS = {
  SESSION_SECRET: 'test-session-secret-000000',
  PLATFORM_SECRET: 'test-platform-secret-00000',
} as const;

const apps: FastifyInstance[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

function store(now: { value: number }) {
  return createDemoCredentialStore({ ...ACCOUNTS, now: () => now.value });
}

async function authApp(demoAuth = store({ value: 0 })): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => replyFailure(reply, error, 'demo-auth-test'));
  registerDemoAuthRoutes(app, {
    demoAuth,
    runtime: {} as GatewayRuntime,
  });
  await app.ready();
  apps.push(app);
  return app;
}

describe('demo credential store', () => {
  it('issues account-scoped credentials with the exact demo tenant and permissions', () => {
    const now = { value: 0 };
    const demo = store(now);

    const company = demo.login(ACCOUNTS.companyAdminEmail, ACCOUNTS.companyAdminPassword, 'company');
    const platform = demo.login(ACCOUNTS.platformAdminEmail, ACCOUNTS.platformAdminPassword, 'platform');

    expect(company).toMatchObject({
      membership: { role: 'company_admin', scope: 'company', tenant_id: DEMO_TENANT_ID, tenant_name: null },
    });
    expect(company?.permissions).toEqual([
      'campaign:draft',
      'conversation:takeover',
      'customer:read',
      'run:read',
      'telemetry:read',
      'approval:read',
      'approval:decide',
    ]);
    expect(platform).toMatchObject({
      membership: { role: 'platform_admin', scope: 'platform', tenant_id: DEMO_TENANT_ID },
      identity: { user_id: 'demo-platform-admin', display_name: 'Platform Admin' },
    });
    expect(platform?.permissions).toEqual(['platform:admin', 'run:read', 'run:retry', 'run:reconcile', 'telemetry:read']);
    expect(new Set([company?.access_token, platform?.access_token]).size).toBe(2);
    expect(company?.access_token).not.toContain(ACCOUNTS.companyAdminPassword);
  });

  it('rejects invalid credentials, unknown accounts, and cross-audience passwords', () => {
    const demo = store({ value: 0 });

    expect(demo.login(ACCOUNTS.companyAdminEmail, 'wrong-password', 'company')).toBeNull();
    expect(demo.login('unknown@example.test', ACCOUNTS.companyAdminPassword, 'company')).toBeNull();
    expect(demo.login(ACCOUNTS.companyAdminEmail, ACCOUNTS.companyAdminPassword, 'platform')).toBeNull();
  });

  it('expires and revokes operator and widget credentials', () => {
    const now = { value: 0 };
    const demo = store(now);
    const session = demo.login(ACCOUNTS.companyAdminEmail, ACCOUNTS.companyAdminPassword, 'company');
    expect(session).not.toBeNull();
    if (session === null) return;

    const widget = demo.issueWidget('widget-session-1', 'http://localhost:3000');
    expect(widget.access_token).not.toBe(session.access_token);
    expect(demo.resolveWidgetSession(widget.access_token)).toMatchObject({
      tenant_id: DEMO_TENANT_ID,
      session_id: 'widget-session-1',
      origin: 'http://localhost:3000',
    });

    const expiring = demo.login(ACCOUNTS.companyAdminEmail, ACCOUNTS.companyAdminPassword, 'company');
    expect(expiring).not.toBeNull();
    if (expiring === null) return;

    expect(demo.revoke(session.access_token)).toBe(true);
    expect(demo.resolveDemoSession(session.access_token)).toBeNull();
    expect(demo.revoke(session.access_token)).toBe(false);

    now.value = DEMO_SESSION_TTL_MS;
    expect(demo.resolveDemoSession(expiring.access_token)).toBeNull();
    expect(demo.resolveWidgetSession(widget.access_token)).toBeNull();
  });

  it('locks repeated failures per IP and email, then resets after success', () => {
    const now = { value: 0 };
    const demo = createDemoCredentialStore({ ...ACCOUNTS, now: () => now.value, maxFailures: 3, backoffBaseMs: 1000 });
    const ip = '198.51.100.10';
    expect(demo.login(ACCOUNTS.companyAdminEmail, 'wrong-password', 'company', ip)).toBeNull();
    expect(demo.login(ACCOUNTS.companyAdminEmail, 'wrong-password', 'company', ip)).toBeNull();
    expect(demo.login(ACCOUNTS.companyAdminEmail, 'wrong-password', 'company', ip)).toBeNull();
    expect(demo.retryAfter(ACCOUNTS.companyAdminEmail, ip)).toBe(1);
    expect(demo.login(ACCOUNTS.companyAdminEmail, ACCOUNTS.companyAdminPassword, 'company', ip)).toBeNull();
    now.value += 1000;
    expect(demo.login(ACCOUNTS.companyAdminEmail, ACCOUNTS.companyAdminPassword, 'company', ip)).not.toBeNull();
  });

  it('fails closed for production DEMO_MODE and has no demo store when disabled', async () => {
    expect(() => createGatewayComposition({
      ...SECRETS,
      APP_ENV: 'production',
      DEMO_MODE: 'true',
    })).toThrow('DEMO_MODE requires APP_ENV=local or APP_ENV=ci');

    const composition = createGatewayComposition({
      ...SECRETS,
      APP_ENV: 'production',
      DEMO_MODE: 'false',
    });
    expect(composition.demoAuth).toBeUndefined();
    await composition.close();
  });
});

describe('demo auth routes', () => {
  it('returns identical generic 401 responses for unknown, wrong-password, and audience mismatch', async () => {
    const app = await authApp();
    const requests = [
      { email: 'unknown@example.test', password: ACCOUNTS.companyAdminPassword, audience: 'company' },
      { email: ACCOUNTS.companyAdminEmail, password: 'wrong-password', audience: 'company' },
      { email: ACCOUNTS.companyAdminEmail, password: ACCOUNTS.companyAdminPassword, audience: 'platform' },
    ] as const;
    const responses = await Promise.all(requests.map((payload) => app.inject({ method: 'POST', url: '/demo/login', payload })));
    expect(responses.map((response) => response.statusCode)).toEqual([401, 401, 401]);
    expect(responses[0]?.body).toBe(responses[1]?.body);
    expect(responses[1]?.body).toBe(responses[2]?.body);
    expect(responses[0]?.body).not.toContain('access_token');
    expect(responses[0]?.body).not.toContain(ACCOUNTS.companyAdminPassword);
  });

  it('returns the account session DTO and revokes it at logout', async () => {
    const app = await authApp();
    const login = await app.inject({
      method: 'POST',
      url: '/demo/login',
      payload: {
        email: ACCOUNTS.platformAdminEmail,
        password: ACCOUNTS.platformAdminPassword,
        audience: 'platform',
      },
    });
    expect(login.statusCode).toBe(200);
    const issued = login.json() as { access_token: string };
    expect(login.json()).toMatchObject({
      identity: { user_id: 'demo-platform-admin', email: ACCOUNTS.platformAdminEmail, display_name: 'Platform Admin' },
      membership: { tenant_id: DEMO_TENANT_ID, tenant_name: null, role: 'platform_admin', scope: 'platform' },
      permissions: ['platform:admin', 'run:read', 'run:retry', 'run:reconcile', 'telemetry:read'],
    });

    const session = await app.inject({
      method: 'GET',
      url: '/demo/session',
      headers: { authorization: `Bearer ${issued.access_token}` },
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({
      membership: { role: 'platform_admin', scope: 'platform' },
      identity: { user_id: 'demo-platform-admin' },
    });
    expect(session.body).not.toContain('access_token');

    const logout = await app.inject({
      method: 'POST',
      url: '/demo/logout',
      headers: { authorization: `Bearer ${issued.access_token}` },
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.json()).toEqual({ revoked: true });

    const expired = await app.inject({
      method: 'GET',
      url: '/demo/session',
      headers: { authorization: `Bearer ${issued.access_token}` },
    });
    expect(expired.statusCode, expired.body).toBe(401);
  });

  it('returns 429 and Retry-After after the configured failure threshold', async () => {
    const demoAuth = createDemoCredentialStore({ ...ACCOUNTS, maxFailures: 2, backoffBaseMs: 1000 });
    const app = await authApp(demoAuth);
    const payload = { email: ACCOUNTS.companyAdminEmail, password: 'wrong-password', audience: 'company' };
    expect((await app.inject({ method: 'POST', url: '/demo/login', payload })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/demo/login', payload })).statusCode).toBe(429);
    const locked = await app.inject({ method: 'POST', url: '/demo/login', payload: { ...payload, password: ACCOUNTS.companyAdminPassword } });
    expect(locked.statusCode).toBe(429);
    expect(locked.headers['retry-after']).toBe('1');
  });
});
