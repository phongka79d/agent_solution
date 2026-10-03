
import type { ErpTransport, ErpTransportFailureClass, ErpTransportRequest } from './erp/api-001-erp.js';
import { signMockRequest, type HmacSha256Hex } from './base/signature.js';
import type { ConnectorAuthScheme, ConnectorCatalogEntry, ConnectorProbe } from './catalog.js';

export interface ConnectorProbeCheck {
  readonly probe: ConnectorProbe;
  readonly outcome: 'PASS' | 'FAIL';
  readonly latency_ms: number;
  readonly http_status: number | null;
  readonly error_class: string | null;
}

export interface ConnectorProbeResult {
  readonly outcome: 'PASS' | 'FAIL';
  readonly checks: readonly ConnectorProbeCheck[];
}

export interface ConnectorFetchResponse {
  readonly status: number;
  text(): Promise<string>;
}

export type ConnectorFetch = (
  url: string,
  init: { readonly method: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string; readonly signal?: AbortSignal },
) => Promise<ConnectorFetchResponse>;

export interface ConnectorHttpTransportOptions {
  readonly base_url: string;
  readonly auth_scheme: ConnectorAuthScheme;
  readonly secret: string;
  readonly tenant_id: string;
  readonly fetchImpl?: ConnectorFetch;
  readonly timeoutMs?: number;
  readonly hmacSha256Hex?: HmacSha256Hex;
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
const API001_PROBES: Readonly<Record<ConnectorProbe, { readonly method: 'GET' | 'POST'; readonly path: string; readonly body?: (tenant_id: string) => Record<string, unknown> }>> = {
  catalog: { method: 'GET', path: '/api/v1/catalog/items' },
  inventory: { method: 'POST', path: '/api/v1/inventory/lookup', body: (tenant_id) => ({ tenant_id, sku_ids: [] }) },
  customers: { method: 'POST', path: '/api/v1/customers/lookup', body: (tenant_id) => ({ tenant_id, customer_id: 'connector-probe' }) },
  orders: { method: 'POST', path: '/api/v1/orders/status', body: (tenant_id) => ({ tenant_id, key: 'connector-probe', customer_id: 'connector-probe' }) },
};

/** Creates the bounded host transport consumed by API-001 and connector probes. */
export function createConnectorHttpTransport(options: ConnectorHttpTransportOptions): ErpTransport {
  const parsed = new URL(options.base_url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('CONNECTOR_BASE_URL_INVALID');
  }
  const basePath = parsed.pathname.replace(/\/+$/, '');
  const origin = parsed.origin;
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) throw new Error('CONNECTOR_TIMEOUT_INVALID');
  if (options.tenant_id.length === 0 || options.secret.length === 0) throw new Error('CONNECTOR_CREDENTIAL_REQUIRED');
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as ConnectorFetch);
  const hmacSha256Hex = options.hmacSha256Hex;
  if (options.auth_scheme === 'HMAC_MOCK' && hmacSha256Hex === undefined) throw new Error('CONNECTOR_HMAC_UNAVAILABLE');

  return {
    request: async (input: ErpTransportRequest) => {
      if (input.tenant_id !== options.tenant_id) return { ok: false, failure_class: 'PROVIDER_REJECTED', status: null };
      if (basePath !== '' && input.path !== basePath && !input.path.startsWith(`${basePath}/`)) {
        return { ok: false, failure_class: 'PROVIDER_REJECTED', status: null };
      }
      const body = input.body === undefined ? '' : JSON.stringify(input.body);
      const headers: Record<string, string> = { accept: 'application/json', 'x-tenant-id': input.tenant_id };
      if (input.method === 'POST') headers['content-type'] = 'application/json';
      if (input.idempotency_key !== undefined) {
        if (input.method !== 'POST' || input.idempotency_key.trim().length === 0) {
          return { ok: false, failure_class: 'PROVIDER_REJECTED', status: null };
        }
        headers['idempotency-key'] = input.idempotency_key;
      }
      if (options.auth_scheme === 'HMAC_MOCK') {
        headers['x-mock-signature'] = signMockRequest(options.secret, input.method, input.path, body, hmacSha256Hex as HmacSha256Hex);
      } else if (options.auth_scheme === 'BEARER') {
        headers.authorization = `Bearer ${options.secret}`;
      } else {
        const separator = options.secret.indexOf(':');
        if (separator < 1) return { ok: false, failure_class: 'PROVIDER_REJECTED', status: null };
        headers.authorization = `Basic ${base64Utf8(options.secret)}`;
      }
      const deadline = AbortSignal.timeout(timeoutMs);
      const signal = input.signal === undefined ? deadline : AbortSignal.any([deadline, input.signal]);
      try {
        const response = await fetchImpl(`${origin}${input.path}`, {
          method: input.method,
          headers,
          ...(input.method === 'POST' ? { body } : {}),
          signal,
        });
        if (response.status < 200 || response.status >= 300) {
          return { ok: false, failure_class: classifyHttp(response.status), status: response.status };
        }
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(await response.text()) as unknown;
        } catch {
          return { ok: false, failure_class: 'UNKNOWN', status: response.status };
        }
        if (parsedBody === null || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
          return { ok: false, failure_class: 'UNKNOWN', status: response.status };
        }
        return { ok: true, status: response.status, body: parsedBody as Record<string, unknown> };
      } catch {
        return { ok: false, failure_class: deadline.aborted ? 'TIMEOUT' : 'UNKNOWN', status: null };
      }
    },
  };
}

