import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { CANONICAL_EVENTS, CATALOG_ITEM, CUSTOMER, TENANT_ID, WAREHOUSE } from './fixtures.mjs';
import { signBody, signaturesMatch } from './hmac.mjs';

const MANAGED = new Set(['staging', 'sandbox', 'production']);

/** The API-001 mutating path (`06` §2, `ERP_ACTION_PATH_TEMPLATE`) with a bounded action id. */
const ACTION_PATH = /^\/api\/v1\/actions\/([A-Za-z0-9._:-]{1,128})$/;

const ORDERS_FIXTURE_URL = new URL('../../../testcases/fixtures/offline/orders.json', import.meta.url);

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
  const swallowAfterWrite = parseSwitch(env.SIMULATE_SWALLOW_AFTER_WRITE, false);
  if (swallowAfterWrite === null) {
    return {
      ok: false,
      stderr: 'FATAL: Environment validation failed\n  [SIMULATE_SWALLOW_AFTER_WRITE] SIMULATE_SWALLOW_AFTER_WRITE must be 0, 1, true or false\n',
    };
  }

  return { ok: true, appEnv, secret, latency, failure, swallowAfterWrite };
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

/**
 * Resolves the tenant a request is scoped to.
 *
 * The scope always comes from the signed caller's header, never from the body: when a body carries
 * its own `tenant_id` the two must agree, and a caller that presents neither is refused. A read has
 * no body at all, so the header is the only scope a GET can carry.
 *
 * @returns The tenant id, or `null` when the request is unscoped or internally inconsistent.
 */
function tenantScope(req, body) {
  const header = req.headers['x-tenant-id'];
  if (typeof header !== 'string' || header.length === 0) return null;

  const declared = body && typeof body.tenant_id === 'string' ? body.tenant_id : null;
  if (declared !== null && declared !== header) return null;

  return header;
}

/** Parses a 0/1/true/false simulation switch; `undefined` yields the fallback. */
function parseSwitch(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return null;
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
  const actions = deps.actions ?? new Map();
  const random = deps.random ?? Math.random;
  const now = deps.now ?? (() => new Date());
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
    const scope = tenantScope(req, body);
    if (scope === null) {
      send(res, 401, { code: 'TENANT_MISMATCH' });
      return;
    }
    if (random() < boot.failure) {
      send(res, 504, { outcome: 'UNKNOWN' });
      return;
    }
    if (boot.latency > 0) await sleep(boot.latency);
    if (req.method === 'GET' && url.pathname === '/api/v1/catalog/items') {
      if (scope !== TENANT_ID) {
        send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
        return;
      }
      send(res, 200, { items: [CATALOG_ITEM], snapshot_at: now().toISOString() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/inventory/lookup') {
      if (scope !== TENANT_ID) {
        send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
        return;
      }
      const skuIds = Array.isArray(body.sku_ids) ? body.sku_ids : [];
      if (skuIds.some((sku) => sku !== CATALOG_ITEM.sku)) {
        send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
        return;
      }
      send(res, 200, {
        snapshot_at: now().toISOString(),
        items: skuIds.map((sku) => ({
          tenant_id: scope,
          sku_id: sku,
          total_available_to_promise: WAREHOUSE.available_to_promise,
          available_quantity: WAREHOUSE.available_to_promise,
          in_stock: WAREHOUSE.available_to_promise > 0,
          warehouse_breakdown: [WAREHOUSE],
        })),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/prices/lookup') {
      if (scope !== TENANT_ID || body.sku_id !== CATALOG_ITEM.sku) {
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
      const orderRef = typeof body?.key === 'string'
        ? body.key
        : (typeof body?.order_identifier === 'string'
          ? body.order_identifier
          : (typeof body?.order_id === 'string' ? body.order_id : null));
      if (!orderRef) {
        send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
        return;
      }
      let orders = [];
      try {
        const raw = await readFile(ORDERS_FIXTURE_URL, 'utf8');
        const parsed = JSON.parse(raw);
        orders = Array.isArray(parsed.orders) ? parsed.orders : [];
      } catch {
        send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
        return;
      }
      const match = orders.find(
        (o) => o.tenant_id === scope && (o.order_id === orderRef || o.order_number === orderRef),
      );
      if (!match) {
        send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
        return;
      }
      if (body?.customer_id !== undefined && match.customer_id !== body.customer_id) {
        send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
        return;
      }
      send(res, 200, {
        snapshot_at: new Date().toISOString(),
        ...match,
      });
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
    // The API-001 action boundary (`/api/v1/actions/{action_id}`). A mutation is recorded before any
    // simulated failure, so a lost response still leaves a provable effect that reconciliation can
    // find by `action_id` — the one scenario a retry loop must never resolve by guessing.
    const action = ACTION_PATH.exec(url.pathname);
    if (action !== null && (req.method === 'POST' || req.method === 'GET')) {
      const action_id = decodeURIComponent(action[1]);
      const key = `${scope}:${action_id}`;
      const existing = actions.get(key);

      if (req.method === 'GET') {
        if (existing === undefined) {
          send(res, 404, { code: 'ACTION_NOT_FOUND', action_id, tenant_id: scope });
          return;
        }
        send(res, 200, existing.body);
        return;
      }

      const canonical = JSON.stringify(canonicalize(body));
      if (existing !== undefined) {
        if (existing.canonical !== canonical) {
          send(res, 409, { code: 'IDEMPOTENCY_CONFLICT', action_id, tenant_id: scope });
          return;
        }
        send(res, existing.status, existing.body);
        return;
      }

      const envelope = {
        action_id,
        tenant_id: scope,
        status: 'accepted',
        provider_reference: `MOCK-ERP:${scope}:${action_id}`,
        snapshot_at: now().toISOString(),
      };
      actions.set(key, { canonical, status: 200, body: envelope });

      if (boot.swallowAfterWrite) {
        send(res, 504, { outcome: 'UNKNOWN', action_id, tenant_id: scope });
        return;
      }

      send(res, 200, envelope);
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
