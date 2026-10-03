import { probeLlmProvider } from '@agentos/adapters';
import type {
  LlmConfigActor,
  LlmConfigRepository,
  LlmProbeResult,
  PlatformLlmProviderListing,
  PlatformLlmProviderRecord,
  SecretRepository,
  TenantLlmConfigRecord,
} from '@agentos/database';
import { assertSafeProviderUrl, type SecretResolver } from '@agentos/core-engine';

import type {
  CompanyLlmView,
  LlmConfigurationPort,
  LlmProbeView,
  LlmProviderView,
  PlatformLlmProviderView,
} from '../../routes/v1/company-llm.js';

const PROBE_TIMEOUT_MS = 10_000;
const MISSING_SECRET_PROBE: LlmProbeResult = {
  outcome: 'FAIL',
  latency_ms: null,
  http_status: null,
  error_class: 'SECRET_NOT_CONFIGURED',
};

function platformProviderView(record: PlatformLlmProviderRecord): LlmProviderView {
  return {
    provider_id: record.provider_id,
    display_name: record.display_name,
    base_url: record.base_url,
    reasoning_model: record.reasoning_model,
    fast_model: record.fast_model,
    timeout_ms: record.timeout_ms,
    structured_mode: record.structured_mode,
    status: record.status,
    is_default: record.is_default,
    secret_configured: record.secret_id !== null,
    config_version: record.config_version,
    updated_at: record.updated_at,
  };
}

function platformProviderListingView(record: PlatformLlmProviderListing): PlatformLlmProviderView {
  return {
    ...platformProviderView(record),
    last_probe: record.last_probe === null
      ? null
      : {
          outcome: record.last_probe.outcome,
          latency_ms: record.last_probe.latency_ms,
          http_status: record.last_probe.http_status,
          error_class: record.last_probe.error_class,
          probed_at: record.last_probe.probed_at,
        },
    secret_fingerprint: record.secret_fingerprint,
    secret_last4: record.secret_last4,
  };
}

function effectivePlatformProvider(record: PlatformLlmProviderRecord): NonNullable<CompanyLlmView['effective']> {
  return {
    provider_id: record.provider_id,
    display_name: record.display_name,
    base_url: record.base_url,
    reasoning_model: record.reasoning_model,
    fast_model: record.fast_model,
    timeout_ms: record.timeout_ms,
    structured_mode: record.structured_mode,
    secret_configured: record.secret_id !== null,
  };
}

function effectiveTenantProvider(record: TenantLlmConfigRecord): NonNullable<CompanyLlmView['effective']> | null {
  if (
    record.mode !== 'CUSTOM' || record.provider_id === null || record.base_url === null
    || record.reasoning_model === null || record.fast_model === null || record.timeout_ms === null
    || record.structured_mode === null
  ) return null;
  return {
    provider_id: record.provider_id,
    display_name: record.provider_id,
    base_url: record.base_url,
    reasoning_model: record.reasoning_model,
    fast_model: record.fast_model,
    timeout_ms: record.timeout_ms,
    structured_mode: record.structured_mode,
    secret_configured: record.secret_id !== null,
  };
}

function companyView(
  tenant_id: string,
  tenant: TenantLlmConfigRecord | null,
  platform: PlatformLlmProviderRecord | null,
): CompanyLlmView {
  const mode = tenant?.mode ?? 'INHERIT';
  return {
    tenant_id,
    mode,
    provider_id: tenant?.provider_id ?? null,
    base_url: tenant?.base_url ?? null,
    reasoning_model: tenant?.reasoning_model ?? null,
    fast_model: tenant?.fast_model ?? null,
    timeout_ms: tenant?.timeout_ms ?? null,
    structured_mode: tenant?.structured_mode ?? null,
    monthly_token_budget: tenant?.monthly_token_budget ?? null,
    secret_configured: mode === 'CUSTOM' && tenant?.secret_id != null,
    config_version: tenant?.config_version ?? null,
    updated_at: tenant?.updated_at ?? null,
    effective: mode === 'CUSTOM'
      ? tenant === null ? null : effectiveTenantProvider(tenant)
      : platform === null ? null : effectivePlatformProvider(platform),
  };
}

function failedProbe(error_class: string): LlmProbeResult {
  return { outcome: 'FAIL', latency_ms: null, http_status: null, error_class };
}

