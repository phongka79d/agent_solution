import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { signRequest } from '../../../services/mock-erp/src/hmac.mjs';
import { login, requestApi, turn, waitTask } from '../lib/api.mjs';
import { mockErpControl, readStackState } from '../lib/stack.mjs';
import { mintWidgetForCustomer } from '../lib/widget.mjs';

const DEFAULT_ERP_CONTROL = { failure_rate: 0, latency_ms: 0, swallow_after_write: false };

async function signedErpPost(path, body, extraHeaders = {}) {
  const { mockErpUrl, tenantId } = readStackState();
  const secret = process.env.MOCK_SECRET_KEY;
  if (!secret) throw new Error('stack mock ERP signing key is unavailable');
  const rawBody = JSON.stringify(body);
  const response = await fetch(new URL(path, mockErpUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': tenantId,
      'x-mock-signature': signRequest(secret, 'POST', path, rawBody),
      ...extraHeaders,
    },
    body: rawBody,
    signal: AbortSignal.timeout(10_000),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The caller reports the HTTP status even when a response body is absent.
  }
  return { response, payload };
}

test('mock ERP swallow-after-write returns UNKNOWN and replays one order for the same key', async (t) => {
  const { tenantId } = readStackState();
  if (!process.env.MOCK_SECRET_KEY) {
    t.skip('the signed mock ERP control key is unavailable');
    return;
  }

  const customerId = randomUUID();
  const idempotencyKey = `chaos-order-${randomUUID()}`;
  const orderRequest = {
    tenant_id: tenantId,
    customer_id: customerId,
    cart_id: `chaos-cart-${randomUUID()}`,
    shipping_address: {
      recipient_name: 'Chaos Test Customer',
      phone: '+84900000000',
      postal_code: '700000',
      city: 'Ho Chi Minh City',
      district: 'District 1',
      address_line1: '1 Stack Test Street',
    },
    payment_method: 'STRIPE',
    items: [{ sku_id: 'NM-L01-BLK', quantity: 1 }],
  };
  try {
    await mockErpControl({ failure_rate: 0, latency_ms: 0, swallow_after_write: true });
    const seeded = await signedErpPost('/__sim/seed', {
      tenant_id: tenantId,
      customers: [{ customer_id: customerId, display_name: `Chaos customer ${customerId}` }],
      orders: [],
    });
    assert.equal(seeded.response.status, 200);

    const unknown = await signedErpPost('/api/v1/orders', orderRequest, { 'idempotency-key': idempotencyKey });
    assert.equal(unknown.response.status, 504);
    assert.equal(unknown.payload?.outcome, 'UNKNOWN');
    assert.equal(typeof unknown.payload?.order_id, 'string');

    const replay = await signedErpPost('/api/v1/orders', orderRequest, { 'idempotency-key': idempotencyKey });
    assert.equal(replay.response.status, 201);
    assert.equal(replay.payload?.order_id, unknown.payload.order_id);
    assert.deepEqual(replay.payload?.line_items, [{
      sku_id: 'NM-L01-BLK',
      product_name: 'Nova Studio 14 Creator (Matte Black)',
      quantity: 1,
      unit_price: 18_900_000,
      currency: 'VND',
    }]);
    assert.equal(replay.payload?.customer_id, customerId);
    const status = await signedErpPost('/api/v1/orders/status', {
      tenant_id: tenantId,
      customer_id: customerId,
      order_id: unknown.payload.order_id,
    });
    assert.equal(status.response.status, 200);
    assert.equal(status.payload?.order_id, unknown.payload.order_id);
  } finally {
    await mockErpControl(DEFAULT_ERP_CONTROL);
  }
});

test('worker parks an unknown ERP order write and the sweeper settles it exactly once', async () => {
  const company = await login('company');
  const { tenantId } = readStackState();
  const address = {
    recipient_name: 'Stack Order Customer',
    phone: '+84900000001',
    postal_code: '700000',
    city: 'Ho Chi Minh City',
    district: 'District 1',
    address_line1: '2 Stack Test Street',
  };
  const createdCustomer = await requestApi('testing/customers', {
    method: 'POST',
    token: company.access_token,
    body: {
      display_name: `Stack order customer ${randomUUID()}`,
      default_shipping_address: address,
    },
  });
  assert.equal(createdCustomer.response.status, 201);
  const customerId = createdCustomer.body?.customer?.id;
  assert.equal(typeof customerId, 'string');
  const widget = await mintWidgetForCustomer(customerId, company.access_token);

  try {
    await mockErpControl({ failure_rate: 0, latency_ms: 0, swallow_after_write: true });

    // The TEST customer creation above already seeds this customer into mock ERP.
    const initialHistory = await signedErpPost('/api/v1/customers/sales-history', {
      tenant_id: tenantId,
      customer_id: customerId,
    });
    assert.equal(initialHistory.response.status, 200);
    assert.equal(initialHistory.payload?.total_order_count, 0);

    const receipt = await turn(widget, 'Please order SKU: NM-L01-BLK qty 1 with Stripe.');
    const pendingTask = await waitTask(receipt.task_id, ['awaiting_human', 'failed', 'completed', 'stopped']);
    assert.equal(pendingTask.status, 'awaiting_human');

    const approvals = await requestApi('approvals?status=PENDING', { token: company.access_token });
    assert.equal(approvals.response.status, 200);
    const approval = approvals.body?.items?.find((item) => item.run_id === receipt.task_id);
    assert.ok(approval, `AUTH-4 order approval missing for run ${receipt.task_id}`);

    const detail = await requestApi(`approvals/${encodeURIComponent(approval.approval_id)}`, {
      token: company.access_token,
    });
    assert.equal(detail.response.status, 200);
    const decision = await requestApi(`approvals/${encodeURIComponent(approval.approval_id)}/decision`, {
      method: 'POST',
      token: company.access_token,
      body: {
        decision: 'APPROVE',
        reason: 'Approve the verified TEST customer order.',
        expected_payload_sha256: detail.body.payload_sha256,
      },
    });
    assert.equal(decision.response.status, 202);
    assert.equal(decision.body?.task_id, receipt.task_id);

    const waiting = await waitTask(receipt.task_id, ['waiting', 'failed', 'completed', 'stopped']);
    assert.equal(waiting.status, 'waiting', `order run did not wait for reconciliation: ${JSON.stringify(waiting)}`);

    const history = await signedErpPost('/api/v1/customers/sales-history', {
      tenant_id: tenantId,
      customer_id: customerId,
    });
    assert.equal(history.response.status, 200);
    assert.equal(history.payload?.total_order_count, 1, 'an UNKNOWN ERP write must not be duplicated');
    assert.deepEqual(history.payload?.recent_orders?.[0]?.line_items, [{
      sku_id: 'NM-L01-BLK',
      product_name: 'Nova Studio 14 Creator (Matte Black)',
      quantity: 1,
      unit_price: 18_900_000,
      currency: 'VND',
    }]);

    // The provider holds the order, so the reconciliation sweeper confirms it by idempotency key and
    // resumes the run (T5.5) without dispatching the write again.
    const settled = await waitTask(receipt.task_id, ['completed', 'failed', 'stopped']);
    assert.equal(settled.status, 'completed', `sweeper did not settle the order run: ${JSON.stringify(settled)}`);
    const settledHistory = await signedErpPost('/api/v1/customers/sales-history', {
      tenant_id: tenantId,
      customer_id: customerId,
    });
    assert.equal(settledHistory.payload?.total_order_count, 1, 'reconciliation must not write a second order');
  } finally {
    await mockErpControl(DEFAULT_ERP_CONTROL);
  }
});
