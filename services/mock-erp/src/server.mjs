import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CANONICAL_EVENTS, CATALOG_ITEM, CUSTOMER, TENANT_ID, WAREHOUSE } from './fixtures.mjs';
import { signRequest, signaturesMatch } from './hmac.mjs';

const MANAGED = new Set(['staging', 'sandbox', 'production']);
const MAX_BODY_BYTES = 1024 * 1024;
const ORDER_PAYMENT_METHODS = new Set([
  'CREDIT_CARD',
  'CVS_COD',
  'LINE_PAY',
  'JKOPAY',
  'STRIPE',
  'PAYPAL',
]);

/** The API-001 mutating path (`06` §2, `ERP_ACTION_PATH_TEMPLATE`) with a bounded encoded id. */
const ACTION_PATH = /^\/api\/v1\/actions\/([^/]{1,512})$/;

const ORDERS_FIXTURE_URL = new URL('../../../testcases/fixtures/offline/orders.json', import.meta.url);
const DEMO_PACK_NAME = 'novamart';
const DEMO_PACK_URL = new URL('./demo/novamart.json', import.meta.url);
const DEMO_PACK_TTL_SECONDS = 900;
function resolveOrdersFixture(env, deps) {
  const configured = deps.ordersFixturePath ?? env.MOCK_ERP_ORDERS_FIXTURE_PATH;
  if (configured === undefined || configured === '') return ORDERS_FIXTURE_URL;
  if (typeof configured !== 'string' || isAbsolute(configured)) {
    throw new Error('mock-erp orders fixture path must be relative to the offline fixture root');
  }
  const root = fileURLToPath(new URL('../../../testcases/fixtures/offline/', import.meta.url));
  const candidate = resolve(root, configured);
  const withinRoot = relative(root, candidate);
  if (withinRoot === '' || withinRoot.startsWith('..') || isAbsolute(withinRoot)) {
    throw new Error('mock-erp orders fixture path escapes the offline fixture root');
  }
  return pathToFileURL(candidate);
}
function loadDemoPack() {
  let pack;
  try {
    pack = JSON.parse(readFileSync(DEMO_PACK_URL, 'utf8'));
  } catch {
    throw new Error('mock-erp demo pack could not be loaded');
  }
  if (
    pack === null
    || typeof pack !== 'object'
    || pack.pack_version !== 'novamart-demo-v1'
    || pack.tenant_id !== '99999999-9999-4999-8999-999999999999'
    || pack.currency !== 'VND'
    || !Array.isArray(pack.skus)
    || pack.skus.length !== 28
    || !Array.isArray(pack.customers)
    || !Array.isArray(pack.orders)
  ) {
    throw new Error('mock-erp demo pack is invalid');
  }
  const skuIds = new Set();
  for (const sku of pack.skus) {
    if (
      sku === null
      || typeof sku !== 'object'
      || sku.tenant_id !== pack.tenant_id
      || typeof sku.sku_id !== 'string'
      || skuIds.has(sku.sku_id)
    ) {
      throw new Error('mock-erp demo pack is invalid');
    }
    skuIds.add(sku.sku_id);
  }
  if (
    pack.customers.some((customer) => customer?.tenant_id !== pack.tenant_id)
    || pack.orders.some((order) => order?.tenant_id !== pack.tenant_id)
  ) {
    throw new Error('mock-erp demo pack is invalid');
  }
  return pack;
}

function unavailable(res) {
  send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
}

function demoSku(pack, skuId) {
  return pack.skus.find((sku) => sku.sku_id === skuId) ?? null;
}
function fixtureSku(tenantId, skuId, demoPack, simulatedData) {
  if (demoPack && tenantId === demoPack.tenant_id) return demoSku(demoPack, skuId);
  const seededSku = simulatedData.get(tenantId)?.products.get(skuId);
  if (seededSku) return seededSku;
  if (tenantId === TENANT_ID && skuId === CATALOG_ITEM.sku) {
    return {
      tenant_id: TENANT_ID,
      sku_id: CATALOG_ITEM.sku,
      name: CATALOG_ITEM.name,
      list_price: CATALOG_ITEM.original_list_price,
      original_list_price: CATALOG_ITEM.original_list_price,
      currency: CATALOG_ITEM.currency,
      available_quantity: WAREHOUSE.available_to_promise,
      total_available_to_promise: WAREHOUSE.available_to_promise,
      physical_qty: WAREHOUSE.physical_qty,
      reserved_qty: WAREHOUSE.reserved_qty,
      warehouse_breakdown: [WAREHOUSE],
    };
  }
  return null;
}

