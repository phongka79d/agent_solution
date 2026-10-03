import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayRuntime } from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import type { LlmConfigurationPort, PlatformLlmProviderView } from './company-llm.js';
import { registerPlatformProviderRoutes } from './platform-providers.js';

const PLATFORM_TOKEN = 'platform-providers-token';

const PROVIDER: PlatformLlmProviderView = {
  provider_id: 'primary',
  display_name: 'Primary provider',
  base_url: 'https://api.example.com/v1',
  reasoning_model: 'reasoning-v2',
  fast_model: 'fast-v2',
  timeout_ms: 30_000,
  structured_mode: 'json_schema',
  status: 'CONFIGURED',
  is_default: true,
  secret_configured: true,
  config_version: '2',
  updated_at: '2026-10-01T00:00:00.000Z',
  last_probe: null,
  secret_fingerprint: 'c'.repeat(64),
  secret_last4: '1234',
};

const INPUT = {
  display_name: 'Primary provider',
  base_url: 'https://api.example.com/v1',
  reasoning_model: 'reasoning-v2',
  fast_model: 'fast-v2',
  timeout_ms: 30_000,
  structured_mode: 'json_schema',
  is_default: true,
  api_key: null,
};

function buildHarness() {
  const upsertPlatformProvider = vi.fn(async (_input: unknown, _actor: unknown) => PROVIDER);
  const llmConfiguration = { upsertPlatformProvider } as unknown as LlmConfigurationPort;
  const runtime = { ids: () => 'providers-route-correlation' } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerPlatformProviderRoutes(app, {
    runtime,
    llmConfiguration,
    credentials: createCredentialStore({
      operators: [{
        token: PLATFORM_TOKEN,
        tenant_id: 'platform-principal',
        operator_id: 'platform-operator',
        scope: 'platform',
        permissions: ['platform:providers:write'],
      }],
      sessions: [],
      widgets: [],
    }),
  });
  return { app, upsertPlatformProvider };
}

describe('platform provider routes', () => {
  it('records an optional operator reason on the provider audit event', async () => {
    const { app, upsertPlatformProvider } = buildHarness();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/platform/providers/primary',
        headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
        payload: { ...INPUT, reason: 'promote the verified provider to default' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(PROVIDER);
      expect(upsertPlatformProvider).toHaveBeenCalledWith(
        { provider_id: 'primary', ...INPUT },
        expect.objectContaining({ reason: 'promote the verified provider to default' }),
      );
    } finally {
      await app.close();
    }
  });

  it('omits the reason when the caller supplies none', async () => {
    const { app, upsertPlatformProvider } = buildHarness();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/platform/providers/primary',
        headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
        payload: { ...INPUT },
      });

      expect(response.statusCode).toBe(200);
      const actor = upsertPlatformProvider.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
      expect(actor).toBeDefined();
      expect(Object.prototype.hasOwnProperty.call(actor, 'reason')).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('rejects a blank reason instead of recording an audit event without a rationale', async () => {
    const { app, upsertPlatformProvider } = buildHarness();
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/platform/providers/primary',
        headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
        payload: { ...INPUT, reason: '   ' },
      });

      expect(response.statusCode).toBe(400);
      expect(upsertPlatformProvider).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
