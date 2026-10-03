import type { FastifyInstance } from 'fastify';

import { CONNECTOR_CATALOG, runConnectorProbe, type ConnectorAuthScheme, type ConnectorCatalogEntry, type ConnectorFetch } from '@agentos/adapters';
import { hmacSha256Hex } from '@agentos/core-engine';

import type { ConnectorBindingRecord, ConnectorProbeName } from '@agentos/database';

import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import type { CompanyIntegrationsPort, GatewayRuntime } from '../../gateway/ports.js';
import { mapIntegrations } from '../../projections/integrations.js';

interface ConnectorPath { readonly id: string }
interface IntegrationUpdateBody {
  readonly config: unknown;
  readonly secret?: unknown;
}

function entryFor(id: string): ConnectorCatalogEntry {
  const entry = CONNECTOR_CATALOG.find((candidate) => candidate.connector_id === id);
  if (entry === undefined) fail('NOT_FOUND', 'connector is not in the integration catalog');
  return entry;
}

function integrationPort(runtime: GatewayRuntime): CompanyIntegrationsPort {
  if (runtime.companyIntegrations === undefined) fail('PROVIDER_TIMEOUT', 'integrations storage is unavailable');
  return runtime.companyIntegrations;
}

function expectedVersion(value: string | undefined): number {
  if (value === undefined) fail('VALIDATION_FAILED', 'If-Match is required');
  const match = /^(?:"([1-9][0-9]*)"|([1-9][0-9]*))$/.exec(value.trim());
  const version = Number(match?.[1] ?? match?.[2]);
  if (match === null || !Number.isSafeInteger(version) || version < 1) {
    fail('VALIDATION_FAILED', 'If-Match must contain a positive connector version');
  }
  return version;
}

function validateConfig(entry: ConnectorCatalogEntry, value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('VALIDATION_FAILED', 'config must be an object');
  const config = value as Record<string, unknown>;
  const schema = entry.config_schema;
  const properties = schema['properties'] as Readonly<Record<string, unknown>>;
  if (schema['additionalProperties'] === false && Object.keys(config).some((key) => !(key in properties))) {
    fail('VALIDATION_FAILED', 'config contains an unsupported property');
  }
  const required = Array.isArray(schema['required']) ? schema['required'] : [];
  if (required.some((key) => typeof key !== 'string' || !(key in config))) {
    fail('VALIDATION_FAILED', 'config is missing a required property');
  }
  for (const [key, item] of Object.entries(config)) {
    const schemaValue = properties[key];
    if (typeof schemaValue !== 'object' || schemaValue === null || Array.isArray(schemaValue)) {
      fail('VALIDATION_FAILED', 'config property is not supported');
    }
    const propertySchema = schemaValue as Readonly<Record<string, unknown>>;
    if (propertySchema['type'] === 'string' && typeof item !== 'string') {
      fail('VALIDATION_FAILED', 'config property has an invalid type');
    }
    if (typeof item === 'string') {
      if (typeof propertySchema['minLength'] === 'number' && item.length < propertySchema['minLength']) {
        fail('VALIDATION_FAILED', 'config property is too short');
      }
      const enumValues = propertySchema['enum'];
      if (Array.isArray(enumValues) && !enumValues.includes(item)) fail('VALIDATION_FAILED', 'config property is unsupported');
      if (propertySchema['format'] === 'uri') {
        let url: URL;
        try {
          url = new URL(item);
        } catch {
          fail('VALIDATION_FAILED', 'config URL must be an absolute HTTP URL');
        }
        if (!['http:', 'https:'].includes(url.protocol) || url.hostname.length === 0 || url.username || url.password) {
          fail('VALIDATION_FAILED', 'config URL must be an absolute HTTP URL without embedded credentials');
        }
      }
    }
  }
  const authScheme = config['auth_scheme'];
  if (authScheme !== undefined && (typeof authScheme !== 'string' || !entry.auth_schemes.includes(authScheme as ConnectorAuthScheme))) {
    fail('VALIDATION_FAILED', 'auth_scheme is not supported by this connector');
  }
  return config;
}

function safeBinding(binding: ConnectorBindingRecord | null, secretDescription: { fingerprint: string; last4: string } | null) {
  if (binding === null) return null;
  return {
    status: binding.status,
    mode: binding.mode,
    config: binding.config,
    version: binding.version,
    bound_at: binding.bound_at,
    probe: binding.probe_outcome === null ? null : {
      outcome: binding.probe_outcome,
      latency_ms: binding.probe_latency_ms,
      http_status: binding.probe_http_status,
      error_class: binding.probe_error_class,
      probed_at: binding.probed_at,
    },
    secret: secretDescription,
  };
}

