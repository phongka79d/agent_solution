import { describe, expect, it, vi } from 'vitest';

import { LlmConfigResolver, type LlmPlatformConfig, type LlmTenantConfig } from './resolver.js';
import { assertSafeProviderUrl } from './url-guard.js';

const TENANT = '9a2f7ed4-1fe4-4f8c-8d63-008450000002';

function platformConfig(): LlmPlatformConfig {
  return {
    provider_id: 'platform-openai',
    base_url: 'https://api.example.com/v1',
    reasoning_model: 'platform-reasoning',
    fast_model: 'platform-fast',
    timeout_ms: 30_000,
    structured_mode: 'json_schema',
    secret_id: 'platform-secret',
    config_version: '2',
  };
}

function tenantConfig(overrides: Partial<LlmTenantConfig> = {}): LlmTenantConfig {
  return {
    mode: 'CUSTOM',
    provider_id: 'tenant-custom-provider',
    base_url: 'https://tenant.example/v1',
    reasoning_model: 'tenant-reasoning',
    fast_model: 'tenant-fast',
    timeout_ms: 20_000,
    structured_mode: 'json_object',
    secret_id: 'tenant-secret',
    config_version: '7',
    ...overrides,
  };
}

function secretResolver() {
  return {
    resolve: vi.fn(async (_tenant_id: string, secret_id: string) => `tenant-key:${secret_id}`),
    resolvePlatform: vi.fn(async (secret_id: string) => `platform-key:${secret_id}`),
  };
}

describe('assertSafeProviderUrl', () => {
  it.each([
    'http://api.example.com/v1',
    'https://127.0.0.1/v1',
    'https://10.0.0.8/v1',
    'https://169.254.169.254/latest',
    'https://[::1]/v1',
    'https://[fe80::1]/v1',
    'https://provider.local/v1',
  ])('refuses unsafe provider URL %s', (url) => {
    expect(() => assertSafeProviderUrl(url)).toThrow();
  });

  it('accepts a public HTTPS provider endpoint', () => {
    expect(() => assertSafeProviderUrl('https://api.example.com/v1')).not.toThrow();
  });
});

describe('LlmConfigResolver', () => {
  it('selects a custom tenant override before the platform default and resolves only the tenant secret', async () => {
    const tenant = tenantConfig();
    const platform = platformConfig();
    const configs = {
      getTenantOverride: vi.fn(async () => tenant),
      getPlatformDefault: vi.fn(async () => platform),
    };
    const secrets = secretResolver();
    const resolver = new LlmConfigResolver(configs, secrets, {});

    const resolved = await resolver.resolve(TENANT);

    expect(resolved).toMatchObject({
      provider_id: 'tenant-custom-provider',
      reasoning_model: 'tenant-reasoning',
      api_key: 'tenant-key:tenant-secret',
      config_version: '7',
      source: 'TENANT',
    });
    expect(secrets.resolve).toHaveBeenCalledWith(TENANT, 'tenant-secret');
    expect(secrets.resolvePlatform).not.toHaveBeenCalled();
  });

  it('uses platform provider credentials when no tenant override is active', async () => {
    const configs = {
      getTenantOverride: vi.fn(async () => tenantConfig({ mode: 'INHERIT' })),
      getPlatformDefault: vi.fn(async () => platformConfig()),
    };
    const secrets = secretResolver();
    const resolver = new LlmConfigResolver(configs, secrets, {});

    const resolved = await resolver.resolve(TENANT);

    expect(resolved).toMatchObject({ source: 'PLATFORM', api_key: 'platform-key:platform-secret' });
    expect(secrets.resolvePlatform).toHaveBeenCalledWith('platform-secret');
  });

  it('imports environment configuration as ENV only when database rows are absent', async () => {
    const configs = {
      getTenantOverride: vi.fn(async () => null),
      getPlatformDefault: vi.fn(async () => null),
    };
    const secrets = secretResolver();
    const resolver = new LlmConfigResolver(configs, secrets, {
      OPENAI_API_KEY: ' env-secret ',
      PRIMARY_REASONING_MODEL: ' reasoning-model ',
      FAST_COMPLETION_MODEL: ' fast-model ',
      OPENAI_BASE_URL: ' https://api.example.com/v1/ ',
      LLM_REQUEST_TIMEOUT_MS: '45000',
      OPENAI_STRUCTURED_OUTPUT_MODE: 'json_schema',
    });

    const resolved = await resolver.resolve(TENANT);

    expect(resolved).toMatchObject({
      source: 'ENV',
      api_key: 'env-secret',
      base_url: 'https://api.example.com/v1',
      reasoning_model: 'reasoning-model',
      fast_model: 'fast-model',
      timeout_ms: 45_000,
      structured_mode: 'json_schema',
      config_version: 'ENV',
    });
    expect(secrets.resolve).not.toHaveBeenCalled();
  });

  it('caches resolved secrets only until the configured TTL expires', async () => {
    const configs = {
      getTenantOverride: vi.fn(async () => tenantConfig()),
      getPlatformDefault: vi.fn(async () => null),
    };
    const secrets = secretResolver();
    let now = 1_000;
    const resolver = new LlmConfigResolver(configs, secrets, {}, { now: () => now, ttl_ms: 30_000 });

    await resolver.resolve(TENANT);
    now += 29_999;
    await resolver.resolve(TENANT);
    expect(secrets.resolve).toHaveBeenCalledTimes(1);
    now += 1;
    await resolver.resolve(TENANT);
    expect(secrets.resolve).toHaveBeenCalledTimes(2);
  });
});
