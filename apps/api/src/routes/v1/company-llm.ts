import type { FastifyInstance } from 'fastify';

import { assertSafeProviderUrl } from '@agentos/core-engine';
import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import { correlationIdOf, fail } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';

export interface LlmProbeView {
  readonly outcome: 'PASS' | 'FAIL';
  readonly latency_ms: number | null;
  readonly http_status: number | null;
  readonly error_class: string | null;
}

export interface LlmProviderView {
  readonly provider_id: string;
  readonly display_name: string;
  readonly base_url: string;
  readonly reasoning_model: string;
  readonly fast_model: string;
  readonly timeout_ms: number;
  readonly structured_mode: 'json_object' | 'json_schema';
  readonly status: 'CONFIGURED' | 'VERIFIED' | 'FAILED';
  readonly is_default: boolean;
  readonly secret_configured: boolean;
  readonly config_version: string;
  readonly updated_at: string;
}

/** A stored probe as the provider list surfaces it: sanitized result plus when it ran. */
export interface PersistedLlmProbeView extends LlmProbeView {
  readonly probed_at: string;
}

/** A platform provider listing adds the persisted last probe and the credential handle. */
export interface PlatformLlmProviderView extends LlmProviderView {
  readonly last_probe: PersistedLlmProbeView | null;
  readonly secret_fingerprint: string | null;
  readonly secret_last4: string | null;
}

export interface CompanyLlmView {
  readonly tenant_id: string;
  readonly mode: 'INHERIT' | 'CUSTOM';
  readonly provider_id: string | null;
  readonly base_url: string | null;
  readonly reasoning_model: string | null;
  readonly fast_model: string | null;
  readonly timeout_ms: number | null;
  readonly structured_mode: 'json_object' | 'json_schema' | null;
  readonly monthly_token_budget: number | null;
  readonly secret_configured: boolean;
  readonly config_version: string | null;
  readonly updated_at: string | null;
  readonly effective: Omit<LlmProviderView, 'status' | 'is_default' | 'config_version' | 'updated_at'> | null;
}

export interface LlmConfigurationPort {
  listPlatformProviders(): Promise<readonly PlatformLlmProviderView[]>;
  upsertPlatformProvider(input: {
    readonly provider_id: string;
    readonly display_name: string;
    readonly base_url: string;
    readonly reasoning_model: string;
    readonly fast_model: string;
    readonly timeout_ms: number;
    readonly structured_mode: 'json_object' | 'json_schema';
    readonly is_default: boolean;
    readonly api_key: string | null;
  }, actor: { readonly actor_kind: string; readonly actor_id: string; readonly correlation_id: string; readonly reason?: string | null }): Promise<LlmProviderView>;
  probePlatformProvider(provider_id: string): Promise<LlmProbeView>;
  getCompanyConfig(tenant_id: string): Promise<CompanyLlmView>;
  putCompanyConfig(tenant_id: string, input: {
    readonly mode: 'INHERIT' | 'CUSTOM';
    readonly provider_id?: string | null;
    readonly base_url?: string | null;
    readonly reasoning_model?: string | null;
    readonly fast_model?: string | null;
    readonly timeout_ms?: number | null;
    readonly structured_mode?: 'json_object' | 'json_schema' | null;
    readonly monthly_token_budget?: number | null;
    readonly api_key?: string | null;
  }, actor: { readonly actor_kind: string; readonly actor_id: string; readonly correlation_id: string }): Promise<CompanyLlmView>;
  probeCompanyConfig(tenant_id: string): Promise<LlmProbeView>;
}

const PROBE_INTERVAL_MS = 10_000;
const lastProbeAt = new Map<string, number>();

export function probeRateLimit(
  runtime: GatewayRuntime,
  scope: { readonly kind: 'company'; readonly tenant_id: string } | { readonly kind: 'platform' },
): void {
  const now = runtime.clock().getTime();
  for (const [key, timestamp] of lastProbeAt) {
    if (now - timestamp >= PROBE_INTERVAL_MS) lastProbeAt.delete(key);
  }
  const key = scope.kind === 'platform' ? 'platform' : `company:${scope.tenant_id}`;
  const previous = lastProbeAt.get(key);
  if (previous !== undefined && now - previous < PROBE_INTERVAL_MS) {
    fail('RATE_LIMITED', 'LLM provider tests are limited to one attempt per scope every 10 seconds.');
  }
  lastProbeAt.set(key, now);
}

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('VALIDATION_FAILED', 'A JSON object is required.');
  return value as Record<string, unknown>;
}