async function secretDescriptionOf(
  port: CompanyIntegrationsPort,
  tenant_id: string,
  binding: ConnectorBindingRecord | null,
): Promise<{ fingerprint: string; last4: string } | null> {
  if (binding?.secret_id === null || binding?.secret_id === undefined) return null;
  const description = await port.describeSecret(tenant_id, binding.secret_id);
  return description === null ? null : { fingerprint: description.fingerprint, last4: description.last4 };
}

export function registerCompanyIntegrationsRoutes(
  app: FastifyInstance,
  deps: {
    readonly runtime: GatewayRuntime;
    readonly credentials: CredentialStore;
    readonly fetchImpl?: ConnectorFetch;
    readonly timeoutMs?: number;
  },
): void {
  const preHandler = authenticate(deps);

  app.get('/company/integrations', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      const principal = requireOperator(request, 'telemetry:read');
      const port = integrationPort(runtime);
      const bindings = await port.listBindings(principal.tenant_id);
      const demo_erp_eligible = await port.demoErpEligibleForTenant?.(principal.tenant_id) === true;
      const projectedById = new Map(mapIntegrations({ catalog: CONNECTOR_CATALOG, bindings, demo_erp_eligible }).map((item) => [item.key, item]));
      const items = await Promise.all(CONNECTOR_CATALOG.map(async (entry) => {
        const binding = bindings.find((candidate) => candidate.connector_id === entry.connector_id) ?? null;
        const projection = projectedById.get(entry.connector_id);
        if (projection === undefined) fail('PROVIDER_TIMEOUT', 'integration projection is unavailable');
        const secret = await secretDescriptionOf(port, principal.tenant_id, binding);
        return {
          ...projection,
          connector_id: entry.connector_id,
          display_key: entry.display_key,
          catalog_category: entry.category,
          integrated: entry.integrated,
          config_schema: entry.config_schema,
          auth_schemes: entry.auth_schemes,
          probes: entry.probes,
          binding: safeBinding(binding, secret),
        };
      }));
      await runtime.audit.record({
        tenant_id: principal.tenant_id,
        correlation_id: correlationIdOf(request, runtime),
        operation: 'company.integrations.list',
        principal_kind: principal.kind,
        ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
        outcome: 'ACCEPTED',
        detail: { count: items.length },
      });
      return reply.code(200).send({ items });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.put<{ Params: ConnectorPath; Body: IntegrationUpdateBody }>(
    '/company/integrations/:id',
    { preHandler },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);
      try {
        const principal = requireOperator(request, 'integration:manage');
        const operator_id = principal.operator_id;
        if (operator_id === undefined || operator_id.length === 0) fail('AUTHENTICATION_FAILED', 'operator identity is unavailable');
        const entry = entryFor(request.params.id);
        const id = entry.connector_id;
        const port = integrationPort(runtime);
        const body: unknown = request.body;
        if (typeof body !== 'object' || body === null || Array.isArray(body)) {
          fail('VALIDATION_FAILED', 'connector update body must contain config and optional secret');
        }
        const bodyRecord = body as Record<string, unknown>;
        if (Object.keys(bodyRecord).some((key) => key !== 'config' && key !== 'secret') || !('config' in bodyRecord)) {
          fail('VALIDATION_FAILED', 'connector update body must contain config and optional secret');
        }
        const config = validateConfig(entry, bodyRecord['config']);
        const secretValue = bodyRecord['secret'];
        if (secretValue !== undefined && (typeof secretValue !== 'string' || secretValue.length === 0 || secretValue.length > 4096)) {
          fail('VALIDATION_FAILED', 'secret must be a non-empty string no longer than 4096 characters');
        }
        const version = expectedVersion(request.headers['if-match']);
        const before = await port.getBinding(principal.tenant_id, id);
        if (before === null) fail('NOT_FOUND', 'connector configuration was not found');
        let secret_id = before.secret_id;
        let newSecretId: string | null = null;
        if (typeof secretValue === 'string') {
          try {
            const stored = await port.putSecret(principal.tenant_id, {
              purpose: `connector:${id}`,
              plaintext: secretValue,
              actor_kind: principal.kind,
              actor_id: operator_id,
              correlation_id,
            });
            secret_id = stored.secret_id;
            newSecretId = stored.secret_id;
          } catch {
            fail('PROVIDER_TIMEOUT', 'connector secret could not be stored');
          }
        }
        const authScheme = typeof config['auth_scheme'] === 'string' ? config['auth_scheme'] : 'HMAC_MOCK';
        let updated: ConnectorBindingRecord;
        try {
          updated = await port.putConfig(principal.tenant_id, id, {
            config,
            secret_id,
            mode: authScheme === 'HMAC_MOCK' ? 'MOCK' : 'LIVE',
          }, {
            actor_kind: principal.kind,
            actor_id: operator_id,
            correlation_id,
          }, version);
        } catch (error) {
          if (newSecretId !== null) await port.revokeSecret(principal.tenant_id, newSecretId, {
            actor_kind: principal.kind,
            actor_id: operator_id,
            correlation_id,
          }).catch(() => false);
          const code = error instanceof Error ? error.message : '';
          if (code.includes('CONNECTOR_VERSION_CONFLICT')) fail('VERSION_CONFLICT', 'connector configuration changed; reload before saving');
          if (code.includes('CONNECTOR_NOT_FOUND')) fail('NOT_FOUND', 'connector configuration was not found');
          fail('PROVIDER_TIMEOUT', 'connector configuration could not be saved');
        }
        if (newSecretId !== null && before.secret_id !== null && before.secret_id !== newSecretId) {
          await port.revokeSecret(principal.tenant_id, before.secret_id, { actor_kind: principal.kind, actor_id: operator_id, correlation_id }).catch(() => false);
        }
        const secret = await secretDescriptionOf(port, principal.tenant_id, updated);
        return reply.code(200).header('ETag', `"${updated.version}"`).send({ binding: safeBinding(updated, secret) });
      } catch (error) {
        return replyFailure(reply, error, correlation_id);
      }
    },
  );

  app.post<{ Params: ConnectorPath }>('/company/integrations/:id/test', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    const correlation_id = correlationIdOf(request, runtime);
    try {
      const principal = requireOperator(request, 'integration:manage');
      const id = entryFor(request.params.id).connector_id;
      const entry = entryFor(id);
      if (!entry.integrated || entry.probes.length === 0) fail('VALIDATION_FAILED', 'this connector does not support a connection test');
      const port = integrationPort(runtime);
      const binding = await port.getBinding(principal.tenant_id, id);
      if (binding === null) fail('NOT_FOUND', 'connector configuration was not found');
      let secret: string | null = null;
      if (binding.secret_id !== null) {
        try {
          secret = await port.resolveSecret(principal.tenant_id, binding.secret_id);
        } catch {
          secret = null;
        }
      }
      const probe = await runConnectorProbe({
        entry,
        config: { ...binding.config, tenant_id: principal.tenant_id },
        secret,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
        hmacSha256Hex,
        ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
      });
      const checks = [...probe.checks].sort((left, right) => left.outcome === right.outcome ? 0 : left.outcome === 'PASS' ? -1 : 1);
      let latest: ConnectorBindingRecord = binding;
      for (const check of checks) {
        latest = await port.recordProbe(principal.tenant_id, id, {
          probe_name: check.probe as ConnectorProbeName,
          outcome: check.outcome,
          latency_ms: check.latency_ms,
          http_status: check.http_status,
          error_class: check.error_class,
        });
      }
      const response = { outcome: probe.outcome, checks: probe.checks, binding: safeBinding(latest, await secretDescriptionOf(port, principal.tenant_id, latest)) };
      return reply.code(200).send(response);
    } catch (error) {
      return replyFailure(reply, error, correlation_id);
    }
  });

  app.post<{ Params: ConnectorPath }>('/company/integrations/:id/disconnect', { preHandler }, async (request, reply) => {
    const runtime = deps.runtime;
    const correlation_id = correlationIdOf(request, runtime);
    try {
      const principal = requireOperator(request, 'integration:manage');
      const operator_id = principal.operator_id;
      if (operator_id === undefined || operator_id.length === 0) fail('AUTHENTICATION_FAILED', 'operator identity is unavailable');
      const id = entryFor(request.params.id).connector_id;
      const port = integrationPort(runtime);
      const version = expectedVersion(request.headers['if-match']);
      const before = await port.getBinding(principal.tenant_id, id);
      if (before === null) fail('NOT_FOUND', 'connector configuration was not found');
      let updated: ConnectorBindingRecord;
      try {
        updated = await port.disconnect(principal.tenant_id, id, {
          actor_kind: principal.kind,
          actor_id: operator_id,
          correlation_id,
        }, version);
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        if (code.includes('CONNECTOR_VERSION_CONFLICT')) fail('VERSION_CONFLICT', 'connector configuration changed; reload before disconnecting');
        fail('PROVIDER_TIMEOUT', 'connector could not be disconnected');
      }
      if (before.secret_id !== null) {
        await port.revokeSecret(principal.tenant_id, before.secret_id, {
          actor_kind: principal.kind,
          actor_id: operator_id,
          correlation_id,
        }).catch(() => false);
      }
      return reply.code(200).header('ETag', `"${updated.version}"`).send({ binding: safeBinding(updated, null) });
    } catch (error) {
      return replyFailure(reply, error, correlation_id);
    }
  });
}
