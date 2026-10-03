import type { FastifyInstance, FastifyRequest } from 'fastify';

import { assertSafeProviderUrl } from '@agentos/core-engine';
import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import { correlationIdOf, fail } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { probeRateLimit, type LlmConfigurationPort } from './company-llm.js';

function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('VALIDATION_FAILED', 'A JSON object is required.');
  return value as Record<string, unknown>;
}

function providerId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    fail('VALIDATION_FAILED', 'provider id is invalid.');
  }
  return value;
}

/** Optional operator rationale; when present it is recorded on the audit event. */
function providerReason(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) {
    fail('VALIDATION_FAILED', 'reason must be a non-empty string of at most 512 characters.');
  }
  return value;
}

export function registerPlatformProviderRoutes(
  app: FastifyInstance,
  deps: { readonly runtime: GatewayRuntime; readonly credentials: CredentialStore; readonly llmConfiguration: LlmConfigurationPort; readonly env?: () => Readonly<Record<string, string | undefined>> },
): void {
  const preHandler = authenticate(deps);
  const preValidation = async (request: FastifyRequest): Promise<void> => {
    const query = request.query as Record<string, unknown>;
    const body = request.body as Record<string, unknown> | null;
    if (query['tenant_id'] !== undefined) {
      fail('INSUFFICIENT_AUTHORITY', 'platform routes do not accept tenant-scoped query parameters');
    }
    if (
      request.headers['x-tenant-id'] !== undefined
      || (body !== null && typeof body === 'object' && body['tenant_id'] !== undefined)
    ) {
      fail('VALIDATION_FAILED', 'platform routes do not accept tenant binding assertions');
    }
  };
  app.put<{ Params: { id: string } }>('/platform/providers/:id', { preValidation, preHandler }, async (request) => {
    const principal = requireOperator(request, 'platform:providers:write');
    if (principal.scope !== 'platform') {
      fail('INSUFFICIENT_AUTHORITY', 'the platform control plane requires a platform-scoped principal');
    }
    const actor_id = principal.operator_id;
    if (actor_id === undefined) fail('AUTHENTICATION_FAILED', 'Operator identity is required.');
    const id = providerId(request.params.id);
    const body = objectBody(request.body);
    const reason = providerReason(body.reason);
    if (typeof body.display_name !== 'string' || body.display_name.trim().length === 0 || body.display_name.length > 128
      || typeof body.base_url !== 'string'
      || typeof body.reasoning_model !== 'string' || body.reasoning_model.trim().length === 0 || body.reasoning_model.length > 128
      || typeof body.fast_model !== 'string' || body.fast_model.trim().length === 0 || body.fast_model.length > 128
      || typeof body.timeout_ms !== 'number' || !Number.isSafeInteger(body.timeout_ms) || body.timeout_ms < 1000 || body.timeout_ms > 120000
      || (body.structured_mode !== 'json_object' && body.structured_mode !== 'json_schema')
      || typeof body.is_default !== 'boolean'
      || (body.api_key !== undefined && body.api_key !== null && (typeof body.api_key !== 'string' || body.api_key.trim().length === 0))) {
      fail('VALIDATION_FAILED', 'Provider configuration is incomplete or invalid.');
    }
    const env = deps.env?.() ?? process.env;
    try {
      assertSafeProviderUrl(body.base_url, env.APP_ENV);
    } catch {
      fail('VALIDATION_FAILED', 'base_url is not an allowed provider URL.');
    }
    return deps.llmConfiguration.upsertPlatformProvider({
      provider_id: id,
      display_name: body.display_name,
      base_url: body.base_url,
      reasoning_model: body.reasoning_model,
      fast_model: body.fast_model,
      timeout_ms: body.timeout_ms,
      structured_mode: body.structured_mode,
      is_default: body.is_default,
      api_key: body.api_key as string | null ?? null,
    }, {
      actor_kind: 'OPERATOR',
      actor_id,
      correlation_id: correlationIdOf(request, deps.runtime),
      ...(reason === undefined ? {} : { reason }),
    });
  });
  app.post<{ Params: { id: string } }>('/platform/providers/:id/test', { preValidation, preHandler }, async (request) => {
    const principal = requireOperator(request, 'platform:providers:write');
    if (principal.scope !== 'platform') {
      fail('INSUFFICIENT_AUTHORITY', 'the platform control plane requires a platform-scoped principal');
    }
    probeRateLimit(deps.runtime, { kind: 'platform' });
    return deps.llmConfiguration.probePlatformProvider(providerId(request.params.id));
  });
}
