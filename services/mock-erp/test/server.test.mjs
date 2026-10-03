import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { signMockRequest } from '../../../packages/adapters/dist/index.js';
import { TENANT_ID } from '../src/fixtures.mjs';
import { signRequest } from '../src/hmac.mjs';
import { createServer } from '../src/server.mjs';

const SECRET = 'local-mock-erp-hmac-secret-value';
const DEMO_TENANT_ID = '99999999-9999-4999-8999-999999999999';
const SERVER_PATH = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const DEMO_PACK_PATH = fileURLToPath(new URL('../src/demo/novamart.json', import.meta.url));

const nodeHmacSha256Hex = (secret, message) => createHmac('sha256', secret).update(message, 'utf8').digest('hex');

function post(server, path, body, {
  secret = SECRET,
  tenant = TENANT_ID,
  signature,
  idempotencyKey,
} = {}) {
  const raw = JSON.stringify(body);
  const sig = signature === undefined ? signRequest(secret, 'POST', path, raw) : signature;
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(raw),
        'x-mock-signature': sig,
        'x-tenant-id': tenant,
        ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null, text });
      });
    });
    req.on('error', reject);
    req.end(raw);
  });
}

/**
 * A signed read: the tenant scope travels in the header, because a GET has no body to carry it.
 */
function get(server, path, { secret = SECRET, tenant = TENANT_ID, signature = signRequest(secret, 'GET', path, '') } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: {
        'content-length': 0,
        'x-mock-signature': signature,
        ...(tenant === null ? {} : { 'x-tenant-id': tenant }),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null, text });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function start(env, deps) {
  const server = createServer({
    APP_ENV: 'local',
    MOCK_SECRET_KEY: SECRET,
    SIMULATE_LATENCY_MS: '0',
    SIMULATE_FAILURE_RATE: '0',
    ...env,
  }, deps);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}

test('APP_ENV=staging exits and names APP_ENV without printing the secret', async () => {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, APP_ENV: 'staging', MOCK_SECRET_KEY: 'SENTINEL_SECRET_DO_NOT_LEAK_123456' },
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0);
  assert.match(stderr, /\[APP_ENV\]/);
  assert.equal(stderr.includes('SENTINEL_SECRET_DO_NOT_LEAK_123456'), false);
});
test('unknown demo pack is refused without exposing boot secrets', () => {
  assert.throws(
    () => createServer({
      APP_ENV: 'local',
      MOCK_SECRET_KEY: SECRET,
      MOCK_ERP_DEMO_PACK: 'unknown-pack',
    }),
    (error) => error?.stderr?.includes('[MOCK_ERP_DEMO_PACK]') === true
      && error?.stderr?.includes(SECRET) === false,
  );
});
test('NovaMart fixture keeps canonical counts and verified C05/C06 ownership', () => {
  const pack = JSON.parse(readFileSync(DEMO_PACK_PATH, 'utf8'));
  for (const [name, count] of Object.entries({
    products: 24,
    skus: 28,
    customers: 12,
    orders: 20,
    events: 53,
    segments: 2,
    campaigns: 1,
    engagement_events: 8,
    cases: 4,
  })) {
    assert.equal(pack[name].length, count);
  }

  const byCode = new Map(pack.customers.map((customer) => [customer.customer_code, customer]));
  const c05 = byCode.get('C05');
  const c06 = byCode.get('C06');
  assert.equal(c05.identity_verified, true);
  assert.equal(c05.web_chat_identity.channel_identifier, 'sess-novamart-c05');
  assert.equal(c06.identity_verified, true);
  assert.equal(c06.web_chat_identity.channel_identifier, 'sess-novamart-c06');
  assert.notEqual(c05.customer_id, c06.customer_id);

  const order = pack.orders.find((candidate) => candidate.order_number === 'ORD-DEMO-005');
  assert.equal(order.customer_code, 'C05');
  assert.equal(order.customer_id, c05.customer_id);
});

test('local /health returns 200', async () => {
  const server = await start();
  try {
    const { port } = server.address();
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: 'ok' });
  } finally {
    server.close();
  }
});

