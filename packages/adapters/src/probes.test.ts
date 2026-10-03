import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CONNECTOR_CATALOG } from './catalog.js';
import { runConnectorProbe, type ConnectorFetch } from './probes.js';

const ERP = CONNECTOR_CATALOG.find((entry) => entry.connector_id === 'API-001')!;

function response(status: number) {
  return { status, text: async () => '{"private":"provider body"}' };
}

describe('runConnectorProbe', () => {
  it('runs the catalog-declared read-only calls and returns only sanitized check results', async () => {
    const calls: { url: string; method: string; headers: Readonly<Record<string, string>>; body?: string }[] = [];
    const fetchImpl: ConnectorFetch = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body === undefined ? {} : { body: init.body }) });
      return response(200);
    };

    const result = await runConnectorProbe({
      entry: ERP,
      config: { base_url: 'https://erp.example/api/v1', tenant_id: 'tenant-a', auth_scheme: 'HMAC_MOCK' },
      secret: 'provider-secret',
      fetchImpl,
      timeoutMs: 100,
      hmacSha256Hex: (secret, message) => createHmac('sha256', secret).update(message, 'utf8').digest('hex'),
    });

    expect(result.outcome).toBe('PASS');
    expect(result.checks.map(({ probe, outcome, http_status }) => [probe, outcome, http_status])).toEqual([
      ['catalog', 'PASS', 200],
      ['inventory', 'PASS', 200],
      ['customers', 'PASS', 200],
      ['orders', 'PASS', 200],
    ]);
    expect(calls.map(({ method, url }) => [method, url])).toEqual([
      ['GET', 'https://erp.example/api/v1/catalog/items'],
      ['POST', 'https://erp.example/api/v1/inventory/lookup'],
      ['POST', 'https://erp.example/api/v1/customers/lookup'],
      ['POST', 'https://erp.example/api/v1/orders/status'],
    ]);
    expect(calls.every(({ headers }) => headers['x-tenant-id'] === 'tenant-a' && typeof headers['x-mock-signature'] === 'string')).toBe(true);
    expect(result.checks.every((check) => !('body' in check) && !('secret' in check))).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/provider body|provider-secret|https?:/i);
  });

  it('reports failed HTTP checks without exposing response bodies', async () => {
    const fetchImpl: ConnectorFetch = async () => response(401);
    const result = await runConnectorProbe({
      entry: ERP,
      config: { base_url: 'https://erp.example', tenant_id: 'tenant-a', auth_scheme: 'BEARER' },
      secret: 'bearer-secret',
      fetchImpl,
      timeoutMs: 100,
    });
    expect(result.outcome).toBe('FAIL');
    expect(result.checks.every((check) => check.outcome === 'FAIL' && check.http_status === 401)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/bearer-secret|provider body/i);
  });
});
