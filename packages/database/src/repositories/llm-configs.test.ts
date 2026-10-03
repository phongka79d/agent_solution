import type { PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { LlmConfigRepository, type PlatformLlmProviderRecord, type TenantLlmConfigRecord } from './llm-configs.js';
import { appendConfigAudit } from './platform-audit.js';

vi.mock('./platform-audit.js', () => ({ appendConfigAudit: vi.fn(async () => 'audit-event') }));

const TENANT = '9a2f7ed4-1fe4-4f8c-8d63-008450000002';
const ACTOR = { actor_kind: 'OPERATOR', actor_id: 'operator-1', correlation_id: 'corr-1', reason: 'rotate provider' };
const DATE = new Date('2026-10-01T00:00:00.000Z');

function platformRow(): PlatformLlmProviderRecord {
  return {
    provider_id: 'primary',
    display_name: 'Primary provider',
    base_url: 'https://api.example.com/v1',
    reasoning_model: 'reasoning-v2',
    fast_model: 'fast-v2',
    timeout_ms: 30_000,
    structured_mode: 'json_schema',
    secret_id: 'secret-platform-1',
    status: 'CONFIGURED',
    is_default: true,
    config_version: '2',
    updated_at: DATE.toISOString(),
  };
}

function tenantRow(): TenantLlmConfigRecord {
  return {
    tenant_id: TENANT,
    provider_id: 'tenant-custom-provider',
    mode: 'CUSTOM',
    base_url: 'https://tenant-provider.example/v1',
    reasoning_model: 'tenant-reasoning',
    fast_model: 'tenant-fast',
    timeout_ms: 20_000,
    structured_mode: 'json_object',
    secret_id: 'tenant-secret-1',
    monthly_token_budget: 2_000_000,
    config_version: '4',
    updated_at: DATE.toISOString(),
  };
}

function platformDbRow(): Record<string, unknown> {
  return { ...platformRow(), config_version: '2', updated_at: DATE };
}

function tenantDbRow(): Record<string, unknown> {
  return { ...tenantRow(), monthly_token_budget: '2000000', updated_at: DATE };
}

describe('LlmConfigRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('writes platform provider references and its redacted audit in the same platform transaction', async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes('WHERE provider_id = $1')) return { rows: [] };
      if (sql.includes('INSERT INTO agentos.platform_llm_providers')) return { rows: [platformDbRow()] };
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;
    const platformTransaction = async <T>(work: (client: PoolClient) => Promise<T>): Promise<T> => work(client);
    const repository = new LlmConfigRepository({ platformTransaction });

    const saved = await repository.upsertPlatformProvider({
      provider_id: 'primary',
      display_name: 'Primary provider',
      base_url: 'https://api.example.com/v1',
      reasoning_model: 'reasoning-v2',
      fast_model: 'fast-v2',
      timeout_ms: 30_000,
      structured_mode: 'json_schema',
      secret_id: 'secret-platform-1',
      is_default: true,
    }, ACTOR);

    expect(saved).toEqual(platformRow());
    expect(query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO agentos.platform_llm_providers'))).toBe(true);
    expect(query.mock.calls.flatMap(([, values]) => values ?? [])).not.toContain('plaintext-api-key');
    const platformAudit = vi.mocked(appendConfigAudit).mock.calls[0]?.[1];
    expect(platformAudit).toMatchObject({
      action: 'llm.provider.upsert',
      after: expect.objectContaining({ credential_configured: true }),
    });
    expect(JSON.stringify(platformAudit?.after)).not.toMatch(/"[^"]*(?:secret|password|api_key|token|private_key|plaintext)[^"]*"\s*:/i);
  });

  it('accepts the host-docker local provider endpoint already allowed by the platform route', async () => {
    const previousAppEnv = process.env.APP_ENV;
    process.env.APP_ENV = 'ci';
    try {
      const localBaseUrl = 'http://host.docker.internal:43124/v1';
      const query = vi.fn(async (sql: string) => {
        if (sql.includes('WHERE provider_id = $1')) return { rows: [] };
        if (sql.includes('INSERT INTO agentos.platform_llm_providers')) {
          return { rows: [{ ...platformDbRow(), base_url: localBaseUrl, is_default: false }] };
        }
        return { rows: [] };
      });
      const client = { query } as unknown as PoolClient;
      const repository = new LlmConfigRepository({
        platformTransaction: async (work) => work(client),
      });
      const saved = await repository.upsertPlatformProvider({
        provider_id: 'local-stub',
        display_name: 'Local stub',
        base_url: localBaseUrl,
        reasoning_model: 'llm-stub',
        fast_model: 'llm-stub',
        timeout_ms: 5000,
        structured_mode: 'json_object',
        secret_id: 'secret-platform-1',
        is_default: false,
      }, ACTOR);

      expect(saved.base_url).toBe(localBaseUrl);
      await expect(repository.upsertPlatformProvider({
        provider_id: 'unsafe-http',
        display_name: 'Unsafe HTTP',
        base_url: 'http://example.com/v1',
        reasoning_model: 'llm-stub',
        fast_model: 'llm-stub',
        timeout_ms: 5000,
        structured_mode: 'json_object',
        secret_id: 'secret-platform-1',
        is_default: false,
      }, ACTOR)).rejects.toThrow('LLM_CONFIG_INVALID');
    } finally {
      if (previousAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = previousAppEnv;
    }
  });

  it('stores a tenant override under its tenant transaction and returns the persisted version', async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.startsWith('SELECT')) return { rows: [] };
      if (sql.includes('INSERT INTO agentos.tenant_llm_configs')) return { rows: [tenantDbRow()] };
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;
    const tenantTransactions: string[] = [];
    const tenantTransaction = async <T>(tenant_id: string, work: (client: PoolClient) => Promise<T>): Promise<T> => {
      tenantTransactions.push(tenant_id);
      return work(client);
    };
    const repository = new LlmConfigRepository({ tenantTransaction });

    const saved = await repository.putTenantOverride(TENANT, {
      mode: 'CUSTOM',
      provider_id: 'tenant-custom-provider',
      base_url: 'https://tenant-provider.example/v1',
      reasoning_model: 'tenant-reasoning',
      fast_model: 'tenant-fast',
      timeout_ms: 20_000,
      structured_mode: 'json_object',
      secret_id: 'tenant-secret-1',
      monthly_token_budget: 2_000_000,
    }, ACTOR);

    expect(tenantTransactions).toEqual([TENANT]);
    expect(saved).toEqual(tenantRow());
    expect(query.mock.calls.at(-1)?.[1]).toEqual([
      TENANT, 'CUSTOM', 'tenant-custom-provider', 'https://tenant-provider.example/v1',
      'tenant-reasoning', 'tenant-fast', 20_000, 'json_object', 'tenant-secret-1', 2_000_000,
    ]);
    expect(appendConfigAudit).toHaveBeenCalledWith(client, expect.objectContaining({
      scope: 'company.llm',
      target_tenant: TENANT,
      action: 'llm.config.update',
    }));
    const tenantAudit = vi.mocked(appendConfigAudit).mock.calls[0]?.[1];
    expect(tenantAudit?.after).toMatchObject({ credential_configured: true });
    expect(JSON.stringify(tenantAudit?.after)).not.toMatch(/"[^"]*(?:secret|password|api_key|token|private_key|plaintext)[^"]*"\s*:/i);
  });

  it('records a sanitized probe result in the selected tenant scope', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const client = { query } as unknown as PoolClient;
    const repository = new LlmConfigRepository({
      tenantTransaction: async (_tenant_id, work) => work(client),
    });

    await repository.recordProbe({ kind: 'TENANT', tenant_id: TENANT, provider_id: 'primary' }, {
      outcome: 'FAIL', latency_ms: 75, http_status: 401, error_class: 'AUTHENTICATION',
    });

    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO agentos.llm_probe_results'), [
      'TENANT', TENANT, 'primary', 'FAIL', 75, 401, 'AUTHENTICATION',
    ]);
  });

  it('lists platform providers with the persisted last probe and the credential handle only', async () => {
    const listed = {
      ...platformDbRow(),
      secret_fingerprint: 'c'.repeat(64),
      secret_last4: '1234',
      probe_outcome: 'FAIL',
      probe_latency_ms: 812,
      probe_http_status: 503,
      probe_error_class: 'PROVIDER_UNAVAILABLE',
      probed_at: DATE,
    };
    const query = vi.fn(async () => ({ rows: [listed] }));
    const client = { query } as unknown as PoolClient;
    const repository = new LlmConfigRepository({ platformTransaction: async (work) => work(client) });

    const providers = await repository.listPlatformProviders();

    expect(providers).toHaveLength(1);
    const provider = providers[0]!;
    expect(provider.provider_id).toBe('primary');
    expect(provider.secret_fingerprint).toBe('c'.repeat(64));
    expect(provider.secret_last4).toBe('1234');
    expect(provider.last_probe).toEqual({
      outcome: 'FAIL',
      latency_ms: 812,
      http_status: 503,
      error_class: 'PROVIDER_UNAVAILABLE',
      probed_at: DATE.toISOString(),
    });
    // Never the plaintext: neither the api_key nor an unreadable blob crosses the boundary.
    expect(Object.keys(provider)).not.toContain('api_key');
    const [sql] = query.mock.calls[0] as unknown as [string];
    expect(sql).toContain('agentos.llm_probe_results');
    expect(sql).toContain('agentos.platform_secrets');
  });

  it('omits the last probe for a provider that has never been probed', async () => {
    const query = vi.fn(async () => ({
      rows: [{ ...platformDbRow(), secret_fingerprint: null, secret_last4: null, probe_outcome: null, probe_latency_ms: null, probe_http_status: null, probe_error_class: null, probed_at: null }],
    }));
    const client = { query } as unknown as PoolClient;
    const repository = new LlmConfigRepository({ platformTransaction: async (work) => work(client) });

    const providers = await repository.listPlatformProviders();

    expect(providers[0]?.last_probe).toBeNull();
    expect(providers[0]?.secret_fingerprint).toBeNull();
  });
});