test('catalog and inventory lookups return timestamped authoritative envelopes', async () => {
  const server = await start();
  try {
    const catalog = await get(server, '/api/v1/catalog/items');
    assert.equal(catalog.status, 200);
    assert.equal(typeof catalog.body.snapshot_at, 'string');
    assert.deepEqual(catalog.body.items.map((item) => item.sku), ['SKU-LOCAL-1']);

    const inventory = await post(server, '/api/v1/inventory/lookup', {
      tenant_id: TENANT_ID,
      sku_ids: ['SKU-LOCAL-1'],
    });
    assert.equal(inventory.status, 200);
    assert.equal(typeof inventory.body.snapshot_at, 'string');
    assert.deepEqual(inventory.body.items, [{
      tenant_id: TENANT_ID,
      sku_id: 'SKU-LOCAL-1',
      total_available_to_promise: 5,
      available_quantity: 5,
      in_stock: true,
      warehouse_breakdown: [ {
        warehouse_id: 'WH-1',
        warehouse_name: 'Local fixture warehouse',
        physical_qty: 7,
        reserved_qty: 2,
        available_to_promise: 5,
      } ],
    }]);
  } finally {
    server.close();
  }
});

test('mock verifier accepts the shared adapter signer', async () => {
  const server = await start();
  const path = '/api/v1/catalog/items';
  try {
    const signature = signMockRequest(SECRET, 'GET', path, '', nodeHmacSha256Hex);
    const catalog = await get(server, path, { signature });
    assert.equal(catalog.status, 200);
  } finally {
    server.close();
  }
});
test('NovaMart selection serves 28 SKUs, strict stock, and signed owner-approved prices', async () => {
  const server = await start(
    { MOCK_ERP_DEMO_PACK: 'novamart' },
    { now: () => new Date('2026-09-28T00:00:00.000Z') },
  );
  try {
    const catalog = await get(server, '/api/v1/catalog/items', { tenant: DEMO_TENANT_ID });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.items.length, 28);
    assert.equal(catalog.body.items.some((item) => item.sku === 'NM-L01-BLK'), true);
    assert.equal(catalog.body.items.every((item) => item.tenant_id === DEMO_TENANT_ID), true);

    const inventory = await post(server, '/api/v1/inventory/lookup', {
      tenant_id: DEMO_TENANT_ID,
      sku_ids: ['NM-L01-BLK'],
    }, { tenant: DEMO_TENANT_ID });
    assert.equal(inventory.status, 200);
    assert.equal(inventory.body.items[0].available_quantity, 5);
    assert.equal(inventory.body.items[0].reserved_qty, 1);
    assert.equal(inventory.body.items[0].warehouse_breakdown.length, 2);

    const price = await post(server, '/api/v1/prices/lookup', {
      tenant_id: DEMO_TENANT_ID,
      sku_id: 'NM-L01-BLK',
    }, { tenant: DEMO_TENANT_ID });
    assert.equal(price.status, 200);
    assert.equal(price.body.owner_approved, true);
    assert.equal(price.body.list_price, 18_900_000);
    assert.equal(price.body.p_floor, 18_900_000);
    assert.equal(price.body.currency, 'VND');
    assert.equal(price.body.floor_source, 'novamart-demo-v1');
    assert.equal(price.body.quote_ttl_seconds, 900);
    assert.equal(price.body.quote_expires_at, '2026-09-28T00:15:00.000Z');
    assert.equal(price.body.signature, price.body.quote_signature);
    const { signature, quote_signature, ...unsigned } = price.body;
    assert.equal(signature, signRequest(SECRET, 'POST', '/api/v1/prices/lookup', JSON.stringify(unsigned)));
    assert.equal(JSON.stringify(price.body).includes(SECRET), false);

    const unknownSku = await post(server, '/api/v1/inventory/lookup', {
      tenant_id: DEMO_TENANT_ID,
      sku_ids: ['NM-NOT-A-SKU'],
    }, { tenant: DEMO_TENANT_ID });
    assert.equal(unknownSku.status, 404);
    assert.deepEqual(unknownSku.body, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
  } finally {
    server.close();
  }
});