function withAvailableStock(sku, available) {
  const originalAvailable = sku.total_available_to_promise ?? sku.available_quantity ?? 0;
  const decrease = originalAvailable - available;
  let remaining = Math.max(decrease, 0);
  const warehouse_breakdown = Array.isArray(sku.warehouse_breakdown)
    ? sku.warehouse_breakdown.map((warehouse) => {
      const removed = Math.min(remaining, warehouse.available_to_promise ?? 0);
      remaining -= removed;
      return {
        ...warehouse,
        physical_qty: Math.max(0, (warehouse.physical_qty ?? 0) - removed),
        available_to_promise: Math.max(0, (warehouse.available_to_promise ?? 0) - removed),
      };
    })
    : [];
  return {
    total_available_to_promise: available,
    available_quantity: available,
    in_stock: available > 0,
    physical_qty: Math.max(0, (sku.physical_qty ?? originalAvailable) - Math.max(decrease, 0)),
    warehouse_breakdown,
  };
}

function recordId(record, type) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const id = type === 'customer'
    ? record.customer_id
    : (record.order_id ?? record.order_number);
  return typeof id === 'string' && id.length > 0 ? id : null;
}

function testRecord(record, tenantId, type) {
  const id = recordId(record, type);
  if (id === null || (record.tenant_id !== undefined && record.tenant_id !== tenantId)) return null;
  if (type === 'order' && typeof record.customer_id !== 'string') return null;
  return { ...record, tenant_id: tenantId, data_class: 'TEST' };
}
function testProduct(record, tenantId) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  if (record.tenant_id !== undefined && record.tenant_id !== tenantId) return null;
  const skuId = typeof record.sku_id === 'string' ? record.sku_id.trim() : '';
  const name = typeof record.name === 'string' ? record.name.trim() : '';
  const listPrice = record.list_price ?? record.original_list_price;
  const originalListPrice = record.original_list_price ?? listPrice;
  const floorPrice = record.floor_price ?? record.p_floor;
  const currency = typeof record.currency === 'string' ? record.currency : '';
  if (
    skuId.length === 0
    || skuId.length > 256
    || name.length === 0
    || !Number.isSafeInteger(listPrice)
    || listPrice < 0
    || !Number.isSafeInteger(originalListPrice)
    || originalListPrice < listPrice
    || !Number.isSafeInteger(floorPrice)
    || floorPrice < 0
    || floorPrice > listPrice
    || !/^[A-Z]{3}$/.test(currency)
    || (record.is_active !== undefined && typeof record.is_active !== 'boolean')
    || (record.images !== undefined && (!Array.isArray(record.images) || record.images.some((image) => typeof image !== 'string')))
    || (record.attributes !== undefined && (
      record.attributes === null || typeof record.attributes !== 'object' || Array.isArray(record.attributes)
    ))
  ) {
    return null;
  }
  const floorPriceSource = typeof record.floor_price_source === 'string' && record.floor_price_source.length > 0
    ? record.floor_price_source
    : 'seeded_test_fixture';
  return {
    tenant_id: tenantId,
    data_class: 'TEST',
    product_id: typeof record.product_id === 'string' && record.product_id.length > 0
      ? record.product_id
      : skuId,
    sku_id: skuId,
    name,
    brand: typeof record.brand === 'string' ? record.brand : '',
    category: typeof record.category === 'string' ? record.category : '',
    use_case: typeof record.use_case === 'string' ? record.use_case : '',
    key_attribute: typeof record.key_attribute === 'string' ? record.key_attribute : '',
    description: typeof record.description === 'string' ? record.description : '',
    attributes: record.attributes ?? {},
    currency,
    list_price: listPrice,
    original_list_price: originalListPrice,
    floor_price: floorPrice,
    floor_price_source: floorPriceSource,
    is_active: record.is_active ?? true,
    images: record.images ?? [],
  };
}

function testInventory(record, productIds) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const skuId = typeof record.sku_id === 'string' ? record.sku_id : '';
  const available = record.available_quantity;
  const physical = record.physical_qty ?? available;
  const reserved = record.reserved_qty ?? 0;
  if (
    !productIds.has(skuId)
    || !Number.isSafeInteger(available)
    || available < 0
    || !Number.isSafeInteger(physical)
    || physical < 0
    || !Number.isSafeInteger(reserved)
    || reserved < 0
    || physical < available + reserved
    || (record.warehouse_id !== undefined && typeof record.warehouse_id !== 'string')
  ) {
    return null;
  }
  return {
    sku_id: skuId,
    available_quantity: available,
    physical_qty: physical,
    reserved_qty: reserved,
    warehouse_id: record.warehouse_id ?? 'TEST',
  };
}

function withSeededInventory(product, inventory) {
  const available = inventory?.available_quantity ?? 0;
  const physical = inventory?.physical_qty ?? available;
  const reserved = inventory?.reserved_qty ?? 0;
  const warehouse = {
    warehouse_id: inventory?.warehouse_id ?? 'TEST',
    physical_qty: physical,
    reserved_qty: reserved,
    available_to_promise: available,
  };
  return {
    ...product,
    available_quantity: available,
    total_available_to_promise: available,
    physical_qty: physical,
    reserved_qty: reserved,
    warehouse_breakdown: [warehouse],
  };
}


