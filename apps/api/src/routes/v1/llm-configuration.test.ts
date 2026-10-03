import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { createCredentialStore } from '../../gateway/principal.js';
import type { CompanyLlmView, LlmConfigurationPort, PlatformLlmProviderView } from './company-llm.js';
import { registerCompanyLlmRoutes } from './company-llm.js';
import { registerPlatformProviderRoutes } from './platform-providers.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const COMPANY_TOKEN = 'company-llm-token';
const PLATFORM_TOKEN = 'platform-llm-token';

const PLATFORM_PROVIDER: PlatformLlmProviderView = {
  provider_id: 'primary',
  display_name: 'Primary provider',
  base_url: 'https://llm.example/v1',
  reasoning_model: 'reasoning-model',
  fast_model: 'fast-model',
  timeout_ms: 10_000,
  structured_mode: 'json_object',
  status: 'CONFIGURED',
  is_default: true,
  secret_configured: true,
  config_version: '2',
  updated_at: '2026-09-30T12:00:00.000Z',
  last_probe: null,
  secret_fingerprint: null,
  secret_last4: null,
};

const COMPANY_CONFIG: CompanyLlmView = {
  tenant_id: TENANT,
  mode: 'CUSTOM',
  provider_id: 'company-provider',
  base_url: 'https://llm.example/v1',
  reasoning_model: 'reasoning-model',
  fast_model: 'fast-model',
  timeout_ms: 10_000,
  structured_mode: 'json_object',
  monthly_token_budget: null,
  secret_configured: true,
  config_version: '3',
  updated_at: '2026-09-30T12:00:00.000Z',
  effective: {
    provider_id: 'company-provider',
    display_name: 'company-provider',
    base_url: 'https://llm.example/v1',
    reasoning_model: 'reasoning-model',
    fast_model: 'fast-model',
    timeout_ms: 10_000,
    structured_mode: 'json_object',
    secret_configured: true,
  },
};

function buildHarness() {
  const llmConfiguration: LlmConfigurationPort = {
    listPlatformProviders: vi.fn(async () => [PLATFORM_PROVIDER]),
    upsertPlatformProvider: vi.fn(async () => PLATFORM_PROVIDER),
    probePlatformProvider: vi.fn(async (_provider_id: string) => ({
      outcome: 'PASS' as const, latency_ms: 20, http_status: 200, error_class: null,
    })),
    getCompanyConfig: vi.fn(async () => COMPANY_CONFIG),
    putCompanyConfig: vi.fn(async () => COMPANY_CONFIG),
    probeCompanyConfig: vi.fn(async (_tenant_id: string) => ({
      outcome: 'PASS' as const, latency_ms: 20, http_status: 200, error_class: null,
    })),
  };
  const runtime = {
    ids: () => 'llm-route-correlation',
    clock: () => new Date('2026-09-30T12:00:00.000Z'),
  } as unknown as GatewayRuntime;
  const credentials = createCredentialStore({
    operators: [
      {
        token: COMPANY_TOKEN,
        tenant_id: TENANT,
        operator_id: 'company-admin',
        scope: 'company',
        permissions: ['llm:manage'],
      },
      {
        token: PLATFORM_TOKEN,
        tenant_id: TENANT,
        operator_id: 'platform-admin',
        scope: 'platform',
        permissions: ['platform:admin', 'platform:providers:write'],
      },
    ],
    sessions: [],
    widgets: [],
  });
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) =>
    replyFailure(reply, error, correlationIdOf(request, runtime)),
  );
  const env = () => ({ APP_ENV: 'production' });
  registerCompanyLlmRoutes(app, { runtime, credentials, llmConfiguration, env });
  registerPlatformProviderRoutes(app, { runtime, credentials, llmConfiguration, env });
  return { app, llmConfiguration };
}

const companyCustomConfig = {
  mode: 'CUSTOM',
  provider_id: 'company-provider',
  base_url: 'https://llm.example/v1',
  reasoning_model: 'reasoning-model',
  fast_model: 'fast-model',
  timeout_ms: 10_000,
  structured_mode: 'json_object',
  api_key: 'company-write-only-key',
};

const platformProviderConfig = {
  display_name: 'Primary provider',
  base_url: 'https://llm.example/v1',
  reasoning_model: 'reasoning-model',
  fast_model: 'fast-model',
  timeout_ms: 10_000,
  structured_mode: 'json_object',
  is_default: true,
  api_key: 'platform-write-only-key',
};

describe('LLM configuration routes', () => {
  it('accepts write-only API keys without returning them', async () => {
    const { app } = buildHarness();
    try {
      const companyResponse = await app.inject({
        method: 'PUT',
        url: '/company/settings/llm',
        headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
        payload: companyCustomConfig,
      });
      const platformResponse = await app.inject({
        method: 'PUT',
        url: '/platform/providers/primary',
        headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
        payload: platformProviderConfig,
      });

      expect(companyResponse.statusCode).toBe(200);
      expect(platformResponse.statusCode).toBe(200);
      expect(companyResponse.body).not.toContain(companyCustomConfig.api_key);
      expect(platformResponse.body).not.toContain(platformProviderConfig.api_key);
      expect(companyResponse.json()).not.toHaveProperty('api_key');
      expect(platformResponse.json()).not.toHaveProperty('api_key');
    } finally {
      await app.close();
    }
  });

  it('refuses HTTP and private provider URLs in production for company and platform writes', async () => {
    const { app, llmConfiguration } = buildHarness();
    try {
      for (const base_url of ['http://llm.example/v1', 'https://127.0.0.1/v1']) {
        const companyResponse = await app.inject({
          method: 'PUT',
          url: '/company/settings/llm',
          headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
          payload: { ...companyCustomConfig, base_url },
        });
        const platformResponse = await app.inject({
          method: 'PUT',
          url: '/platform/providers/primary',
          headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
          payload: { ...platformProviderConfig, base_url },
        });

        expect(companyResponse.statusCode).toBe(400);
        expect(companyResponse.json()).toMatchObject({ error_code: 'VALIDATION_FAILED' });
        expect(platformResponse.statusCode).toBe(400);
        expect(platformResponse.json()).toMatchObject({ error_code: 'VALIDATION_FAILED' });
      }
      expect(llmConfiguration.putCompanyConfig).not.toHaveBeenCalled();
      expect(llmConfiguration.upsertPlatformProvider).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rate-limits company and platform probes independently of the operator home tenant', async () => {
    const { app, llmConfiguration } = buildHarness();
    try {
      const platformProbe = await app.inject({
        method: 'POST',
        url: '/platform/providers/primary/test',
        headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
      });
      const companyProbe = await app.inject({
        method: 'POST',
        url: '/company/settings/llm/test',
        headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
      });
      const repeatedCompanyProbe = await app.inject({
        method: 'POST',
        url: '/company/settings/llm/test',
        headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
      });
      const repeatedPlatformProbe = await app.inject({
        method: 'POST',
        url: '/platform/providers/primary/test',
        headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
      });

      expect(platformProbe.statusCode).toBe(200);
      expect(companyProbe.statusCode).toBe(200);
      expect(repeatedCompanyProbe.statusCode).toBe(429);
      expect(repeatedPlatformProbe.statusCode).toBe(429);
      expect(llmConfiguration.probePlatformProvider).toHaveBeenCalledTimes(1);
      expect(llmConfiguration.probeCompanyConfig).toHaveBeenCalledWith(TENANT);
    } finally {
      await app.close();
    }
  });
});
