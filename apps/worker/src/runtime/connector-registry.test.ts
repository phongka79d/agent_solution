import { describe, expect, it, vi } from 'vitest';
import type { ConnectorBindingRecord } from '@agentos/database';

import { createConnectorRegistry } from './connector-registry.js';
import type { ErpReadPort } from './connectors.js';
import type { ErpFetchLike } from './erp-http-transport.js';

const DEMO_TENANT = '11111111-1111-4111-8111-111111111111';
const PROD_TENANT = '22222222-2222-4222-8222-222222222222';
const ENV = {
  MOCK_ERP_ENABLED: 'true',
  ERP_API_BASE_URL: 'http://mock-erp.invalid/api/v1',
  MOCK_SECRET_KEY: 'worker-mock-erp-secret-1234',
} as const;
const BINDING_MODES: readonly ConnectorBindingRecord['mode'][] = ['MOCK', 'LIVE'];

function boundBinding(overrides: Partial<ConnectorBindingRecord> = {}): ConnectorBindingRecord {
  return {
    tenant_id: DEMO_TENANT,
    connector_id: 'API-001',
    status: 'BOUND',
    mode: 'LIVE',
    config: { base_url: 'https://erp.example.test/api/v1' },
    secret_id: 'secret-1',
    bound_at: '2026-09-01T00:00:00.000Z',
    probe_outcome: 'PASS',
    probe_latency_ms: 1,
    probe_http_status: 200,
    probe_error_class: null,
    probed_at: '2026-09-01T00:00:00.000Z',
    version: 3,
    ...overrides,
  };
}