function demoCatalogProjection(sku) {
  return {
    tenant_id: sku.tenant_id,
    product_id: sku.product_id,
    sku: sku.sku_id,
    sku_id: sku.sku_id,
    brand: sku.brand,
    name: sku.name,
    category: sku.category,
    use_case: sku.use_case,
    key_attribute: sku.key_attribute,
    description: sku.description,
    attributes: sku.attributes,
    currency: sku.currency,
    list_price: sku.list_price,
    original_list_price: sku.original_list_price,
    is_active: sku.is_active,
    images: sku.images,
  };
}

export function assertBootEnv(env = process.env) {
  const appEnv = env.APP_ENV ?? '';
  if (appEnv !== 'local' && appEnv !== 'ci') {
    const where = MANAGED.has(appEnv) ? appEnv : 'missing or unknown';
    return {
      ok: false,
      stderr: `FATAL: Environment validation failed\n  [APP_ENV] mock-erp refuses to start for APP_ENV=${where}; this simulator is local/CI only\n`,
    };
  }
  const demoPack = typeof env.MOCK_ERP_DEMO_PACK === 'string'
    ? env.MOCK_ERP_DEMO_PACK.trim()
    : '';
  if (demoPack !== '' && demoPack !== DEMO_PACK_NAME) {
    return {
      ok: false,
      stderr: `FATAL: Environment validation failed\n  [MOCK_ERP_DEMO_PACK] unknown demo pack '${demoPack}'\n`,
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

  return { ok: true, appEnv, secret, latency, failure, swallowAfterWrite, demoPack: demoPack || null };
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

function readBody(req, maxBytes) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(tooLarge ? null : Buffer.concat(chunks)));
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
  const demoPack = boot.demoPack === DEMO_PACK_NAME ? loadDemoPack() : null;
  const ordersFixture = resolveOrdersFixture(env, deps);
  const effects = deps.effects ?? new Map();
  const actions = deps.actions ?? new Map();
  const random = deps.random ?? Math.random;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const simulation = {
    failure_rate: boot.failure,
    latency_ms: boot.latency,
    swallow_after_write: boot.swallowAfterWrite,
  };
  const simulatedData = new Map();
  const orderRequests = new Map();
  const cartRequests = new Map();
  function tenantData(tenantId) {
    let data = simulatedData.get(tenantId);
    if (!data) {
      data = { customers: [], orders: [], createdOrders: [], products: new Map(), stock: new Map(), carts: new Map() };
      simulatedData.set(tenantId, data);
    }
    return data;
  }
  function customerFor(tenantId, customerId) {
    const testCustomer = tenantData(tenantId).customers
      .find((customer) => customer.customer_id === customerId);
    if (testCustomer) return testCustomer;
    if (demoPack?.tenant_id === tenantId) {
      return demoPack.customers.find((customer) => customer.customer_id === customerId) ?? null;
    }
    return tenantId === TENANT_ID && CUSTOMER.customer_id === customerId ? CUSTOMER : null;
  }
  function availableStock(tenantId, sku) {
    const data = tenantData(tenantId);
    if (data.stock.has(sku.sku_id)) return data.stock.get(sku.sku_id);
    return sku.total_available_to_promise ?? sku.available_quantity ?? 0;
  }
  function tenantSimOrders(tenantId) {
    const data = tenantData(tenantId);
    return [...data.orders, ...data.createdOrders];
  }


  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/ready')) {
      send(res, 200, { status: url.pathname === '/health' ? 'ok' : 'ready' });
      return;
    }

    const raw = await readBody(req, MAX_BODY_BYTES);
    if (raw === null) {
      send(res, 413, { code: 'REQUEST_BODY_TOO_LARGE' });
      return;
    }
    let body = {};
    if (raw.length > 0) {
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        send(res, 400, { code: 'INVALID_JSON' });
        return;
      }
    }

    const expected = signRequest(boot.secret, req.method ?? 'GET', url.pathname, raw);
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
    if (url.pathname.startsWith('/__sim/') && !['local', 'ci'].includes(boot.appEnv)) {
      send(res, 404, { code: 'NOT_FOUND' });
      return;
    }
    const simulationRoute = url.pathname.startsWith('/__sim/');
    if (!simulationRoute && random() < simulation.failure_rate) {
      send(res, 504, { outcome: 'UNKNOWN' });
      return;
    }
    if (!simulationRoute && simulation.latency_ms > 0) await sleep(simulation.latency_ms);

    if (simulationRoute) {
      if (req.method === 'POST' && url.pathname === '/__sim/seed') {
        const productsInput = body.products === undefined ? [] : body.products;
        const inventoryInput = body.inventory === undefined ? [] : body.inventory;
        if (
          !Array.isArray(body.customers)
          || !Array.isArray(body.orders)
          || !Array.isArray(productsInput)
          || !Array.isArray(inventoryInput)
        ) {
          send(res, 422, { code: 'SIM_SEED_INVALID' });
          return;
        }
        const customers = body.customers.map((record) => testRecord(record, scope, 'customer'));
        const orders = body.orders.map((record) => testRecord(record, scope, 'order'));
        const products = productsInput.map((record) => testProduct(record, scope));
        if (customers.includes(null) || orders.includes(null) || products.includes(null)) {
          send(res, 422, { code: 'SIM_SEED_INVALID' });
          return;
        }
        const productIds = new Set(products.map((product) => product.sku_id));
        if (productIds.size !== products.length) {
          send(res, 409, { code: 'SIM_SEED_CONFLICT' });
          return;
        }
        const inventory = inventoryInput.map((record) => testInventory(record, productIds));
        if (inventory.includes(null)) {
          send(res, 422, { code: 'SIM_SEED_INVALID' });
          return;
        }
        const inventoryBySku = new Map(inventory.map((record) => [record.sku_id, record]));
        if (inventoryBySku.size !== inventory.length) {
          send(res, 409, { code: 'SIM_SEED_CONFLICT' });
          return;
        }
        const data = simulatedData.get(scope);
        const customerIds = new Set((data?.customers ?? []).map((record) => record.customer_id));
        if (customers.some((record) => customerIds.has(record.customer_id))) {
          send(res, 409, { code: 'SIM_SEED_CONFLICT' });
          return;
        }
        const orderIds = new Set((data?.orders ?? []).flatMap((record) => [record.order_id, record.order_number]).filter(Boolean));
        if (orders.some((record) => [record.order_id, record.order_number].some((id) => id && orderIds.has(id)))) {
          send(res, 409, { code: 'SIM_SEED_CONFLICT' });
          return;
        }
        if (products.some((product) => data?.products.has(product.sku_id))) {
          send(res, 409, { code: 'SIM_SEED_CONFLICT' });
          return;
        }
        const target = tenantData(scope);
        target.customers.push(...customers);
        target.orders.push(...orders);
        for (const product of products) {
          target.products.set(product.sku_id, withSeededInventory(product, inventoryBySku.get(product.sku_id)));
        }
        send(res, 200, {
          tenant_id: scope,
          data_class: 'TEST',
          customers_seeded: customers.length,
          orders_seeded: orders.length,
          products_seeded: products.length,
          inventory_seeded: inventory.length,
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/__sim/reset') {
        const data = tenantData(scope);
        const counts = {
          customers: data.customers.length,
          orders: data.orders.length + data.createdOrders.length,
        };
        simulatedData.delete(scope);
        for (const key of orderRequests.keys()) {
          if (key.startsWith(`${scope}:`)) orderRequests.delete(key);
        }
        for (const key of cartRequests.keys()) {
          if (key.startsWith(`${scope}:`)) cartRequests.delete(key);
        }
        send(res, 200, { tenant_id: scope, reset: counts });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/__sim/control') {
        const next = { ...simulation };
        for (const [key, value] of Object.entries(body)) {
          if (key === 'tenant_id') continue;
          if (key === 'failure_rate' && typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
            next.failure_rate = value;
          } else if (key === 'latency_ms' && Number.isInteger(value) && value >= 0) {
            next.latency_ms = value;
          } else if (key === 'swallow_after_write' && typeof value === 'boolean') {
            next.swallow_after_write = value;
          } else {
            send(res, 422, { code: 'SIM_CONTROL_INVALID' });
            return;
          }
        }
        Object.assign(simulation, next);
        send(res, 200, { control: { ...simulation } });
        return;
      }
      send(res, 404, { code: 'NOT_FOUND' });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/carts') {
      const idempotencyKey = req.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 256) {
        send(res, 400, { code: 'IDEMPOTENCY_KEY_REQUIRED' });
        return;
      }
      const requestKey = `${scope}:${idempotencyKey}`;
      const canonical = JSON.stringify(canonicalize(body));
      const existing = cartRequests.get(requestKey);
      if (existing) {
        if (existing.canonical !== canonical) {
          send(res, 409, { code: 'IDEMPOTENCY_CONFLICT' });
          return;
        }
        send(res, existing.status, existing.body);
        return;
      }
      const allowedBodyKeys = new Set(['tenant_id', 'session_id', 'customer_id', 'items']);
      if (
        body.tenant_id !== scope
        || typeof body.session_id !== 'string'
        || body.session_id.trim().length === 0
        || body.session_id.length > 512
        || Object.keys(body).some((key) => !allowedBodyKeys.has(key))
        || !Array.isArray(body.items)
        || body.items.length === 0
        || body.items.length > 50
      ) {
        send(res, 422, { code: 'CART_INVALID' });
        return;
      }
      if (
        body.customer_id !== undefined
        && (typeof body.customer_id !== 'string' || customerFor(scope, body.customer_id) === null)
      ) {
        unavailable(res);
        return;
      }
      const requested = new Map();
      for (const item of body.items) {
        if (
          typeof item !== 'object'
          || item === null
          || Array.isArray(item)
          || Object.keys(item).some((key) => key !== 'sku_id' && key !== 'quantity')
          || typeof item.sku_id !== 'string'
          || item.sku_id.trim().length === 0
          || !Number.isSafeInteger(item.quantity)
          || item.quantity < 1
        ) {
          send(res, 422, { code: 'CART_INVALID' });
          return;
        }
        const sku = fixtureSku(scope, item.sku_id, demoPack, simulatedData);
        if (sku === null) {
          unavailable(res);
          return;
        }
        const total = (requested.get(item.sku_id)?.quantity ?? 0) + item.quantity;
        if (!Number.isSafeInteger(total)) {
          send(res, 422, { code: 'CART_INVALID' });
          return;
        }
        requested.set(item.sku_id, { sku, quantity: total });
      }
      for (const [skuId, item] of requested) {
        if (availableStock(scope, item.sku) < item.quantity) {
          send(res, 409, { code: 'INSUFFICIENT_STOCK', sku_id: skuId });
          return;
        }
      }
      const lineItems = [...requested].map(([skuId, item]) => ({
        sku_id: skuId,
        quantity: item.quantity,
        unit_price: item.sku.list_price ?? item.sku.original_list_price,
        currency: item.sku.currency ?? demoPack?.currency ?? CATALOG_ITEM.currency,
      }));
      const subtotal = lineItems.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
      const itemCount = lineItems.reduce((sum, item) => sum + item.quantity, 0);
      if (
        !Number.isSafeInteger(subtotal)
        || !Number.isSafeInteger(itemCount)
        || lineItems.some((item) => !Number.isSafeInteger(item.unit_price) || item.unit_price < 0)
        || lineItems.some((item) => item.currency !== lineItems[0].currency)
      ) {
        send(res, 422, { code: 'CART_INVALID' });
        return;
      }
      const updatedAt = now().toISOString();
      const cartId = `CART-${randomUUID()}`;
      const cart = {
        cart_id: cartId,
        tenant_id: scope,
        session_id: body.session_id,
        ...(typeof body.customer_id === 'string' ? { customer_id: body.customer_id } : {}),
        items: lineItems,
        item_count: itemCount,
        subtotal,
        total_amount: subtotal,
        currency: lineItems[0].currency,
        updated_at: updatedAt,
      };
      const output = {
        cart_id: cartId,
        item_count: itemCount,
        subtotal,
        currency: cart.currency,
        updated_at: updatedAt,
      };
      tenantData(scope).carts.set(cartId, cart);
      cartRequests.set(requestKey, { canonical, status: 201, body: output });
      send(res, 201, output);
      return;
    }
    const cartPath = /^\/api\/v1\/carts\/([A-Za-z0-9_-]{1,128})$/.exec(url.pathname);
    if (req.method === 'GET' && cartPath !== null) {
      const cartId = cartPath[1];
      const cart = cartId === undefined ? undefined : simulatedData.get(scope)?.carts.get(cartId);
      if (cart === undefined) {
        unavailable(res);
        return;
      }
      send(res, 200, cart);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/catalog/items') {
      const seededProducts = simulatedData.get(scope)?.products;
      if (demoPack?.tenant_id === scope) {
        send(res, 200, {
          items: demoPack.skus.map(demoCatalogProjection),
          snapshot_at: now().toISOString(),
        });
        return;
      }
      if (seededProducts && seededProducts.size > 0) {
        send(res, 200, {
          items: [...seededProducts.values()].map(demoCatalogProjection),
          snapshot_at: now().toISOString(),
        });
        return;
      }
      if (demoPack || scope !== TENANT_ID) {
        unavailable(res);
        return;
      }
      send(res, 200, { items: [CATALOG_ITEM], snapshot_at: now().toISOString() });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/inventory/lookup') {
      const skuIds = Array.isArray(body.sku_ids) ? body.sku_ids : [];
      if (demoPack?.tenant_id === scope) {
        if (skuIds.some((skuId) => typeof skuId !== 'string' || demoSku(demoPack, skuId) === null)) {
          unavailable(res);
          return;
        }
        send(res, 200, {
          snapshot_at: now().toISOString(),
          items: skuIds.map((skuId) => {
            const sku = demoSku(demoPack, skuId);
            const available = availableStock(scope, sku);
            return {
              tenant_id: scope,
              sku_id: sku.sku_id,
              ...withAvailableStock(sku, available),
              reserved_qty: sku.reserved_qty,
            };
          }),
        });
        return;
      }
      const seededProducts = simulatedData.get(scope)?.products;
      if (seededProducts && seededProducts.size > 0) {
        if (skuIds.some((skuId) => typeof skuId !== 'string' || !seededProducts.has(skuId))) {
          unavailable(res);
          return;
        }
        send(res, 200, {
          snapshot_at: now().toISOString(),
          items: skuIds.map((skuId) => {
            const sku = seededProducts.get(skuId);
            const available = availableStock(scope, sku);
            return {
              tenant_id: scope,
              sku_id: sku.sku_id,
              ...withAvailableStock(sku, available),
              reserved_qty: sku.reserved_qty,
            };
          }),
        });
        return;
      }
      if (demoPack || scope !== TENANT_ID) {
        unavailable(res);
        return;
      }
      if (skuIds.some((sku) => sku !== CATALOG_ITEM.sku)) {
        unavailable(res);
        return;
      }
      send(res, 200, {
        snapshot_at: now().toISOString(),
        items: skuIds.map((sku) => {
          const fixture = fixtureSku(scope, sku, demoPack, simulatedData);
          const stock = withAvailableStock(fixture, availableStock(scope, fixture));
          return {
            tenant_id: scope,
            sku_id: sku,
            total_available_to_promise: stock.total_available_to_promise,
            available_quantity: stock.available_quantity,
            in_stock: stock.in_stock,
            warehouse_breakdown: stock.warehouse_breakdown,
          };
        }),
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/v1/prices/lookup') {
      const seededSku = typeof body.sku_id === 'string'
        ? simulatedData.get(scope)?.products.get(body.sku_id)
        : null;
      if (seededSku && demoPack?.tenant_id !== scope) {
        const quotedAt = now();
        const quotedAtIso = quotedAt.toISOString();
        const expiresAt = new Date(quotedAt.getTime() + DEMO_PACK_TTL_SECONDS * 1000).toISOString();
        const quote = {
          tenant_id: scope,
          sku_id: seededSku.sku_id,
          owner_approved: true,
          list_price: seededSku.list_price,
          original_list_price: seededSku.original_list_price,
          p_floor: seededSku.floor_price,
          floor_price: seededSku.floor_price,
          currency: seededSku.currency,
          floor_source: seededSku.floor_price_source,
          floor_price_source: seededSku.floor_price_source,
          quote_ttl_seconds: DEMO_PACK_TTL_SECONDS,
          quoted_at: quotedAtIso,
          snapshot_at: quotedAtIso,
          quote_expires_at: expiresAt,
          expires_at: expiresAt,
          provenance: {
            source: seededSku.floor_price_source,
            quoted_at: quotedAtIso,
            expires_at: expiresAt,
          },
        };
        const signature = signRequest(boot.secret, 'POST', '/api/v1/prices/lookup', JSON.stringify(quote));
        send(res, 200, { ...quote, signature, quote_signature: signature });
        return;
      }
      if (demoPack?.tenant_id === scope) {
        const sku = typeof body.sku_id === 'string' ? demoSku(demoPack, body.sku_id) : null;
        if (sku === null) {
          unavailable(res);
          return;
        }
        const quotedAt = now();
        const quotedAtIso = quotedAt.toISOString();
        const expiresAt = new Date(quotedAt.getTime() + DEMO_PACK_TTL_SECONDS * 1000).toISOString();
        const quote = {
          tenant_id: scope,
          sku_id: sku.sku_id,
          owner_approved: true,
          list_price: sku.list_price,
          original_list_price: sku.original_list_price,
          p_floor: sku.floor_price,
          floor_price: sku.floor_price,
          currency: sku.currency,
          floor_source: sku.floor_price_source,
          floor_price_source: sku.floor_price_source,
          quote_ttl_seconds: DEMO_PACK_TTL_SECONDS,
          quoted_at: quotedAtIso,
          snapshot_at: quotedAtIso,
          quote_expires_at: expiresAt,
          expires_at: expiresAt,
          provenance: {
            source: sku.floor_price_source,
            pack_version: demoPack.pack_version,
            floor_price_synced_at: sku.floor_price_synced_at,
            quoted_at: quotedAtIso,
            expires_at: expiresAt,
          },
        };
        const signature = signRequest(boot.secret, 'POST', '/api/v1/prices/lookup', JSON.stringify(quote));
        send(res, 200, { ...quote, signature, quote_signature: signature });
        return;
      }
      if (demoPack || scope !== TENANT_ID || body.sku_id !== CATALOG_ITEM.sku) {
        unavailable(res);
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
    if (req.method === 'POST' && url.pathname === '/api/v1/orders') {
      const idempotencyKey = req.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0 || idempotencyKey.length > 256) {
        send(res, 400, { code: 'IDEMPOTENCY_KEY_REQUIRED' });
        return;
      }
      const requestKey = `${scope}:${idempotencyKey}`;
      const canonical = JSON.stringify(canonicalize(body));
      const existing = orderRequests.get(requestKey);
      if (existing) {
        if (existing.canonical !== canonical) {
          send(res, 409, { code: 'IDEMPOTENCY_CONFLICT' });
          return;
        }
        send(res, existing.status, existing.body);
        return;
      }
      if (customerFor(scope, body.customer_id) === null || !Array.isArray(body.items) || body.items.length === 0) {
        unavailable(res);
        return;
      }
      if (
        body.tenant_id !== scope
        || typeof body.cart_id !== 'string'
        || body.cart_id.trim().length === 0
        || typeof body.shipping_address !== 'object'
        || body.shipping_address === null
        || Array.isArray(body.shipping_address)
        || Object.keys(body.shipping_address).length === 0
        || !ORDER_PAYMENT_METHODS.has(body.payment_method)
      ) {
        send(res, 422, { code: 'ORDER_INVALID' });
        return;
      }
      const requested = new Map();
      for (const item of body.items) {
        const skuId = item?.sku_id ?? item?.sku;
        const quantity = item?.quantity ?? item?.qty;
        const sku = typeof skuId === 'string' ? fixtureSku(scope, skuId, demoPack, simulatedData) : null;
        if (!sku || !Number.isSafeInteger(quantity) || quantity <= 0) {
          send(res, 422, { code: 'ORDER_INVALID' });
          return;
        }
        const total = (requested.get(skuId)?.quantity ?? 0) + quantity;
        if (!Number.isSafeInteger(total)) {
          send(res, 422, { code: 'ORDER_INVALID' });
          return;
        }
        requested.set(skuId, { sku, quantity: total });
      }
      for (const [skuId, item] of requested) {
        if (availableStock(scope, item.sku) < item.quantity) {
          send(res, 409, { code: 'INSUFFICIENT_STOCK', sku_id: skuId });
          return;
        }
      }
      const lineItems = [...requested].map(([skuId, item]) => ({
        sku_id: skuId,
        product_name: item.sku.name,
        quantity: item.quantity,
        unit_price: item.sku.list_price ?? item.sku.original_list_price,
        currency: item.sku.currency ?? demoPack?.currency ?? CATALOG_ITEM.currency,
      }));
      const totalAmount = lineItems.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
      if (!Number.isSafeInteger(totalAmount)) {
        send(res, 422, { code: 'ORDER_INVALID' });
        return;
      }
      const createdAt = now().toISOString();
      const orderId = `ORD-${randomUUID()}`;
      const order = {
        order_id: orderId,
        order_number: `TEST-${orderId.slice(4, 12).toUpperCase()}`,
        tenant_id: scope,
        customer_id: body.customer_id,
        cart_id: body.cart_id,
        shipping_address: body.shipping_address,
        payment_method: body.payment_method,
        data_class: 'TEST',
        status: 'CREATED',
        fulfillment_status: 'CREATED',
        payment_status: 'UNPAID',
        order_date: createdAt,
        snapshot_at: createdAt,
        currency: lineItems[0].currency,
        total_amount: totalAmount,
        total_price: totalAmount,
        quantity: lineItems.reduce((sum, item) => sum + item.quantity, 0),
        line_items: lineItems,
      };
      const data = tenantData(scope);
      for (const [skuId, item] of requested) {
        data.stock.set(skuId, availableStock(scope, item.sku) - item.quantity);
      }
      data.createdOrders.push(order);
      orderRequests.set(requestKey, { canonical, status: 201, body: order });
      if (simulation.swallow_after_write) {
        send(res, 504, { outcome: 'UNKNOWN', order_id: order.order_id, tenant_id: scope });
        return;
      }
      send(res, 201, order);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/orders/reconcile') {
      const idempotencyKey = body.idempotency_key;
      if (
        body.tenant_id !== scope
        || typeof idempotencyKey !== 'string'
        || idempotencyKey.length === 0
        || idempotencyKey.length > 256
      ) {
        send(res, 400, { code: 'ORDER_RECONCILE_INPUT_INVALID' });
        return;
      }
      const existing = orderRequests.get(`${scope}:${idempotencyKey}`);
      if (!existing) {
        send(res, 404, { code: 'ORDER_NOT_FOUND' });
        return;
      }
      send(res, 200, existing.body);
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
      if (demoPack) {
        const orderRef = typeof body?.key === 'string'
          ? body.key
          : (typeof body?.order_identifier === 'string'
            ? body.order_identifier
            : (typeof body?.order_id === 'string' ? body.order_id : null));
        const match = scope === demoPack.tenant_id
          ? (tenantSimOrders(scope).find(
            (order) => order.order_id === orderRef || order.order_number === orderRef,
          ) ?? demoPack.orders.find(
            (order) => order.order_id === orderRef || order.order_number === orderRef,
          ))
          : null;
        if (
          !orderRef
          || !match
          || typeof body?.customer_id !== 'string'
          || match.customer_id !== body.customer_id
        ) {
          unavailable(res);
          return;
        }
        send(res, 200, { snapshot_at: now().toISOString(), ...match });
        return;
      }
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
        const raw = await readFile(ordersFixture, 'utf8');
        const parsed = JSON.parse(raw);
        orders = Array.isArray(parsed.orders) ? parsed.orders : [];
      } catch {
        send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
        return;
      }
      const match = tenantSimOrders(scope).find(
        (order) => order.order_id === orderRef || order.order_number === orderRef,
      ) ?? orders.find(
        (order) => order.tenant_id === scope && (order.order_id === orderRef || order.order_number === orderRef),
      );
      if (!match) {
        send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
        return;
      }
      if (typeof body?.customer_id !== 'string' || match.customer_id !== body.customer_id) {
        send(res, 404, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
        return;
      }
      send(res, 200, {
        snapshot_at: now().toISOString(),
        ...match,
      });
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/api/v1/shipments/lookup' || url.pathname === '/api/v1/returns/lookup')) {
      const reference = typeof body?.key === 'string'
        ? body.key
        : (typeof body?.order_identifier === 'string'
          ? body.order_identifier
          : (typeof body?.order_id === 'string' ? body.order_id : null));
      const customerId = typeof body?.customer_id === 'string' ? body.customer_id : null;
      let match = null;
      if (reference !== null && customerId !== null) {
        if (demoPack) {
          match = scope === demoPack.tenant_id
            ? demoPack.orders.find(
              (order) => (order.order_id === reference || order.order_number === reference)
                && order.customer_id === customerId,
            ) ?? null
            : null;
        } else {
          try {
            const raw = await readFile(ordersFixture, 'utf8');
            const parsed = JSON.parse(raw);
            const orders = Array.isArray(parsed.orders) ? parsed.orders : [];
            match = orders.find(
              (order) => order.tenant_id === scope
                && (order.order_id === reference || order.order_number === reference)
                && order.customer_id === customerId,
            ) ?? null;
          } catch {
            match = null;
          }
        }
      }
      const isShipment = url.pathname === '/api/v1/shipments/lookup';
      const available = match !== null
        && (isShipment
          ? typeof match.tracking_number === 'string' && match.tracking_number.length > 0
          : match.status === 'RETURNED' || match.return_status === 'RETURNED');
      if (!available) {
        unavailable(res);
        return;
      }
      if (isShipment) {
        send(res, 200, {
          snapshot_at: now().toISOString(),
          shipment_id: match.tracking_number,
          tracking_number: match.tracking_number,
          order_id: match.order_id,
          order_number: match.order_number,
          customer_id: match.customer_id,
          status: match.fulfillment_status ?? match.status,
          shipped_at: match.shipped_at ?? null,
          delivered_at: match.delivered_at ?? null,
        });
      } else {
        send(res, 200, {
          snapshot_at: now().toISOString(),
          return_id: match.return_id ?? `RETURN:${match.order_id}`,
          order_id: match.order_id,
          order_number: match.order_number,
          customer_id: match.customer_id,
          status: match.return_status ?? match.status,
        });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/customers/lookup') {
      const customerId = typeof body.customer_id === 'string'
        ? body.customer_id
        : (typeof body.key === 'string' ? body.key : null);
      const customer = customerFor(scope, customerId);
      if (!customer) {
        unavailable(res);
        return;
      }
      send(res, 200, customer);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/customers/sales-history') {
      if (demoPack) {
        const customerId = typeof body.customer_id === 'string'
          ? body.customer_id
          : (typeof body.key === 'string' ? body.key : null);
        const customer = customerFor(scope, customerId);
        if (!customer) {
          unavailable(res);
          return;
        }
        const customerOrders = [
          ...demoPack.orders.filter((order) => order.customer_id === customerId),
          ...tenantSimOrders(scope).filter((order) => order.customer_id === customerId),
        ];
        const completedOrders = customerOrders.filter((order) => order.status === 'DELIVERED');
        const paidOrders = customerOrders.filter((order) => order.payment_status === 'PAID');
        send(res, 200, {
          tenant_id: scope,
          customer_id: customerId,
          currency: demoPack.currency,
          lifetime_spend: paidOrders.reduce((sum, order) => sum + order.total_amount, 0),
          total_order_count: customerOrders.length,
          completed_order_count: completedOrders.length,
          returned_order_count: customerOrders.filter((order) => order.status === 'RETURNED').length,
          average_order_value: paidOrders.length === 0
            ? 0
            : paidOrders.reduce((sum, order) => sum + order.total_amount, 0) / paidOrders.length,
          recent_orders: customerOrders.slice(-10),
        });
        return;
      }
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
      let action_id;
      try {
        action_id = decodeURIComponent(action[1]);
      } catch {
        send(res, 400, { code: 'ACTION_ID_INVALID' });
        return;
      }
      if (action_id.length === 0 || action_id.length > 128) {
        send(res, 400, { code: 'ACTION_ID_INVALID' });
        return;
      }
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

      if (simulation.swallow_after_write) {
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