test('signed non-fixture tenant cannot read another tenant catalog or inventory fixtures', async () => {
  const server = await start();
  const otherTenant = '11111111-1111-4111-8111-111111111111';
  try {
    const catalog = await get(server, '/api/v1/catalog/items', { tenant: otherTenant });
    assert.equal(catalog.status, 404);
    assert.deepEqual(catalog.body, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });

    const inventory = await post(server, '/api/v1/inventory/lookup', {
      tenant_id: otherTenant,
      sku_ids: ['SKU-LOCAL-1'],
    }, { tenant: otherTenant });
    assert.equal(inventory.status, 404);
    assert.deepEqual(inventory.body, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
    assert.equal(inventory.text.includes('SKU-LOCAL-1'), false);
  } finally {
    server.close();
  }
});

test('events require HMAC and a canonical event', async () => {
  const server = await start();
  try {
    const missing = await post(server, '/events/v1', {
      tenant_id: TENANT_ID,
      canonical_event: 'search',
    }, { signature: '' });
    assert.equal(missing.status, 401);

    const bad = await post(server, '/events/v1', {
      tenant_id: TENANT_ID,
      canonical_event: 'not-canonical',
    });
    assert.equal(bad.status, 422);

    const ok = await post(server, '/events/v1', {
      tenant_id: TENANT_ID,
      canonical_event: 'search',
    });
    assert.equal(ok.status, 202);
    assert.equal(ok.body.canonical_event, 'search');
  } finally {
    server.close();
  }
});

test('draft order replays the same refusal and conflicts on a changed body', async () => {
  const server = await start();
  try {
    const body = {
      tenant_id: TENANT_ID,
      effect_key: 'effect-1',
      customer_id: 'cust-local-1',
      items: [],
    };
    const first = await post(server, '/api/v1/orders/draft', body);
    const second = await post(server, '/api/v1/orders/draft', body);
    assert.equal(first.status, 409);
    assert.equal(first.body.reserved, false);
    assert.equal(second.body.refusal_id, first.body.refusal_id);

    const changed = await post(server, '/api/v1/orders/draft', { ...body, customer_id: 'other' });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, 'IDEMPOTENCY_CONFLICT');
  } finally {
    server.close();
  }
});

test('SIMULATE_FAILURE_RATE=1 returns UNKNOWN before business logic', async () => {
  const server = await start({ SIMULATE_FAILURE_RATE: '1' });
  try {
    const res = await post(server, '/api/v1/inventory/lookup', {
      tenant_id: TENANT_ID,
      sku_ids: ['SKU-LOCAL-1'],
    });
    assert.equal(res.status, 504);
    assert.equal(res.body.outcome, 'UNKNOWN');
  } finally {
    server.close();
  }
});

test('an action is accepted once, replayed by id, and refuses a changed body', async () => {
  const server = await start();
  try {
    const body = { tenant_id: TENANT_ID, action_id: 'act-1', payload: { sku_id: 'SKU-LOCAL-1' } };

    const first = await post(server, '/api/v1/actions/act-1', body);
    assert.equal(first.status, 200);
    assert.equal(first.body.status, 'accepted');
    assert.equal(first.body.provider_reference, `MOCK-ERP:${TENANT_ID}:act-1`);
    assert.equal(typeof first.body.snapshot_at, 'string');

    const replay = await post(server, '/api/v1/actions/act-1', body);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body);

    const changed = await post(server, '/api/v1/actions/act-1', { ...body, payload: { sku_id: 'other' } });
    assert.equal(changed.status, 409);
    assert.equal(changed.body.code, 'IDEMPOTENCY_CONFLICT');
  } finally {
    server.close();
  }
});

test('an applied action stays readable after the response is lost', async () => {
  const server = await start({ SIMULATE_SWALLOW_AFTER_WRITE: '1' });
  try {
    const lost = await post(server, '/api/v1/actions/act-lost', {
      tenant_id: TENANT_ID,
      action_id: 'act-lost',
    });
    assert.equal(lost.status, 504);
    assert.equal(lost.body.outcome, 'UNKNOWN');

    const reconciled = await get(server, '/api/v1/actions/act-lost');
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.provider_reference, `MOCK-ERP:${TENANT_ID}:act-lost`);
  } finally {
    server.close();
  }
});