describe('createConnectorRegistry', () => {
  it('prefers a BOUND database connector over the DEMO environment fallback', async () => {
    const binding = boundBinding();
    const dbPort: ErpReadPort = { read: vi.fn() };
    const buildErpReadPort = vi.fn(() => dbPort);
    const dataClassOf = vi.fn();
    const registry = createConnectorRegistry({
      bindings: { get: vi.fn().mockResolvedValue(binding) },
      secrets: { resolve: vi.fn().mockResolvedValue('database-secret') },
      env: ENV,
      dataClassOf,
      buildErpReadPort,
      now: () => new Date('2026-10-01T00:00:00.000Z'),
    });

    const port = await registry.erpFor(DEMO_TENANT);

    expect(port).not.toBeNull();
    expect(buildErpReadPort).toHaveBeenCalledWith({
      tenant_id: DEMO_TENANT,
      binding,
      secret: 'database-secret',
    });
    expect(dataClassOf).not.toHaveBeenCalled();
  });

  it.each(BINDING_MODES)('binds cart and AUTH-4 order capabilities from an explicitly connected %s ERP', async (mode) => {
    const fetch: ErpFetchLike = vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify({ cart_id: 'bound-cart' }),
    }));
    const dataClassOf = vi.fn();
    const registry = createConnectorRegistry({
      bindings: { get: vi.fn().mockResolvedValue(boundBinding({
        mode,
        config: { base_url: 'https://erp.example.test/api/v1', auth_scheme: 'BEARER' },
      })) },
      secrets: { resolve: vi.fn().mockResolvedValue('database-secret') },
      env: {},
      dataClassOf,
      fetch,
    });
    const port = await registry.erpFor(DEMO_TENANT);
    if (port?.cart_transport === undefined || port.createOrder === undefined) {
      throw new Error('Connected ERP must provide cart and order ports');
    }

    await expect(port.cart_transport.request({
      tenant_id: DEMO_TENANT,
      method: 'POST',
      path: '/api/v1/carts',
      body: { items: [{ sku_id: 'NM-L01-BLK', quantity: 1 }] },
      idempotency_key: 'cart-effect',
    })).resolves.toMatchObject({ ok: true, body: { cart_id: 'bound-cart' } });
    expect(fetch).toHaveBeenCalledWith('https://erp.example.test/api/v1/carts', expect.objectContaining({
      headers: expect.objectContaining({ 'x-tenant-id': DEMO_TENANT, 'idempotency-key': 'cart-effect' }),
    }));
    expect(dataClassOf).not.toHaveBeenCalled();

    await expect(port.createOrder({
      tenant_id: DEMO_TENANT,
      effect_key: 'order-effect',
      approval_id: '',
      approval_payload_digest: '',
      cart_id: 'bound-cart',
      customer_id: 'verified-customer',
      items: [{ sku_id: 'NM-L01-BLK', quantity: 1 }],
      shipping_address: {},
      payment_method: 'STRIPE',
    })).rejects.toMatchObject({ refusal_code: 'AUTHORITY_ABSENT' });
    expect(fetch).toHaveBeenCalledTimes(1);

    await expect(port.cart_transport.request({
      tenant_id: PROD_TENANT,
      method: 'POST',
      path: '/api/v1/carts',
    })).resolves.toMatchObject({ ok: false, failure_class: 'PROVIDER_REJECTED' });
    expect(() => port.createOrder!({
      tenant_id: PROD_TENANT,
      effect_key: 'order-effect',
      approval_id: 'approval',
      approval_payload_digest: 'a'.repeat(64),
      cart_id: 'bound-cart',
      customer_id: 'verified-customer',
      items: [{ sku_id: 'NM-L01-BLK', quantity: 1 }],
      shipping_address: {},
      payment_method: 'STRIPE',
    })).toThrow('CONNECTOR_TENANT_SCOPE_MISMATCH');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('uses the environment mock only for a pristine DEMO tenant', async () => {
    const registry = createConnectorRegistry({
      bindings: { get: vi.fn().mockResolvedValue(null) },
      secrets: { resolve: vi.fn() },
      env: ENV,
      dataClassOf: vi.fn().mockResolvedValue('DEMO'),
      hmac: () => 'unused',
    });

    await expect(registry.erpFor(DEMO_TENANT)).resolves.not.toBeNull();
  });

  it('allows the untouched UNBOUND provisioning row to inherit the DEMO mock', async () => {
    const registry = createConnectorRegistry({
      bindings: { get: vi.fn().mockResolvedValue(boundBinding({
        status: 'UNBOUND', mode: 'MOCK', config: {}, secret_id: null, bound_at: null,
        probe_outcome: null, probed_at: null, version: 1,
      })) },
      secrets: { resolve: vi.fn() },
      env: ENV,
      dataClassOf: vi.fn().mockResolvedValue('DEMO'),
      hmac: () => 'unused',
    });

    await expect(registry.erpFor(DEMO_TENANT)).resolves.not.toBeNull();
  });

  const unavailableBindings: readonly Partial<ConnectorBindingRecord>[] = [
    { status: 'UNBOUND', version: 2, config: {}, secret_id: null, bound_at: null, probe_outcome: null, probed_at: null },
    { status: 'UNBOUND', version: 1, config: { base_url: ENV.ERP_API_BASE_URL } },
    { secret_id: 'configured-secret' },
    { bound_at: '2026-10-01T00:00:00Z' },
    { probe_outcome: 'FAIL' },
    { probed_at: '2026-10-01T00:00:00Z' },
    { status: 'DEGRADED', probe_outcome: 'FAIL' },
    { status: 'DISABLED' },
  ];
  it.each(unavailableBindings)('never masks a company-controlled unavailable binding: %j', async (overrides) => {
    const dataClassOf = vi.fn().mockResolvedValue('DEMO');
    const registry = createConnectorRegistry({
      bindings: { get: vi.fn().mockResolvedValue(boundBinding({
        status: 'UNBOUND', config: {}, secret_id: null, bound_at: null,
        probe_outcome: null, probed_at: null, version: 1, ...overrides,
      })) },
      secrets: { resolve: vi.fn() },
      env: ENV,
      dataClassOf,
      hmac: () => 'unused',
    });

    await expect(registry.erpFor(DEMO_TENANT)).resolves.toBeNull();
    expect(dataClassOf).not.toHaveBeenCalled();
  });

  it.each(['environment', 'database'])('invalidates a cached %s port immediately after disconnect', async (source) => {
    let binding: ConnectorBindingRecord | null = source === 'database' ? boundBinding() : null;
    const registry = createConnectorRegistry({
      bindings: { get: async () => binding },
      secrets: { resolve: vi.fn().mockResolvedValue('database-secret') },
      env: ENV,
      dataClassOf: vi.fn().mockResolvedValue('DEMO'),
      hmac: () => 'unused',
      buildErpReadPort: () => ({ read: vi.fn() }),
    });
    await expect(registry.erpFor(DEMO_TENANT)).resolves.not.toBeNull();

    binding = boundBinding({
      status: 'UNBOUND', config: {}, secret_id: null, bound_at: null,
      probe_outcome: null, probed_at: null, version: 4,
    });
    await expect(registry.erpFor(DEMO_TENANT)).resolves.toBeNull();

    binding = boundBinding({ version: 5 });
    await expect(registry.erpFor(DEMO_TENANT)).resolves.not.toBeNull();
  });

  it.each(['PRODUCTION', 'TEST', null])('returns null for a %s tenant without a database connector', async (dataClass) => {
    const registry = createConnectorRegistry({
      bindings: { get: vi.fn().mockResolvedValue(null) },
      secrets: { resolve: vi.fn() },
      env: ENV,
      dataClassOf: vi.fn().mockResolvedValue(dataClass),
      hmac: () => 'unused',
    });

    await expect(registry.erpFor(PROD_TENANT)).resolves.toBeNull();
  });

  it('does not substitute the DEMO fallback when a BOUND binding cannot be resolved', async () => {
    const registry = createConnectorRegistry({
      bindings: { get: vi.fn().mockResolvedValue(boundBinding({ tenant_id: PROD_TENANT })) },
      secrets: { resolve: vi.fn().mockRejectedValue(new Error('secret unavailable')) },
      env: ENV,
      dataClassOf: vi.fn().mockResolvedValue('DEMO'),
      hmac: () => 'unused',
    });

    await expect(registry.erpFor(PROD_TENANT)).resolves.toBeNull();
  });
});
