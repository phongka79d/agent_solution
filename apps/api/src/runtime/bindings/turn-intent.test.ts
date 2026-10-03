import { afterEach, describe, expect, it, vi } from 'vitest';

import { LlmConfigResolver } from '@agentos/core-engine';

import { createTurnIntentPort } from './turn-intent.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';

function providerFetch() {
  const requestBodies: Array<Record<string, unknown>> = [];
  vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
    requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
      id: 'request-1',
      choices: [{ message: { role: 'assistant', content: '{"intent":"faq_search","requirements":{},"confidence":0.9}' } }],
    }), { status: 200 });
  });
  return requestBodies;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createTurnIntentPort LLM configuration', () => {
  it('uses the tenant override fast model for intent classification', async () => {
    const requestBodies = providerFetch();
    const configResolver = new LlmConfigResolver(
      {
        getTenantOverride: async (tenant_id) => {
          expect(tenant_id).toBe(TENANT_ID);
          return {
            mode: 'CUSTOM',
            provider_id: 'tenant-provider',
            base_url: 'https://tenant-llm.example/v1',
            reasoning_model: 'tenant-reasoning-model',
            fast_model: 'tenant-fast-model',
            timeout_ms: 30_000,
            structured_mode: 'json_object',
            secret_id: 'tenant-secret',
            config_version: '42',
          };
        },
        getPlatformDefault: async () => ({
          provider_id: 'platform-provider',
          base_url: 'https://platform-llm.example/v1',
          reasoning_model: 'platform-reasoning-model',
          fast_model: 'platform-fast-model',
          timeout_ms: 30_000,
          structured_mode: 'json_object',
          secret_id: 'platform-secret',
          config_version: '7',
        }),
      },
      {
        resolve: async (tenant_id, secret_id) => {
          expect(tenant_id).toBe(TENANT_ID);
          expect(secret_id).toBe('tenant-secret');
          return 'tenant-only-key';
        },
        resolvePlatform: async () => 'platform-only-key',
      },
    );
    const port = createTurnIntentPort({} as NodeJS.ProcessEnv, { configResolver });

    await port?.propose({ message: 'Where is my order?', correlation_id: 'corr-1', tenant_id: TENANT_ID });

    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]?.model).toBe('tenant-fast-model');
  });

  it('refuses with LLM_NOT_CONFIGURED when the resolver returns null', async () => {
    const port = createTurnIntentPort({} as NodeJS.ProcessEnv, {
      configResolver: { resolve: async () => null },
    });

    await expect(port?.propose({
      message: 'Where is my order?',
      correlation_id: 'corr-1',
      tenant_id: TENANT_ID,
    })).rejects.toMatchObject({ code: 'LLM_NOT_CONFIGURED' });
  });

  it('uses environment fallback when no tenant or platform database rows exist', async () => {
    const requestBodies = providerFetch();
    const port = createTurnIntentPort({
      OPENAI_API_KEY: 'env-only-secret',
      PRIMARY_REASONING_MODEL: 'env-reasoning-model',
      FAST_COMPLETION_MODEL: 'env-fast-model',
    } as NodeJS.ProcessEnv);

    await port?.propose({ message: 'Where is my order?', correlation_id: 'corr-1', tenant_id: TENANT_ID });

    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]?.model).toBe('env-fast-model');
  });
});