/** Runs catalog-declared, read-only checks. No response body, URL, credential, or provider error is returned. */
export async function runConnectorProbe(input: {
  readonly entry: ConnectorCatalogEntry;
  readonly config: Readonly<Record<string, unknown>>;
  readonly secret: string | null;
  readonly fetchImpl?: ConnectorFetch;
  readonly timeoutMs?: number;
  readonly hmacSha256Hex?: HmacSha256Hex;
}): Promise<ConnectorProbeResult> {
  const probes = input.entry.probes;
  if (probes.length === 0 || !input.entry.integrated) {
    return { outcome: 'FAIL', checks: probes.map((probe) => ({ probe, outcome: 'FAIL', latency_ms: 0, http_status: null, error_class: 'NOT_INTEGRATED' })) };
  }
  const base_url = input.config.base_url;
  const tenant_id = input.config.tenant_id;
  const auth_scheme = input.config.auth_scheme ?? 'HMAC_MOCK';
  if (typeof base_url !== 'string' || typeof tenant_id !== 'string' || typeof auth_scheme !== 'string' || !input.entry.auth_schemes.includes(auth_scheme as ConnectorAuthScheme) || input.secret === null) {
    return { outcome: 'FAIL', checks: probes.map((probe) => ({ probe, outcome: 'FAIL', latency_ms: 0, http_status: null, error_class: 'CONFIGURATION_INVALID' })) };
  }

  let transport: ErpTransport;
  try {
    transport = createConnectorHttpTransport({
      base_url,
      auth_scheme: auth_scheme as ConnectorAuthScheme,
      secret: input.secret,
      tenant_id,
      ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
      ...(input.hmacSha256Hex === undefined ? {} : { hmacSha256Hex: input.hmacSha256Hex }),
    });
  } catch {
    return { outcome: 'FAIL', checks: probes.map((probe) => ({ probe, outcome: 'FAIL', latency_ms: 0, http_status: null, error_class: 'CONFIGURATION_INVALID' })) };
  }

  const checks = await Promise.all(probes.map(async (probe): Promise<ConnectorProbeCheck> => {
    const descriptor = API001_PROBES[probe];
    if (descriptor === undefined || input.entry.connector_id !== 'API-001') {
      return { probe, outcome: 'FAIL', latency_ms: 0, http_status: null, error_class: 'NOT_INTEGRATED' };
    }
    const start = Date.now();
    const request = {
      method: descriptor.method,
      path: descriptor.path,
      tenant_id,
      ...(descriptor.body === undefined ? {} : { body: descriptor.body(tenant_id) }),
    } as ErpTransportRequest;
    const result = await withinTimeout(transport.request(request), input.timeoutMs ?? 10_000);
    const latency_ms = Math.max(0, Date.now() - start);
    if (result === null) return { probe, outcome: 'FAIL', latency_ms, http_status: null, error_class: 'TIMEOUT' };
    if (result.ok) return { probe, outcome: 'PASS', latency_ms, http_status: result.status, error_class: null };
    const placeholderLookup = (probe === 'customers' || probe === 'orders') && (result.status === 400 || result.status === 404);
    return placeholderLookup
      ? { probe, outcome: 'PASS', latency_ms, http_status: result.status, error_class: null }
      : { probe, outcome: 'FAIL', latency_ms, http_status: result.status, error_class: result.failure_class };
  }));
  return { outcome: checks.every((check) => check.outcome === 'PASS') ? 'PASS' : 'FAIL', checks };
}

function withinTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    operation,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function classifyHttp(status: number): ErpTransportFailureClass {
  if (status === 408 || status === 429) return 'TIMEOUT';
  if (status >= 400 && status < 500) return 'PROVIDER_REJECTED';
  return 'UNKNOWN';
}
