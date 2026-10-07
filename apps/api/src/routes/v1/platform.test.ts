import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { GatewayRuntime, PlatformDirectoryPort, PlatformProvidersPort } from '../../gateway/ports.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerPlatformRoutes } from './platform.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const COMPANY_TOKEN = 'company-token';
const PLATFORM_TOKEN = 'platform-token';

function buildHarness() {
  const platform: PlatformDirectoryPort = {
    listTenants: async () => [{
      tenant_id: TENANT,
      display_name: 'Acme',
      status: 'PROVISIONED',
      created_at: '2026-09-23T00:00:00.000Z',
      enabled_modules: null,
    }],
    getTenant: async () => null,
    readiness: async () => null,
    usage: async () => [],
  };
  const providers: PlatformProvidersPort = {
    list: async () => [{ provider: 'openai-compatible', configured: false, mode: 'NOT_CONFIGURED' }],
  };
  const runtime = {
    ids: () => 'platform-correlation',
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerPlatformRoutes(app, {
    platform,
    providers,
    runtime,
    credentials: createCredentialStore({
      operators: [
        {
          token: COMPANY_TOKEN,
          tenant_id: TENANT,
          operator_id: 'company-operator',
          scope: 'company',
          permissions: ['platform:admin'],
        },
        {
          token: PLATFORM_TOKEN,
          tenant_id: 'platform-principal',
          operator_id: 'platform-operator',
          scope: 'platform',
          permissions: ['platform:admin'],
        },
      ],
      sessions: [],
      widgets: [],
    }),
  });
  return app;
}

describe('platform control-plane routes', () => {
  it('refuses a company-scope principal even when it has the permission', async () => {
    const app = buildHarness();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/platform/tenants',
        headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
      });
      expect(response.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('refuses a tenant header on a platform request', async () => {
    const app = buildHarness();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/platform/tenants',
        headers: {
          authorization: `Bearer ${PLATFORM_TOKEN}`,
          'x-tenant-id': TENANT,
        },
      });
      expect(response.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('returns only redacted provider metadata', async () => {
    const app = buildHarness();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/platform/providers',
        headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { items: readonly Record<string, unknown>[] };
      expect(body.items).toEqual([{ provider: 'openai-compatible', configured: false, mode: 'NOT_CONFIGURED' }]);
      expect(JSON.stringify(body)).not.toMatch(/key|secret|token|password|credential|https?:\/\//i);
    } finally {
      await app.close();
    }
  });
});