test('the action boundary is scoped to the signed tenant and refuses unsigned calls', async () => {
  const server = await start();
  try {
    const unsigned = await post(
      server,
      '/api/v1/actions/act-2',
      { tenant_id: TENANT_ID, action_id: 'act-2' },
      { signature: '' },
    );
    assert.equal(unsigned.status, 401);

    const mismatched = await post(
      server,
      '/api/v1/actions/act-2',
      { tenant_id: TENANT_ID, action_id: 'act-2' },
      { tenant: '00000000-0000-4000-8000-0000000000ff' },
    );
    assert.equal(mismatched.status, 401);
    assert.equal(mismatched.body.code, 'TENANT_MISMATCH');

    // A tenant that never wrote the action cannot read it back.
    const absent = await get(server, '/api/v1/actions/act-2', {
      tenant: '00000000-0000-4000-8000-0000000000ff',
    });
    assert.equal(absent.status, 404);
    assert.equal(absent.body.code, 'ACTION_NOT_FOUND');

    const written = await post(server, '/api/v1/actions/act-2', {
      tenant_id: TENANT_ID,
      action_id: 'act-2',
    });
    assert.equal(written.status, 200);
  } finally {
    server.close();
  }
});

test('an unscoped read is refused instead of answering for an unnamed tenant', async () => {
  const server = await start();
  try {
    const { port } = server.address();
    const unsigned = await fetch(`http://127.0.0.1:${port}/api/v1/catalog/items`);
    assert.equal(unsigned.status, 401);
    assert.equal((await unsigned.json()).code, 'SIGNATURE_INVALID');

    const signed = await get(server, '/api/v1/catalog/items', { tenant: null });
    assert.equal(signed.status, 401);
    assert.equal(signed.body.code, 'TENANT_MISMATCH');
  } finally {
    server.close();
  }
});
test('NovaMart order and customer reads stay tenant and customer scoped', async () => {
  const server = await start({ MOCK_ERP_DEMO_PACK: 'novamart' });
  try {
    const order = await post(server, '/api/v1/orders/status', {
      tenant_id: DEMO_TENANT_ID,
      key: 'ORD-DEMO-005',
      customer_id: '99000000-0000-4000-8000-000000000005',
    }, { tenant: DEMO_TENANT_ID });
    assert.equal(order.status, 200);
    assert.equal(order.body.order_id, 'ORD-DEMO-005');
    assert.equal(order.body.customer_code, 'C05');
    assert.equal(order.body.customer_id, '99000000-0000-4000-8000-000000000005');
    assert.equal(order.body.status, 'DELIVERED');

    const c06Status = await post(server, '/api/v1/orders/status', {
      tenant_id: DEMO_TENANT_ID,
      key: 'ORD-DEMO-005',
      customer_id: '99000000-0000-4000-8000-000000000006',
    }, { tenant: DEMO_TENANT_ID });
    assert.equal(c06Status.status, 404);
    assert.deepEqual(c06Status.body, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
    const anonymous = await post(server, '/api/v1/orders/status', {
      tenant_id: DEMO_TENANT_ID,
      key: 'ORD-DEMO-005',
    }, { tenant: DEMO_TENANT_ID });
    assert.equal(anonymous.status, 404);
    assert.deepEqual(anonymous.body, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
    const wrongTenant = await post(server, '/api/v1/orders/status', {
      tenant_id: TENANT_ID,
      key: 'ORD-DEMO-005',
    });
    assert.equal(wrongTenant.status, 404);
    assert.deepEqual(wrongTenant.body, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });

    const customer = await post(server, '/api/v1/customers/lookup', {
      tenant_id: DEMO_TENANT_ID,
      customer_id: '99000000-0000-4000-8000-000000000005',
    }, { tenant: DEMO_TENANT_ID });
    assert.equal(customer.status, 200);
    assert.equal(customer.body.customer_tier, 'GOLD');
    const c06 = await post(server, '/api/v1/customers/lookup', {
      tenant_id: DEMO_TENANT_ID,
      customer_id: '99000000-0000-4000-8000-000000000006',
    }, { tenant: DEMO_TENANT_ID });
    assert.equal(c06.status, 200);
    assert.equal(c06.body.customer_code, 'C06');
    assert.equal(c06.body.identity_verified, true);
    assert.equal(c06.body.web_chat_identity.channel_identifier, 'sess-novamart-c06');
    assert.equal(c06.body.web_chat_identity.verified, true);
    assert.notEqual(c06.body.customer_id, customer.body.customer_id);

    const history = await post(server, '/api/v1/customers/sales-history', {
      tenant_id: DEMO_TENANT_ID,
      customer_id: '99000000-0000-4000-8000-000000000005',
    }, { tenant: DEMO_TENANT_ID });
    assert.equal(history.status, 200);
    assert.equal(history.body.currency, 'VND');

    const crossTenantCustomer = await post(server, '/api/v1/customers/lookup', {
      tenant_id: TENANT_ID,
      customer_id: '99000000-0000-4000-8000-000000000005',
    });
    assert.equal(crossTenantCustomer.status, 404);
    const crossTenantHistory = await post(server, '/api/v1/customers/sales-history', {
      tenant_id: TENANT_ID,
      customer_id: '99000000-0000-4000-8000-000000000005',
    });
    assert.equal(crossTenantHistory.status, 404);
  } finally {
    server.close();
  }
});

test('signed simulator seed provisions tenant-scoped catalog, prices, stock and TEST orders', async () => {
  const server = await start();
  const seededTenant = 'cafe0000-0000-4000-8000-000000000001';
  const otherTenant = 'cafe0000-0000-4000-8000-000000000002';
  const skuId = 'SKU-SEEDED-TENANT-1';
  try {
    const invalid = await post(server, '/__sim/seed', {
      tenant_id: seededTenant,
      customers: [],
      orders: [],
      products: [{ sku_id: skuId, name: 'Seeded product', list_price: 900, original_list_price: 1000, floor_price: 700, currency: 'USD' }],
      inventory: [{ sku_id: 'SKU-UNKNOWN', available_quantity: 8 }],
    }, { tenant: seededTenant });
    assert.equal(invalid.status, 422);
    const unseeded = await get(server, '/api/v1/catalog/items', { tenant: seededTenant });
    assert.equal(unseeded.status, 404);

    const seeded = await post(server, '/__sim/seed', {
      tenant_id: seededTenant,
      customers: [{ customer_id: 'customer-seeded-tenant', name: 'Synthetic tenant customer' }],
      orders: [],
      products: [{
        sku_id: skuId,
        name: 'Seeded product',
        brand: 'Test Brand',
        category: 'Test Category',
        description: 'Tenant-scoped test fixture',
        list_price: 900,
        original_list_price: 1000,
        floor_price: 700,
        currency: 'USD',
      }],
      inventory: [{ sku_id: skuId, available_quantity: 8, physical_qty: 10, reserved_qty: 2, warehouse_id: 'TEST-WH' }],
    }, { tenant: seededTenant });
    assert.equal(seeded.status, 200);
    assert.equal(seeded.body.products_seeded, 1);
    assert.equal(seeded.body.inventory_seeded, 1);

    const catalog = await get(server, '/api/v1/catalog/items', { tenant: seededTenant });
    assert.equal(catalog.status, 200);
    assert.equal(catalog.body.items.length, 1);
    assert.equal(catalog.body.items[0].sku_id, skuId);
    assert.equal(catalog.body.items[0].list_price, 900);
    assert.equal(catalog.body.items[0].original_list_price, 1000);

    const inventory = await post(server, '/api/v1/inventory/lookup', {
      tenant_id: seededTenant,
      sku_ids: [skuId],
    }, { tenant: seededTenant });
    assert.equal(inventory.status, 200);
    assert.equal(inventory.body.items[0].available_quantity, 8);
    assert.equal(inventory.body.items[0].reserved_qty, 2);

    const price = await post(server, '/api/v1/prices/lookup', {
      tenant_id: seededTenant,
      sku_id: skuId,
    }, { tenant: seededTenant });
    assert.equal(price.status, 200);
    assert.equal(price.body.floor_price, 700);
    assert.equal(price.body.currency, 'USD');
    const { signature, quote_signature, ...unsignedQuote } = price.body;
    assert.equal(signature, quote_signature);
    assert.equal(signature, signRequest(SECRET, 'POST', '/api/v1/prices/lookup', JSON.stringify(unsignedQuote)));

    const order = await post(server, '/api/v1/orders', {
      tenant_id: seededTenant,
      cart_id: 'cart-seeded-tenant',
      customer_id: 'customer-seeded-tenant',
      shipping_address: { line1: '1 Test Street' },
      payment_method: 'CREDIT_CARD',
      items: [{ sku_id: skuId, quantity: 2 }],
    }, { tenant: seededTenant, idempotencyKey: 'order-seeded-tenant' });
    assert.equal(order.status, 201);
    assert.equal(order.body.total_amount, 1800);
    const depletedInventory = await post(server, '/api/v1/inventory/lookup', {
      tenant_id: seededTenant,
      sku_ids: [skuId],
    }, { tenant: seededTenant });
    assert.equal(depletedInventory.body.items[0].available_quantity, 6);

    const crossTenantCatalog = await get(server, '/api/v1/catalog/items', { tenant: otherTenant });
    assert.equal(crossTenantCatalog.status, 404);
    const crossTenantInventory = await post(server, '/api/v1/inventory/lookup', {
      tenant_id: otherTenant,
      sku_ids: [skuId],
    }, { tenant: otherTenant });
    assert.equal(crossTenantInventory.status, 404);
    const crossTenantPrice = await post(server, '/api/v1/prices/lookup', {
      tenant_id: otherTenant,
      sku_id: skuId,
    }, { tenant: otherTenant });
    assert.equal(crossTenantPrice.status, 404);

    const reset = await post(server, '/__sim/reset', { tenant_id: seededTenant }, { tenant: seededTenant });
    assert.equal(reset.status, 200);
    const resetCatalog = await get(server, '/api/v1/catalog/items', { tenant: seededTenant });
    assert.equal(resetCatalog.status, 404);
  } finally {
    server.close();
  }
});

test('signed simulator seeds TEST rows, controls chaos, creates idempotent stocked orders, and resets TEST data', async () => {
  const server = await start();
  try {
    const unsigned = await post(server, '/__sim/reset', {}, { signature: '' });
    assert.equal(unsigned.status, 401);

    const seeded = await post(server, '/__sim/seed', {
      tenant_id: TENANT_ID,
      customers: [{
        tenant_id: TENANT_ID,
        customer_id: 'customer-test-1',
        name: 'Synthetic test customer',
      }],
      orders: [{
        tenant_id: TENANT_ID,
        order_id: 'seeded-test-order',
        customer_id: 'customer-test-1',
        data_class: 'PRODUCTION',
        status: 'SEEDED',
      }],
    });
    assert.equal(seeded.status, 200);
    assert.equal(seeded.body.data_class, 'TEST');
    assert.equal(seeded.body.customers_seeded, 1);
    assert.equal(seeded.body.orders_seeded, 1);

    const seededStatus = await post(server, '/api/v1/orders/status', {
      tenant_id: TENANT_ID,
      key: 'seeded-test-order',
      customer_id: 'customer-test-1',
    });
    assert.equal(seededStatus.status, 200);
    assert.equal(seededStatus.body.data_class, 'TEST');

    const controlled = await post(server, '/__sim/control', {
      tenant_id: TENANT_ID,
      failure_rate: 1,
      latency_ms: 0,
      swallow_after_write: true,
    });
    assert.equal(controlled.status, 200);
    assert.deepEqual(controlled.body.control, {
      failure_rate: 1,
      latency_ms: 0,
      swallow_after_write: true,
    });
    const chaos = await post(server, '/api/v1/inventory/lookup', {
      tenant_id: TENANT_ID,
      sku_ids: ['SKU-LOCAL-1'],
    });
    assert.equal(chaos.status, 504);
    assert.equal(chaos.body.outcome, 'UNKNOWN');

    const orderBody = {
      tenant_id: TENANT_ID,
      cart_id: 'cart-test-1',
      customer_id: 'customer-test-1',
      shipping_address: { line1: '1 Test Street' },
      payment_method: 'CREDIT_CARD',
      items: [{ sku_id: 'SKU-LOCAL-1', quantity: 1 }],
    };
    await post(server, '/__sim/control', {
      tenant_id: TENANT_ID,
      failure_rate: 0,
      latency_ms: 0,
      swallow_after_write: true,
    });
    const lost = await post(server, '/api/v1/orders', orderBody, { idempotencyKey: 'test-order-1' });
    assert.equal(lost.status, 504);
    const reconciled = await post(server, '/api/v1/orders/reconcile', {
      tenant_id: TENANT_ID,
      idempotency_key: 'test-order-1',
    });
    assert.equal(reconciled.status, 200);
    assert.equal(reconciled.body.order_id, lost.body.order_id);
    const replay = await post(server, '/api/v1/orders', orderBody, { idempotencyKey: 'test-order-1' });
    assert.equal(replay.status, 201);
    assert.equal(replay.body.data_class, 'TEST');
    assert.equal(replay.body.order_id, lost.body.order_id);

    const conflict = await post(server, '/api/v1/orders', {
      ...orderBody,
      items: [{ sku_id: 'SKU-LOCAL-1', quantity: 2 }],
    }, { idempotencyKey: 'test-order-1' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'IDEMPOTENCY_CONFLICT');

    const status = await post(server, '/api/v1/orders/status', {
      tenant_id: TENANT_ID,
      key: replay.body.order_id,
      customer_id: 'customer-test-1',
    });
    assert.equal(status.status, 200);
    assert.equal(status.body.status, 'CREATED');
    assert.equal(status.body.data_class, 'TEST');
    const stock = await post(server, '/api/v1/inventory/lookup', {
      tenant_id: TENANT_ID,
      sku_ids: ['SKU-LOCAL-1'],
    });
    assert.equal(stock.body.items[0].available_quantity, 4);

    const reset = await post(server, '/__sim/reset', { tenant_id: TENANT_ID });
    assert.deepEqual(reset.body.reset, { customers: 1, orders: 2 });
    const missing = await post(server, '/api/v1/orders/status', {
      tenant_id: TENANT_ID,
      key: replay.body.order_id,
      customer_id: 'customer-test-1',
    });
    assert.equal(missing.status, 404);
    const missingReconciliation = await post(server, '/api/v1/orders/reconcile', {
      tenant_id: TENANT_ID,
      idempotency_key: 'test-order-1',
    });
    assert.equal(missingReconciliation.status, 404);
    const restoredStock = await post(server, '/api/v1/inventory/lookup', {
      tenant_id: TENANT_ID,
      sku_ids: ['SKU-LOCAL-1'],
    });
    assert.equal(restoredStock.body.items[0].available_quantity, 5);
  } finally {
    server.close();
  }
});

test('orders status returns documented order DTO or indistinguishable 404 for unknown/wrong customer', async () => {
  const server = await start();
  const careTenant = '11111111-1111-1111-1111-111111111111';
  try {
    const success = await post(
      server,
      '/api/v1/orders/status',
      { key: 'ORD-A-1', customer_id: 'aaaaaaaa-0000-4000-8000-00000000000a' },
      { tenant: careTenant },
    );
    assert.equal(success.status, 200);
    assert.equal(typeof success.body.snapshot_at, 'string');
    assert.equal(success.body.order_id, 'ORD-A-1');
    assert.equal(success.body.customer_id, 'aaaaaaaa-0000-4000-8000-00000000000a');
    assert.equal(success.body.status, 'SHIPPED');

    const unknownRef = await post(
      server,
      '/api/v1/orders/status',
      { key: 'ORD-UNKNOWN-999' },
      { tenant: careTenant },
    );
    assert.equal(unknownRef.status, 404);
    assert.deepEqual(unknownRef.body, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });

    const unknownTenant = await post(
      server,
      '/api/v1/orders/status',
      { key: 'ORD-A-1' },
      { tenant: '99999999-9999-4999-8999-999999999999' },
    );
    assert.equal(unknownTenant.status, 404);
    assert.deepEqual(unknownTenant.body, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });

    const wrongCustomer = await post(
      server,
      '/api/v1/orders/status',
      { key: 'ORD-A-1', customer_id: 'wrong-customer-id' },
      { tenant: careTenant },
    );
    assert.equal(wrongCustomer.status, 404);
    assert.deepEqual(wrongCustomer.body, { code: 'AUTHORITATIVE_SOURCE_UNAVAILABLE' });
  } finally {
    server.close();
  }
});
