import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

import { CANONICAL_EVENTS, CATALOG_ITEM, CUSTOMER, TENANT_ID, WAREHOUSE } from './fixtures.mjs';
import { signBody, signaturesMatch } from './hmac.mjs';

const MANAGED = new Set(['staging', 'sandbox', 'production']);

export function assertBootEnv(env = process.env) {
  const appEnv = env.APP_ENV ?? '';
  if (appEnv !== 'local' && appEnv !== 'ci') {
    const where = MANAGED.has(appEnv) ? appEnv : 'missing or unknown';
    return {
      ok: false,
      stderr: `FATAL: Environment validation failed\n  [APP_ENV] mock-erp refuses to start for APP_ENV=${where}; this simulator is local/CI only\n`,
    };
  }
  const secret = env.MOCK_SECRET_KEY ?? '';
  if (secret.length < 16) {
    return {
      ok: false,
      stderr: 'FATAL: Environment validation failed\n  [MOCK_SECRET_KEY] MOCK_SECRET_KEY is required and must be at least 16 characters\n',
    };
  }
  const latency = env.SIMULATE_LATENCY_MS === undefined || env.SIMULATE_LATENCY_MS === ''
    ? 50
    : Number(env.SIMULATE_LATENCY_MS);
  if (!Number.isInteger(latency) || latency < 0) {
    return {
      ok: false,
      stderr: 'FATAL: Environment validation failed\n  [SIMULATE_LATENCY_MS] SIMULATE_LATENCY_MS must be an integer >= 0\n',
    };
  }
  const failure = env.SIMULATE_FAILURE_RATE === undefined || env.SIMULATE_FAILURE_RATE === ''
    ? 0
    : Number(env.SIMULATE_FAILURE_RATE);
  if (!Number.isFinite(failure) || failure < 0 || failure > 1) {
    return {
      ok: false,
      stderr: 'FATAL: Environment validation failed\n  [SIMULATE_FAILURE_RATE] SIMULATE_FAILURE_RATE must be a float from 0 to 1\n',
    };
  }
  return { ok: true, appEnv, secret, latency, failure };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonicalize(value[key]);
      return acc;
    }, {});
  }
  return value;
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function tenantMatches(req, body) {
  const header = req.headers['x-tenant-id'];
  return typeof header === 'string' && body && header === body.tenant_id;
}

export function createServer(env = process.env, deps = {}) {
  const boot = assertBootEnv(env);
  if (!boot.ok) {
    const error = new Error('mock-erp boot refused');
    error.stderr = boot.stderr;
    error.exitCode = 1;
    throw error;
  }
  const effects = deps.effects ?? new Map();
  const random = deps.random ?? Math.random;
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/ready')) {
      send(res, 200, { status: url.pathname === '/health' ? 'ok' : 'ready' });
      return;
    }

    const raw = await readBody(req);
    let body = {};
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        send(res, 400, { code: 'INVALID_JSON' });
        return;
      }
    }

    const expected = signBody(boot.secret, raw);
    const provided = req.headers['x-mock-signature'];
    if (!signaturesMatch(expected, typeof provided === 'string' ? provided : '')) {
      send(res, 401, { code: 'SIGNATURE_INVALID' });
      return;
    }
    if (!tenantMatches(req, body)) {
      send(res, 401, { code: 'TENANT_MISMATCH' });
      return;
    }
    if (random() < boot.failure) {
      send(res, 504, { outcome: 'UNKNOWN' });
      return;
    }
    if (boot.latency > 0) await sleep(boot.latency);

    if (req.method === 'GET' && url.pathname === '/api/v1/catalog/items') {
      send(res, 200, { items: [CATALOG_ITEM] });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/inventory/lookup') {
      const skuIds = Array.isArray(body.sku_ids) ? body.sku_ids : [];
      if (skuIds.some((sku) => sku !== CATALOG_ITEM.sku)) {
        send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
        return;
      }
      send(res, 200, skuIds.map((sku) => ({
        tenant_id: body.tenant_id,
        sku_id: sku,
        total_available_to_promise: WAREHOUSE.available_to_promise,
        in_stock: true,
        warehouse_breakdown: [WAREHOUSE],
        snapshot_at: new Date().toISOString(),
      })));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/prices/lookup') {
      if (body.sku_id !== CATALOG_ITEM.sku) {
        send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
        return;
      }
      send(res, 409, {
        code: 'P_FLOOR_UNAVAILABLE',
        tenant_id: body.tenant_id,
        sku_id: body.sku_id,
        original_list_price: CATALOG_ITEM.original_list_price,
        currency: CATALOG_ITEM.currency,
        floor_price_source: 'unavailable',
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/orders/draft') {
      if (!body.effect_key || !body.tenant_id) {
        send(res, 422, { code: 'EFFECT_KEY_REQUIRED' });
        return;
      }
      const key = `${body.tenant_id}:${body.effect_key}`;
      const canonical = JSON.stringify(canonicalize(body));
      const existing = effects.get(key);
      if (existing) {
        if (existing.canonical !== canonical) {
          send(res, 409, { code: 'IDEMPOTENCY_CONFLICT' });
          return;
        }
        send(res, existing.status, existing.body);
        return;
      }
      const receipt = {
        code: 'P_FLOOR_UNAVAILABLE',
        refusal_id: randomUUID(),
        effect_key: body.effect_key,
        tenant_id: body.tenant_id,
        status: 'refused',
        reserved: false,
      };
      effects.set(key, { canonical, status: 409, body: receipt });
      send(res, 409, receipt);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/orders/status') {
      send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/customers/lookup') {
      if (body.customer_id !== CUSTOMER.customer_id) {
        send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
        return;
      }
      send(res, 200, CUSTOMER);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/customers/sales-history') {
      if (body.customer_id !== CUSTOMER.customer_id) {
        send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
        return;
      }
      send(res, 200, {
        tenant_id: body.tenant_id,
        customer_id: CUSTOMER.customer_id,
        currency: 'TWD',
        lifetime_spend: 0,
        total_order_count: 0,
        completed_order_count: 0,
        returned_order_count: 0,
        average_order_value: 0,
        recent_orders: [],
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/invoices/lookup') {
      send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/events/v1') {
      if (!CANONICAL_EVENTS.includes(body.canonical_event)) {
        send(res, 422, { code: 'CANONICAL_EVENT_REJECTED' });
        return;
      }
      send(res, 202, { accepted: true, canonical_event: body.canonical_event, tenant_id: body.tenant_id });
      return;
    }
    send(res, 404, { code: 'NOT_FOUND' });
  });

  return server;
}

export function listen(env = process.env, deps = {}) {
  const boot = assertBootEnv(env);
  if (!boot.ok) {
    process.stderr.write(boot.stderr);
    process.exit(boot.exitCode ?? 1);
  }
  const port = Number(env.PORT ?? 8081);
  const server = createServer(env, deps);
  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => resolve(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  listen().catch((error) => {
    process.stderr.write(error.stderr ?? `FATAL: ${error.message}\n`);
    process.exit(error.exitCode ?? 1);
  });
}
