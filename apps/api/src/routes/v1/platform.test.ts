import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { GatewayRuntime, PlatformDirectoryPort, PlatformProvidersPort } from '../../gateway/ports.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { createCredentialStore } from '../../gateway/principal.js';
import type { LlmConfigurationPort } from './company-llm.js';
import { registerPlatformRoutes } from './platform.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const COMPANY_TOKEN = 'company-token';
const PLATFORM_TOKEN = 'platform-token';

function buildHarness(options: { readonly listProviders?: LlmConfigurationPort['listPlatformProviders'] } = {}) {
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
    listRuns: async () => [],
    runDetail: async () => null,
    runTraceDetails: async () => ({
      stages: [],
      provider_calls: [],
      steps: [],
      audit_entries: [],
      approvals: [],
      handoffs: [],
      effect_keys: [],
      approval_id: null,
      evidence_refs: [],
    }),
    runsSummary: async () => [],
    reconciliationQueue: async () => [],
    companyOverview: async () => null,
  };
  const providers: PlatformProvidersPort = {
    list: async () => [{ provider: 'openai-compatible', configured: false, mode: 'NOT_CONFIGURED' }],
  };
  const llmConfiguration = {
    listPlatformProviders: options.listProviders ?? (async () => []),
  } as unknown as LlmConfigurationPort;
  const runtime = {
    ids: () => 'platform-correlation',
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerPlatformRoutes(app, {
    platform,
    providers,
    llmConfiguration,
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

  it('refuses a tenant_id query on a platform request with 403', async () => {
    const app = buildHarness();
    try {
      for (const url of [
        `/platform/tenants?tenant_id=${TENANT}`,
        `/platform/usage?tenant_id=${TENANT}`,
      ]) {
        const response = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
        });
        expect(response.statusCode).toBe(403);
      }
    } finally {
      await app.close();
    }
  });

  it('parses and accepts a valid usage time window', async () => {
    const app = buildHarness();
    try {
      const query = new URLSearchParams({
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-10-01T00:00:00.000Z',
      });
      const response = await app.inject({
        method: 'GET',
        url: `/platform/usage?${query.toString()}`,
        headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items: [] });
    } finally {
      await app.close();
    }
  });

  it('rejects missing, invalid, and non-increasing usage windows with 400', async () => {
    const app = buildHarness();
    try {
      for (const url of [
        '/platform/usage?from=2026-09-01T00%3A00%3A00.000Z',
        '/platform/usage?from=not-a-date&to=2026-10-01T00%3A00%3A00.000Z',
        '/platform/usage?from=2026-09-01&to=2026-10-01T00%3A00%3A00.000Z',
        '/platform/usage?from=2026-10-01T00%3A00%3A00.000Z&to=2026-09-01T00%3A00%3A00.000Z',
      ]) {
        const response = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
        });
        expect(response.statusCode).toBe(400);
      }
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

  it('surfaces the persisted last probe and the credential handle for each configured provider', async () => {
    const app = buildHarness({
      listProviders: async () => [{
        provider_id: 'primary',
        display_name: 'Primary provider',
        base_url: 'https://api.example.com/v1',
        reasoning_model: 'reasoning-v2',
        fast_model: 'fast-v2',
        timeout_ms: 30_000,
        structured_mode: 'json_schema',
        status: 'FAILED',
        is_default: true,
        secret_configured: true,
        config_version: '2',
        updated_at: '2026-10-01T00:00:00.000Z',
        last_probe: {
          outcome: 'FAIL',
          latency_ms: 812,
          http_status: 503,
          error_class: 'PROVIDER_UNAVAILABLE',
          probed_at: '2026-10-01T00:05:00.000Z',
        },
        secret_fingerprint: 'c'.repeat(64),
        secret_last4: '1234',
      }],
    });
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/platform/providers',
        headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json() as { providers: readonly Record<string, unknown>[] };
      expect(body.providers[0]).toMatchObject({
        provider_id: 'primary',
        secret_last4: '1234',
        secret_fingerprint: 'c'.repeat(64),
        last_probe: {
          outcome: 'FAIL',
          latency_ms: 812,
          http_status: 503,
          error_class: 'PROVIDER_UNAVAILABLE',
          probed_at: '2026-10-01T00:05:00.000Z',
        },
      });
      // The response schema is closed: a field it does not declare would be stripped here.
      expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|plaintext|bearer/i);
    } finally {
      await app.close();
    }
  });
});
