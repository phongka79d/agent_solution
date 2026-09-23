import { createHmac } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it, vi } from 'vitest';

import { createErpHttpTransport, type ErpHttpRequestInit } from './erp-http-transport.js';

const SECRET = 'erp-shared-secret-value-do-not-leak';
const BASE_URL = 'http://erp.internal:8081/api/v1';

/** `06` §2 route for the `products` read group; the transport never invents a path of its own. */
const CATALOG_PATH = '/api/v1/catalog/items';

/** The injected HMAC primitive: the same algorithm the provider verifies, without a crypto import here. */
const hmac = (secret: string, message: string): string =>
  createHmac('sha256', secret).update(message).digest('hex');

/** One recorded call: the URL plus the exact init the transport passed to fetch. */
interface RecordedCall {
  readonly url: string;
  readonly init: ErpHttpRequestInit;
}

/** A fetch double that answers with `responses` in order and records every call it receives. */
function recorder(
  responses: readonly (ErpHttpResponseLike | Error | Promise<never>)[],
): { readonly calls: RecordedCall[]; readonly fetch: (url: string, init: ErpHttpRequestInit) => Promise<ErpHttpResponseLike> } {
  const calls: RecordedCall[] = [];
  let index = 0;

  return {
    calls,
    fetch: async (url, init) => {
      calls.push({ url, init });
      const next = responses[index] ?? responses[responses.length - 1];
      index += 1;

      if (next === undefined) throw new Error('the recorder was given no response to answer with');
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

interface ErpHttpResponseLike {
  readonly status: number;
  text(): Promise<string>;
}

/** A response with a JSON body. */
function json(status: number, body: unknown): ErpHttpResponseLike {
  return { status, text: async () => JSON.stringify(body) };
}

/** A response whose body cannot be read as a provider envelope. */
function raw(status: number, text: string): ErpHttpResponseLike {
  return { status, text: async () => text };
}

/** A transport over the recorder, or over an explicit fetch implementation. */
function transport(
  responses: readonly (ErpHttpResponseLike | Error)[],
  overrides: Partial<Parameters<typeof createErpHttpTransport>[0]> = {},
): { readonly calls: RecordedCall[]; readonly request: ReturnType<typeof createErpHttpTransport>['request'] } {
  const recorded = recorder(responses);
  const built = createErpHttpTransport({
    base_url: BASE_URL,
    hmac_secret: SECRET,
    hmac,
    timeout_ms: 1000,
    fetch: recorded.fetch,
    ...overrides,
  });

  return { calls: recorded.calls, request: built.request };
}

describe('createErpHttpTransport', () => {
  it('resolves a connector route against the configured origin', async () => {
    const { calls, request } = transport([json(200, { items: [] })]);

    await request({ method: 'GET', path: CATALOG_PATH, tenant_id: 'tenant-a' });

    expect(calls[0]?.url).toBe('http://erp.internal:8081/api/v1/catalog/items');
  });

  it('signs the exact bytes it sends and sends none for a read', async () => {
    const { calls, request } = transport([json(200, { ok: true })]);

    await request({ method: 'GET', path: CATALOG_PATH, tenant_id: 'tenant-a' });
    await request({
      method: 'POST',
      path: '/api/v1/prices/lookup',
      tenant_id: 'tenant-a',
      body: { sku_id: 'SKU-1', tenant_id: 'tenant-a' },
    });

    const read = calls[0];
    const write = calls[1];
    const writeBody = JSON.stringify({ sku_id: 'SKU-1', tenant_id: 'tenant-a' });

    expect(read?.init.body).toBeUndefined();
    expect(read?.init.headers['x-signature-sha256']).toBe(hmac(SECRET, ''));
    expect(write?.init.body).toBe(writeBody);
    // The signature is over the payload as serialized, so a provider that verifies raw bytes agrees.
    expect(write?.init.headers['x-signature-sha256']).toBe(hmac(SECRET, writeBody ?? ''));
    expect(write?.init.headers['content-type']).toBe('application/json');
  });

  it('scopes every call to the request tenant under the configured header name', async () => {
    const { calls, request } = transport([json(200, { ok: true })], { tenant_header: 'x-erp-tenant' });

    await request({ method: 'GET', path: CATALOG_PATH, tenant_id: 'tenant-b' });

    expect(calls[0]?.init.headers['x-erp-tenant']).toBe('tenant-b');
    expect(calls[0]?.init.headers['x-tenant-id']).toBeUndefined();
  });

  it('classifies a provider refusal as confirmed and an open outcome as indeterminate', async () => {
    const cases: readonly { readonly status: number; readonly expected: string }[] = [
      { status: 404, expected: 'PROVIDER_REJECTED' },
      { status: 422, expected: 'PROVIDER_REJECTED' },
      { status: 408, expected: 'TIMEOUT' },
      { status: 429, expected: 'TIMEOUT' },
      { status: 500, expected: 'UNKNOWN' },
      { status: 504, expected: 'UNKNOWN' },
    ];

    for (const { status, expected } of cases) {
      const { request } = transport([json(status, { code: 'WHATEVER' })]);

      const result = await request({ method: 'GET', path: CATALOG_PATH, tenant_id: 'tenant-a' });

      expect({ status, result }).toEqual({
        status,
        result: { ok: false, failure_class: expected, status },
      });
    }
  });

  it('returns a 2xx provider envelope verbatim', async () => {
    const envelope = { items: [{ sku: 'SKU-1' }], snapshot_at: '2026-09-22T00:00:00.000Z' };
    const { request } = transport([json(200, envelope)]);

    const result = await request({ method: 'GET', path: CATALOG_PATH, tenant_id: 'tenant-a' });

    expect(result).toEqual({ ok: true, status: 200, body: envelope });
  });

  it('never confirms a 2xx whose body is not a provider envelope', async () => {
    const bodies: readonly string[] = ['', 'not json', '[1,2]', 'null'];

    for (const body of bodies) {
      const { request } = transport([raw(200, body)]);

      const result = await request({ method: 'GET', path: CATALOG_PATH, tenant_id: 'tenant-a' });

      expect({ body, result }).toEqual({
        body,
        result: { ok: false, failure_class: 'UNKNOWN', status: 200 },
      });
    }
  });

  it('classifies a deadline breach as TIMEOUT', async () => {
    // Never answers within the deadline: the signal is the only way this call ends.
    const aborting = vi.fn(async (_url: string, init: ErpHttpRequestInit): Promise<ErpHttpResponseLike> => {
      await delay(1000, undefined, { signal: init.signal });
      return json(200, { ok: true });
    });
    const built = createErpHttpTransport({
      base_url: BASE_URL,
      hmac_secret: SECRET,
      hmac,
      timeout_ms: 10,
      fetch: aborting,
    });

    const result = await built.request({ method: 'GET', path: CATALOG_PATH, tenant_id: 'tenant-a' });

    expect(result).toEqual({ ok: false, failure_class: 'TIMEOUT', status: null });
    expect(aborting).toHaveBeenCalledTimes(1);
  });

  it('classifies a transport error with no deadline as indeterminate', async () => {
    const { request } = transport([new Error('ECONNRESET')]);

    const result = await request({ method: 'GET', path: CATALOG_PATH, tenant_id: 'tenant-a' });

    expect(result).toEqual({ ok: false, failure_class: 'UNKNOWN', status: null });
  });

  it('refuses a route outside the configured base path without calling the provider', async () => {
    const { calls, request } = transport([json(200, { ok: true })], {
      base_url: 'http://erp.internal:8081/erp',
    });

    const result = await request({ method: 'GET', path: CATALOG_PATH, tenant_id: 'tenant-a' });

    expect(result).toEqual({ ok: false, failure_class: 'PROVIDER_REJECTED', status: null });
    expect(calls).toHaveLength(0);
  });

  it('never returns signature material or provider payload in a failure', async () => {
    const { request } = transport([json(500, { code: 'SENTINEL_PROVIDER_BODY' })]);

    const result = await request({ method: 'GET', path: CATALOG_PATH, tenant_id: 'tenant-a' });

    const serialized = JSON.stringify(result);
    expect(serialized.includes(SECRET)).toBe(false);
    expect(serialized.includes('SENTINEL_PROVIDER_BODY')).toBe(false);
  });

  it('refuses a configuration that cannot address a provider', () => {
    const invalid: readonly Partial<Parameters<typeof createErpHttpTransport>[0]>[] = [
      { base_url: 'not-a-url' },
      { base_url: 'ftp://erp.internal' },
      { hmac_secret: '' },
      { timeout_ms: 0 },
    ];

    for (const override of invalid) {
      expect(() =>
        createErpHttpTransport({
          base_url: BASE_URL,
          hmac_secret: SECRET,
          hmac,
          ...override,
        }),
      ).toThrow();
    }
  });
});
