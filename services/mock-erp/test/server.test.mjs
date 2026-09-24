import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TENANT_ID } from '../src/fixtures.mjs';
import { signBody } from '../src/hmac.mjs';
import { createServer } from '../src/server.mjs';

const SECRET = 'local-mock-erp-hmac-secret-value';
const SERVER_PATH = fileURLToPath(new URL('../src/server.mjs', import.meta.url));

function post(server, path, body, { secret = SECRET, tenant = TENANT_ID, signature } = {}) {
  const raw = JSON.stringify(body);
  const sig = signature === undefined ? signBody(secret, raw) : signature;
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
function get(server, path, { secret = SECRET, tenant = TENANT_ID } = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: {
        'content-length': 0,
        'x-mock-signature': signBody(secret, ''),
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

test('orders status returns documented order DTO or indistinguishable 404 for unknown/wrong customer', async () => {
  const server = await start();
  const careTenant = '11111111-1111-1111-1111-111111111111';
  try {
    const success = await post(
      server,
      '/api/v1/orders/status',
      { key: 'ORD-A-1' },
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