export function createLlmConfigurationPort(input: {
  readonly configurations: LlmConfigRepository;
  readonly secrets: SecretRepository;
  readonly secretResolver: SecretResolver;
}): LlmConfigurationPort {
  const { configurations, secrets, secretResolver } = input;

  async function runProbe(
    target: { readonly base_url: string; readonly fast_model: string; readonly secret_id: string | null },
    resolveApiKey: (secret_id: string) => Promise<string>,
    scope: { readonly kind: 'PLATFORM'; readonly provider_id: string }
      | { readonly kind: 'TENANT'; readonly tenant_id: string; readonly provider_id: string },
  ): Promise<LlmProbeView> {
    let result = MISSING_SECRET_PROBE;
    if (target.secret_id !== null) {
      try {
        result = await probeLlmProvider({
          base_url: target.base_url,
          api_key: await resolveApiKey(target.secret_id),
          model: target.fast_model,
          assertSafeProviderUrl,
          timeoutMs: PROBE_TIMEOUT_MS,
        });
      } catch {
        result = failedProbe('SECRET_UNAVAILABLE');
      }
    }
    await configurations.recordProbe(scope, result);
    return result;
  }

  return {
    listPlatformProviders: async () => (await configurations.listPlatformProviders()).map(platformProviderListingView),

    async upsertPlatformProvider(provider, actor) {
      const previous = await configurations.getPlatformProvider(provider.provider_id);
      const secret_id = provider.api_key === null
        ? previous?.secret_id ?? null
        : (await secrets.putPlatform({
            purpose: `llm-provider:${provider.provider_id}`,
            plaintext: provider.api_key,
            ...actor,
          })).secret_id;
      const record = await configurations.upsertPlatformProvider({
        provider_id: provider.provider_id,
        display_name: provider.display_name,
        base_url: provider.base_url,
        reasoning_model: provider.reasoning_model,
        fast_model: provider.fast_model,
        timeout_ms: provider.timeout_ms,
        structured_mode: provider.structured_mode,
        secret_id,
        status: 'CONFIGURED',
        is_default: provider.is_default,
      }, actor);
      return platformProviderView(record);
    },

    async probePlatformProvider(provider_id) {
      const provider = await configurations.getPlatformProvider(provider_id);
      if (provider === null) return failedProbe('NOT_CONFIGURED');
      return runProbe(
        provider,
        (secret_id) => secretResolver.resolvePlatform(secret_id),
        { kind: 'PLATFORM', provider_id },
      );
    },

    async getCompanyConfig(tenant_id) {
      const [tenant, platform] = await Promise.all([
        configurations.getTenantOverride(tenant_id),
        configurations.getPlatformDefault(),
      ]);
      return companyView(tenant_id, tenant, platform);
    },

    async putCompanyConfig(tenant_id, config, actor) {
      const previous = await configurations.getTenantOverride(tenant_id);
      let secret_id: string | null = null;
      if (config.mode === 'CUSTOM') {
        if (config.api_key !== undefined && config.api_key !== null) {
          secret_id = (await secrets.put(tenant_id, {
            purpose: 'llm-provider',
            plaintext: config.api_key,
            ...actor,
          })).secret_id;
        } else if (previous?.mode === 'CUSTOM') {
          secret_id = previous.secret_id;
        }
      }
      const record = await configurations.putTenantOverride(tenant_id, {
        mode: config.mode,
        ...(config.mode === 'CUSTOM' ? {
          provider_id: config.provider_id,
          base_url: config.base_url,
          reasoning_model: config.reasoning_model,
          fast_model: config.fast_model,
          timeout_ms: config.timeout_ms,
          structured_mode: config.structured_mode,
          secret_id,
        } : {}),
        ...(config.monthly_token_budget === undefined ? {} : { monthly_token_budget: config.monthly_token_budget }),
      }, actor as LlmConfigActor);
      if (previous?.secret_id !== null && previous?.secret_id !== undefined && previous.secret_id !== record.secret_id) {
        await secrets.revoke(tenant_id, previous.secret_id, actor);
      }
      const platform = await configurations.getPlatformDefault();
      return companyView(tenant_id, record, platform);
    },

    async probeCompanyConfig(tenant_id) {
      const tenant = await configurations.getTenantOverride(tenant_id);
      if (tenant?.mode === 'CUSTOM') {
        if (
          tenant.provider_id === null || tenant.base_url === null || tenant.fast_model === null
          || tenant.timeout_ms === null
        ) return failedProbe('NOT_CONFIGURED');
        return runProbe(
          { base_url: tenant.base_url, fast_model: tenant.fast_model, secret_id: tenant.secret_id },
          (secret_id) => secretResolver.resolve(tenant_id, secret_id),
          { kind: 'TENANT', tenant_id, provider_id: tenant.provider_id },
        );
      }
      const platform = await configurations.getPlatformDefault();
      if (platform === null) return failedProbe('NOT_CONFIGURED');
      return runProbe(
        platform,
        (secret_id) => secretResolver.resolvePlatform(secret_id),
        { kind: 'TENANT', tenant_id, provider_id: platform.provider_id },
      );
    },
  };
}
