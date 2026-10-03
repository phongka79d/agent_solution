import { assertSafeProviderUrl } from './url-guard.js';

export interface ResolvedLlmConfig {
  readonly provider_id: string;
  readonly base_url: string;
  readonly reasoning_model: string;
  readonly fast_model: string;
  readonly timeout_ms: number;
  readonly structured_mode: 'json_object' | 'json_schema';
  readonly api_key: string;
  readonly config_version: string;
  readonly source: 'PLATFORM' | 'TENANT' | 'ENV';
}

export interface LlmTenantConfig {
  readonly mode: 'INHERIT' | 'CUSTOM';
  readonly provider_id: string | null;
  readonly base_url: string | null;
  readonly reasoning_model: string | null;
  readonly fast_model: string | null;
  readonly timeout_ms: number | null;
  readonly structured_mode: 'json_object' | 'json_schema' | null;
  readonly secret_id: string | null;
  readonly config_version: string;
}

export interface LlmPlatformConfig {
  readonly provider_id: string;
  readonly base_url: string;
  readonly reasoning_model: string;
  readonly fast_model: string;
  readonly timeout_ms: number;
  readonly structured_mode: 'json_object' | 'json_schema';
  readonly secret_id: string | null;
  readonly config_version: string;
}

export interface LlmConfigReader {
  getTenantOverride(tenant_id: string): Promise<LlmTenantConfig | null>;
  getPlatformDefault(): Promise<LlmPlatformConfig | null>;
}

export interface LlmSecretResolver {
  resolve(tenant_id: string, secret_id: string): Promise<string>;
  resolvePlatform?(secret_id: string): Promise<string>;
}

export interface LlmConfigResolverOptions {
  /** Cache duration is capped at the contract maximum of 30 seconds. */
  readonly ttl_ms?: number;
  readonly now?: () => number;
}

interface CacheEntry {
  readonly expires_at: number;
  readonly config: ResolvedLlmConfig | null;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_PROVIDER_URL = 'https://api.openai.com/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 86_400_000;

/** Resolves tenant override, platform default, then the boot environment snapshot. */
export class LlmConfigResolver {
  private readonly ttl_ms: number;
  private readonly now: () => number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(
    private readonly configs: LlmConfigReader,
    private readonly secrets: LlmSecretResolver,
    env: Readonly<Record<string, string | undefined>> = process.env,
    options: LlmConfigResolverOptions = {},
  ) {
    this.ttl_ms = Math.min(options.ttl_ms ?? DEFAULT_TTL_MS, DEFAULT_TTL_MS);
    if (!Number.isSafeInteger(this.ttl_ms) || this.ttl_ms <= 0) {
      throw new TypeError('LLM_CONFIG_CACHE_TTL_INVALID: ttl_ms must be between 1 and 30000.');
    }
    this.now = options.now ?? Date.now;
    this.env = { ...env };
  }

  async resolve(tenant_id: string): Promise<ResolvedLlmConfig | null> {
    const [tenant, platform] = await Promise.all([
      this.configs.getTenantOverride(tenant_id),
      this.configs.getPlatformDefault(),
    ]);
    const customTenant = tenant?.mode === 'CUSTOM' ? tenant : null;
    const version = customTenant === null
      ? platform === null ? 'env' : `platform:${platform.provider_id}:${platform.config_version}`
      : `tenant:${customTenant.config_version}`;
    const cacheKey = `${tenant_id}\u0000${version}`;
    const now = this.now();
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && cached.expires_at > now) return cached.config;

    const config = customTenant !== null
      ? await this.fromTenant(tenant_id, customTenant)
      : platform !== null
        ? await this.fromPlatform(platform)
        : this.fromEnvironment();
    this.cache.set(cacheKey, { expires_at: now + this.ttl_ms, config });
    if (this.cache.size > 256) {
      for (const [key, entry] of this.cache) {
        if (entry.expires_at <= now) this.cache.delete(key);
      }
    }
    return config;
  }

  private async fromTenant(tenant_id: string, config: LlmTenantConfig): Promise<ResolvedLlmConfig | null> {
    if (
      config.provider_id === null || config.base_url === null || config.reasoning_model === null
      || config.fast_model === null || config.timeout_ms === null || config.structured_mode === null
      || config.secret_id === null
    ) return null;
    assertSafeProviderUrl(config.base_url);
    return {
      provider_id: config.provider_id,
      base_url: config.base_url,
      reasoning_model: config.reasoning_model,
      fast_model: config.fast_model,
      timeout_ms: config.timeout_ms,
      structured_mode: config.structured_mode,
      api_key: await this.secrets.resolve(tenant_id, config.secret_id),
      config_version: config.config_version,
      source: 'TENANT',
    };
  }

  private async fromPlatform(config: LlmPlatformConfig): Promise<ResolvedLlmConfig | null> {
    if (config.secret_id === null) return null;
    assertSafeProviderUrl(config.base_url);
    if (this.secrets.resolvePlatform === undefined) throw new Error('PLATFORM_SECRET_RESOLVER_UNAVAILABLE');
    return {
      provider_id: config.provider_id,
      base_url: config.base_url,
      reasoning_model: config.reasoning_model,
      fast_model: config.fast_model,
      timeout_ms: config.timeout_ms,
      structured_mode: config.structured_mode,
      api_key: await this.secrets.resolvePlatform(config.secret_id),
      config_version: config.config_version,
      source: 'PLATFORM',
    };
  }

  private fromEnvironment(): ResolvedLlmConfig | null {
    const offlineDemo = this.env.DEMO_MODE === 'true'
      && this.env.DEMO_PROVIDER_MODE?.trim().toLowerCase() === 'offline'
      && (this.env.APP_ENV === 'local' || this.env.APP_ENV === 'ci');
    const api_key = this.env.OPENAI_API_KEY?.trim();
    const reasoning_model = this.env.PRIMARY_REASONING_MODEL?.trim();
    if (offlineDemo || !api_key || !reasoning_model) return null;

    const timeoutRaw = this.env.LLM_REQUEST_TIMEOUT_MS;
    const parsedTimeout = timeoutRaw === undefined ? DEFAULT_TIMEOUT_MS : Number(timeoutRaw);
    if (!Number.isSafeInteger(parsedTimeout) || parsedTimeout <= 0) {
      throw new TypeError('LLM_REQUEST_TIMEOUT_MS must be a positive integer number of milliseconds.');
    }
    const structured_mode = this.env.OPENAI_STRUCTURED_OUTPUT_MODE === 'json_schema' ? 'json_schema' : 'json_object';
    const fast_model = this.env.FAST_COMPLETION_MODEL?.trim() || reasoning_model;
    const base_url = (this.env.OPENAI_BASE_URL?.trim() || DEFAULT_PROVIDER_URL).replace(/\/+$/, '');
    assertSafeProviderUrl(base_url, this.env.APP_ENV);
    return {
      provider_id: 'openai-compatible',
      base_url,
      reasoning_model,
      fast_model,
      timeout_ms: Math.min(parsedTimeout, MAX_TIMEOUT_MS),
      structured_mode,
      api_key,
      config_version: 'ENV',
      source: 'ENV',
    };
  }
}
