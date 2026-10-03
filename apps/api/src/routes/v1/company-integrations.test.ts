import { createHmac } from 'node:crypto';

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { ConnectorBindingRecord, ConnectorProbeResult } from '@agentos/database';
import type { ConnectorFetch } from '@agentos/adapters';

import type { CompanyIntegrationsPort, GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerCompanyIntegrationsRoutes } from './company-integrations.js';

const TENANT = 'tenant-integrations';
const READ_TOKEN = 'integrations-read';
const MANAGE_TOKEN = 'integrations-manage';
const SECRET_VALUE = 'never-echo-this-provider-secret';

function initialBinding(overrides: Partial<ConnectorBindingRecord> = {}): ConnectorBindingRecord {
  return {
    tenant_id: TENANT,
    connector_id: 'API-001',
    status: 'UNBOUND',
    mode: 'LIVE',
    config: { base_url: 'https://erp.example', auth_scheme: 'BEARER' },
    secret_id: 'secret-existing',
    bound_at: null,
    probe_outcome: null,
    probe_latency_ms: null,
    probe_http_status: null,
    probe_error_class: null,
    probed_at: null,
    version: 1,
    ...overrides,
  };
}

function buildHarness(fetchStatus = 200, authScheme: 'BEARER' | 'HMAC_MOCK' = 'BEARER', options: {
  readonly binding?: Partial<ConnectorBindingRecord>;
  readonly demoErpEligible?: boolean;
} = {}) {
  let binding = initialBinding({
    config: { base_url: 'https://erp.example', auth_scheme: authScheme },
    ...options.binding,
  });
  const storedSecret = {
    secret_id: 'secret-new',
    purpose: 'connector:API-001',
    fingerprint: 'fingerprint-new',
    last4: 'cret',
    created_at: '2026-10-01T00:00:00.000Z',
    revoked_at: null,
  };
  const recordProbe = vi.fn(async (_tenant_id: string, _connector_id: string, result: ConnectorProbeResult) => {
    binding = {
      ...binding,
      status: result.outcome === 'PASS' ? 'BOUND' : 'DEGRADED',
      bound_at: result.outcome === 'PASS' ? '2026-10-01T00:00:00.000Z' : null,
      probe_outcome: result.outcome,
      probe_latency_ms: result.latency_ms,
      probe_http_status: result.http_status,
      probe_error_class: result.error_class,
      probed_at: result.probed_at ?? '2026-10-01T00:00:00.000Z',
    };
    return binding;
  });
  const putSecret = vi.fn(async (_tenant_id: string, input: { readonly purpose: string }) => ({
    ...storedSecret,
    purpose: input.purpose,
  }));
  const revokeSecret = vi.fn(async () => true);
  const integrations: CompanyIntegrationsPort = {
    listBindings: async () => [binding],
    getBinding: async (_tenant_id, connector_id) => connector_id === binding.connector_id ? binding : null,
    demoErpEligibleForTenant: async () => options.demoErpEligible === true,
    putConfig: async (_tenant_id, _connector_id, input, _actor, expectedVersion) => {
      binding = {
        ...binding,
        config: input.config,
        secret_id: input.secret_id,
        mode: input.mode,
        status: 'UNBOUND',
        bound_at: null,
        probe_outcome: null,
        probe_latency_ms: null,
        probe_http_status: null,
        probe_error_class: null,
        probed_at: null,
        version: expectedVersion + 1,
      };
      return binding;
    },
    recordProbe,
    disconnect: async (_tenant_id, _connector_id, _actor, expectedVersion) => {
      binding = { ...binding, status: 'UNBOUND', secret_id: null, bound_at: null, probe_outcome: null, probe_latency_ms: null, probe_http_status: null, probe_error_class: null, probed_at: null, version: expectedVersion + 1 };
      return binding;
    },
    putSecret,
    describeSecret: async (_tenant_id, secret_id) => secret_id === storedSecret.secret_id ? storedSecret : {
      ...storedSecret,
      secret_id,
      purpose: 'connector:API-001',
      fingerprint: 'fingerprint-existing',
      last4: 'ting',
    },
    revokeSecret,
    resolveSecret: async () => SECRET_VALUE,
  };
  const runtime = {
    companyIntegrations: integrations,
    audit: { record: vi.fn(async () => undefined) },
    ids: () => 'corr-integrations-test',
  } as unknown as GatewayRuntime;
  const credentials = createCredentialStore({
    operators: [
      { token: READ_TOKEN, tenant_id: TENANT, operator_id: 'operator-read', permissions: ['telemetry:read'] },
      { token: MANAGE_TOKEN, tenant_id: TENANT, operator_id: 'operator-manage', permissions: ['integration:manage'] },
    ],
    sessions: [],
    widgets: [],
  });
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  const probeCalls: { url: string; method: string; headers: Readonly<Record<string, string>>; body?: string }[] = [];
  const fetchImpl: ConnectorFetch = async (url, init) => {
    probeCalls.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
    return { status: fetchStatus, text: async () => '{"private":"provider response"}' };
  };
  registerCompanyIntegrationsRoutes(app, { runtime, credentials, fetchImpl, timeoutMs: 100 });
  return { app, binding: () => binding, putSecret, recordProbe, revokeSecret, probeCalls };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('company integration routes', () => {
  it('keeps catalog reads telemetry-readable and exposes only catalog, binding, and probe projection fields', async () => {
    const { app } = buildHarness();
    try {
      const response = await app.inject({ method: 'GET', url: '/company/integrations', headers: auth(READ_TOKEN) });
      expect(response.statusCode).toBe(200);
      const item = response.json().items.find((candidate: { connector_id: string }) => candidate.connector_id === 'API-001');
      expect(item).toMatchObject({ connector_id: 'API-001', catalog_category: 'ERP_POS', status: 'NOT_CONFIGURED' });
      expect(item.binding).toMatchObject({ status: 'UNBOUND', secret: { fingerprint: 'fingerprint-existing', last4: 'ting' } });
      expect(JSON.stringify(response.json())).not.toContain(SECRET_VALUE);
      const manageOnly = await app.inject({ method: 'GET', url: '/company/integrations', headers: auth(MANAGE_TOKEN) });
      expect(manageOnly.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it('reports a pristine eligible DEMO mock, but honors even a disconnect of an empty binding', async () => {
    const { app } = buildHarness(200, 'HMAC_MOCK', {
      binding: { config: {}, secret_id: null },
      demoErpEligible: true,
    });
    try {
      const before = await app.inject({ method: 'GET', url: '/company/integrations', headers: auth(READ_TOKEN) });
      expect(before.statusCode).toBe(200);
      expect(before.json().items.find((item: { connector_id: string }) => item.connector_id === 'API-001').status).toBe('DEMO_MOCK');

      const disconnected = await app.inject({
        method: 'POST', url: '/company/integrations/API-001/disconnect',
        headers: { ...auth(MANAGE_TOKEN), 'if-match': '"1"' },
      });
      expect(disconnected.statusCode).toBe(200);
      const after = await app.inject({ method: 'GET', url: '/company/integrations', headers: auth(READ_TOKEN) });
      expect(after.statusCode).toBe(200);
      expect(after.json().items.find((item: { connector_id: string }) => item.connector_id === 'API-001'))
        .toMatchObject({ status: 'NOT_CONFIGURED', binding: { status: 'UNBOUND', version: 2 } });
    } finally {
      await app.close();
    }
  });

  it('validates config and If-Match, stores write-only secrets, records probes, and disconnects', async () => {
    const { app, binding, putSecret, recordProbe, revokeSecret } = buildHarness();
    try {
      const invalid = await app.inject({ method: 'PUT', url: '/company/integrations/API-001', headers: { ...auth(MANAGE_TOKEN), 'if-match': '"1"' }, payload: { config: { base_url: 'https://user:pass@erp.example' }, secret: SECRET_VALUE } });
      expect(invalid.statusCode).toBe(400);
      expect(putSecret).not.toHaveBeenCalled();
      const missingVersion = await app.inject({ method: 'PUT', url: '/company/integrations/API-001', headers: auth(MANAGE_TOKEN), payload: { config: { base_url: 'https://erp.example', auth_scheme: 'BEARER' } } });
      expect(missingVersion.statusCode).toBe(400);

      const updated = await app.inject({ method: 'PUT', url: '/company/integrations/API-001', headers: { ...auth(MANAGE_TOKEN), 'if-match': '"1"' }, payload: { config: { base_url: 'https://erp.example', auth_scheme: 'BEARER' }, secret: SECRET_VALUE } });
      expect(updated.statusCode).toBe(200);
      expect(updated.headers.etag).toBe('"2"');
      expect(updated.json().binding).toMatchObject({ status: 'UNBOUND', secret: { fingerprint: 'fingerprint-new', last4: 'cret' } });
      expect(JSON.stringify(updated.json())).not.toContain(SECRET_VALUE);
      expect(putSecret).toHaveBeenCalledOnce();
      expect(binding().status).toBe('UNBOUND');

      const tested = await app.inject({ method: 'POST', url: '/company/integrations/API-001/test', headers: auth(MANAGE_TOKEN) });
      expect(tested.statusCode).toBe(200);
      expect(tested.json()).toMatchObject({ outcome: 'PASS', binding: { status: 'BOUND' } });
      expect(recordProbe).toHaveBeenCalledTimes(4);
      expect(recordProbe.mock.calls.every(([, , result]) => result.outcome === 'PASS')).toBe(true);

      const disconnected = await app.inject({ method: 'POST', url: '/company/integrations/API-001/disconnect', headers: { ...auth(MANAGE_TOKEN), 'if-match': '"2"' } });
      expect(disconnected.statusCode).toBe(200);
      expect(disconnected.json().binding.status).toBe('UNBOUND');
      expect(revokeSecret.mock.calls.map((call: readonly unknown[]) => call[1])).toEqual(['secret-existing', 'secret-new']);
    } finally {
      await app.close();
    }
  });
  it('uses the core HMAC implementation for mock-auth probes', async () => {
    const { app, probeCalls } = buildHarness(200, 'HMAC_MOCK');
    try {
      const response = await app.inject({ method: 'POST', url: '/company/integrations/API-001/test', headers: auth(MANAGE_TOKEN) });
      expect(response.statusCode).toBe(200);
      expect(response.json().outcome).toBe('PASS');
      expect(probeCalls).toHaveLength(4);
      for (const { url, method, headers, body } of probeCalls) {
        const path = new URL(url).pathname;
        const material = `${method.toUpperCase()} ${path}\n${body ?? ''}`;
        expect(headers['x-mock-signature']).toBe(createHmac('sha256', SECRET_VALUE).update(material, 'utf8').digest('hex'));
      }
    } finally {
      await app.close();
    }
  });


  it('leaves a connector degraded after failed real probes', async () => {
    const { app, binding, recordProbe } = buildHarness(401);
    try {
      const response = await app.inject({ method: 'POST', url: '/company/integrations/API-001/test', headers: auth(MANAGE_TOKEN) });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ outcome: 'FAIL', binding: { status: 'DEGRADED' } });
      expect(recordProbe).toHaveBeenCalledTimes(4);
      expect(binding().status).toBe('DEGRADED');
      const serialized = JSON.stringify(response.json());
      expect(serialized).not.toContain(SECRET_VALUE);
      expect(serialized).not.toContain('provider response');
    } finally {
      await app.close();
    }
  });
});