type CompanyLlmInput = Parameters<LlmConfigurationPort['putCompanyConfig']>[1];

function readBudget(value: unknown): { monthly_token_budget?: number | null } {
  if (value === undefined) return {};
  if (value === null) return { monthly_token_budget: null };
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    fail('VALIDATION_FAILED', 'monthly_token_budget must be a positive integer.');
  }
  return { monthly_token_budget: value };
}

function readApiKey(value: unknown): { api_key?: string } {
  if (value === undefined) return {};
  if (typeof value !== 'string' || value.trim().length === 0) {
    fail('VALIDATION_FAILED', 'api_key must be a non-empty string when provided.');
  }
  return { api_key: value };
}

function validateCompanyInput(body: Record<string, unknown>, appEnv: string | undefined): CompanyLlmInput {
  if (body.mode !== 'INHERIT' && body.mode !== 'CUSTOM') fail('VALIDATION_FAILED', 'mode must be INHERIT or CUSTOM.');
  const apiKey = readApiKey(body.api_key);
  const budget = readBudget(body.monthly_token_budget);
  if (body.mode === 'INHERIT') {
    return { mode: 'INHERIT', ...budget };
  }
  const { provider_id, base_url, reasoning_model, fast_model, timeout_ms, structured_mode } = body;
  if (typeof provider_id !== 'string' || provider_id.length < 1 || provider_id.length > 128
    || typeof base_url !== 'string' || typeof reasoning_model !== 'string' || typeof fast_model !== 'string'
    || typeof timeout_ms !== 'number' || !Number.isSafeInteger(timeout_ms) || timeout_ms < 1000 || timeout_ms > 120000
    || (structured_mode !== 'json_object' && structured_mode !== 'json_schema')) {
    fail('VALIDATION_FAILED', 'Custom LLM configuration is incomplete or invalid.');
  }
  try {
    assertSafeProviderUrl(base_url, appEnv);
  } catch {
    fail('VALIDATION_FAILED', 'base_url is not an allowed provider URL.');
  }
  return {
    mode: 'CUSTOM',
    provider_id,
    base_url,
    reasoning_model,
    fast_model,
    timeout_ms,
    structured_mode,
    ...budget,
    ...apiKey,
  };
}

export function registerCompanyLlmRoutes(
  app: FastifyInstance,
  deps: { readonly runtime: GatewayRuntime; readonly credentials: CredentialStore; readonly llmConfiguration: LlmConfigurationPort; readonly env?: () => Readonly<Record<string, string | undefined>> },
): void {
  const preHandler = authenticate(deps);
  app.get('/company/settings/llm', { preHandler }, async (request) => {
    const principal = requireOperator(request, 'llm:manage');
    return deps.llmConfiguration.getCompanyConfig(principal.tenant_id);
  });
  app.put('/company/settings/llm', { preHandler }, async (request) => {
    const principal = requireOperator(request, 'llm:manage');
    const actor_id = principal.operator_id;
    if (actor_id === undefined) fail('AUTHENTICATION_FAILED', 'Operator identity is required.');
    const env = deps.env?.() ?? process.env;
    const input = validateCompanyInput(objectBody(request.body), env.APP_ENV);
    return deps.llmConfiguration.putCompanyConfig(principal.tenant_id, input, {
      actor_kind: 'OPERATOR', actor_id, correlation_id: correlationIdOf(request, deps.runtime),
    });
  });
  app.post('/company/settings/llm/test', { preHandler }, async (request) => {
    const principal = requireOperator(request, 'llm:manage');
    probeRateLimit(deps.runtime, { kind: 'company', tenant_id: principal.tenant_id });
    return deps.llmConfiguration.probeCompanyConfig(principal.tenant_id);
  });
}
