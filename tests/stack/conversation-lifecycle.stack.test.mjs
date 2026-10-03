import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';

import { signRequest } from '../../services/mock-erp/src/hmac.mjs';
import { login, messages, requestApi, turn, waitTask } from './lib/api.mjs';
import { sql } from './lib/db.mjs';
import { mockErpControl, readStackState } from './lib/stack.mjs';
import { mintWidget } from './lib/widget.mjs';

const TERMINAL_STATES = ['awaiting_human', 'completed', 'failed', 'stopped'];
const HEALTHY_ERP = { failure_rate: 0, latency_ms: 0, swallow_after_write: false };
const FAILURE_MESSAGE = 'Trợ lý chưa trả lời được. Nhân viên sẽ hỗ trợ bạn.';

function skipWithoutCompanyCredentials(t, { widget = false, erp = false } = {}) {
  const credentials = process.env.STACK_AUTH_PROVIDER === 'db'
    ? readStackState().auth?.company
    : { email: process.env.DEMO_COMPANY_ADMIN_EMAIL, password: process.env.DEMO_COMPANY_ADMIN_PASSWORD };
  if (!credentials?.email || !credentials?.password) {
    t.skip('the stack company login credentials are unavailable');
    return true;
  }
  if (widget && !(process.env.DEMO_WIDGET_ORIGINS ?? 'http://localhost:3000').split(',')[0]?.trim()) {
    t.skip('the stack widget origin is unavailable');
    return true;
  }
  if (erp && !process.env.MOCK_SECRET_KEY) {
    t.skip('the signed mock ERP control key is unavailable');
    return true;
  }
  return false;
}

async function conversationSummary(token, conversationId) {
  const result = await requestApi(`conversations/${encodeURIComponent(conversationId)}/summary`, { token });
  assert.equal(result.response.status, 200, 'conversation summary must be readable by its operator');
  return result.body;
}

async function signedErpPost(path, body) {
  const { mockErpUrl, tenantId } = readStackState();
  const secret = process.env.MOCK_SECRET_KEY;
  if (!secret) throw new Error('stack mock ERP signing key is unavailable');
  const rawBody = JSON.stringify({ ...body, tenant_id: tenantId });
  const response = await fetch(new URL(path, mockErpUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': tenantId,
      'x-mock-signature': signRequest(secret, 'POST', path, rawBody),
    },
    body: rawBody,
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.status, 200, `signed mock ERP ${path} returned HTTP ${response.status}`);
  return response.json();
}

// Test Lab verifies identities/consents, but cannot backdate cohort facts. Adjust only this test's
// two TEST customers through the disposable stack connection; sql() remains strictly read-only.
async function ageCampaignFixtures(tenantId, customerIds) {
  assert.equal(process.env.STACK_AUTH_PROVIDER, 'db', 'cohort mutation requires disposable DB auth');
  assert.equal(customerIds.length, 2);
  assert.notEqual(customerIds[0], customerIds[1]);
  const requireDatabase = createRequire(new URL('../../packages/database/package.json', import.meta.url));
  const { Client } = requireDatabase('pg');
  const client = new Client({
    connectionString: readStackState().superDatabaseUrl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
  });
  await client.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE agentos.customers
          SET order_count = 1, total_spent = 1,
              last_interaction_at = CURRENT_TIMESTAMP - INTERVAL '120 days',
              metadata = metadata || jsonb_build_object(
                'last_paid_purchase_at', (CURRENT_TIMESTAMP - INTERVAL '120 days')::text)
        WHERE tenant_id = $1 AND data_class = 'TEST' AND id = ANY($2::uuid[])
        RETURNING id`,
      [tenantId, customerIds],
    );
    assert.equal(updated.rowCount, 2, 'only both newly created tenant-scoped TEST fixtures may be aged');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.end();
  }
}

async function rejectPendingApproval(token, runId) {
  const pending = await requestApi('approvals?status=PENDING', { token });
  assert.equal(pending.response.status, 200);
  const approval = pending.body?.items?.find((item) => item.run_id === runId);
  assert.ok(approval, 'run must pause for an AUTH-4 approval');
  const detail = await requestApi(`approvals/${encodeURIComponent(approval.approval_id)}`, { token });
  assert.equal(detail.response.status, 200);
  const decision = await requestApi(`approvals/${encodeURIComponent(approval.approval_id)}/decision`, {
    method: 'POST', token,
    body: {
      decision: 'REJECT', reason: 'Từ chối hành động kiểm tra; không thực hiện tác vụ.',
      expected_payload_sha256: detail.body.payload_sha256,
    },
  });
  assert.equal(decision.response.status, 202);
  assert.equal(decision.body?.task_id, runId);
}

test('T1.10 / §15.connected.2: stopped AUTH-4 Sales run appends a customer-visible system message', async (t) => {
  if (skipWithoutCompanyCredentials(t, { widget: true, erp: true })) return;
  const company = await login('company');
  const status = await requestApi('testing/status', { token: company.access_token });
  assert.equal(status.response.status, 200);
  if (!status.body?.enabled) {
    t.skip('Test Customer Lab is disabled; a verified AUTH-4 order fixture cannot be created');
    return;
  }
  const originalErp = await mockErpControl({});
  let customerId;
  let pendingRunId;
  try {
    await mockErpControl(HEALTHY_ERP);
    const created = await requestApi('testing/customers', {
      method: 'POST', token: company.access_token,
      body: {
        display_name: `Lifecycle stopped order ${randomUUID()}`,
        default_shipping_address: {
          recipient_name: 'Khách hàng kiểm tra', phone: '+84900000001',
          postal_code: '700000', city: 'Ho Chi Minh City', district: 'District 1',
          address_line1: '2 Stack Test Street',
        },
      },
    });
    assert.equal(created.response.status, 201);
    customerId = created.body?.customer?.id;
    assert.equal(typeof customerId, 'string');
    assert.equal(created.body?.customer?.data_class, 'TEST');
    // A verified order fixture must launch its own customer-bound Test Lab session.
    const origin = (process.env.DEMO_WIDGET_ORIGINS ?? 'http://localhost:3000').split(',')[0].trim();
    const minted = await requestApi(`testing/customers/${encodeURIComponent(customerId)}/widget-session`, {
      method: 'POST', token: company.access_token, body: { origin },
    });
    assert.equal(minted.response.status, 201);
    const widget = { ...minted.body, origin };
    const initial = await turn(widget, 'NM-L01-BLK còn hàng không?');
    assert.equal((await waitTask(initial.task_id, TERMINAL_STATES)).status, 'completed');
    assert.equal(
      (await conversationSummary(company.access_token, initial.conversation_id)).customer?.customer_id,
      customerId,
      'the Test Lab WEB_CHAT identity must bind the widget session to this order customer',
    );
    const before = await messages(company.access_token, initial.conversation_id);
    const previousIds = new Set(before.map((message) => message.message_id));

    // Care/Sales currently use the LLM only before admission (intent classification), so a stub
    // fault there cannot fail a worker run. Reject an actual AUTH-4 order instead: worker.ts sends
    // the same terminal notice for stopped and failed runs, without executing any order effect.
    const stopped = await turn(widget, 'Please order SKU: NM-L01-BLK qty 1 with Stripe.');
    assert.equal(stopped.conversation_id, initial.conversation_id);
    assert.equal((await waitTask(stopped.task_id, TERMINAL_STATES)).status, 'awaiting_human');
    pendingRunId = stopped.task_id;
    await rejectPendingApproval(company.access_token, stopped.task_id);
    pendingRunId = undefined;
    assert.equal((await waitTask(stopped.task_id, ['completed', 'failed', 'stopped'])).status, 'stopped');

    const deadline = Date.now() + 10_000;
    let failureMessages = [];
    do {
      const transcript = await messages(company.access_token, stopped.conversation_id);
      failureMessages = transcript.filter((message) =>
        !previousIds.has(message.message_id)
        && message.sender_type === 'system'
        && message.content === FAILURE_MESSAGE);
      if (failureMessages.length > 0) break;
      await sleep(100);
    } while (Date.now() < deadline);
    assert.equal(failureMessages.length, 1, 'one stopped run must append one support notice');
    const customerRead = await requestApi(`storefront/conversations/${encodeURIComponent(stopped.conversation_id)}/messages`, {
      token: widget.access_token,
      headers: { origin: widget.origin },
    });
    assert.equal(customerRead.response.status, 200);
    assert.ok(customerRead.body?.messages?.some((message) => message.role === 'system' && message.text === FAILURE_MESSAGE),
      'the same support notice must be visible through the customer-scoped transcript');
    const history = await signedErpPost('/api/v1/customers/sales-history', { customer_id: customerId });
    assert.equal(history.total_order_count, 0, 'rejection must not execute the pending order');
  } finally {
    try {
      if (pendingRunId !== undefined) {
        await rejectPendingApproval(company.access_token, pendingRunId);
        await waitTask(pendingRunId, ['completed', 'failed', 'stopped']);
      }
    } finally {
      try {
        if (customerId !== undefined) {
          const deleted = await requestApi(`testing/customers/${encodeURIComponent(customerId)}`, {
            method: 'DELETE', token: company.access_token,
          });
          assert.equal(deleted.response.status, 200, 'only this scenario\'s TEST customer must be removed');
          assert.equal(deleted.body?.deleted, true);
        }
      } finally {
        await mockErpControl(originalErp);
      }
    }
  }
});

test('T1.10: lapsed takeover becomes PAUSED_ORPHAN and operator resume restores AI_ACTIVE', async (t) => {
  if (skipWithoutCompanyCredentials(t, { widget: true, erp: true })) return;
  const company = await login('company');
  const originalErp = await mockErpControl({});
  let conversationId;
  let needsResume = false;
  try {
    await mockErpControl(HEALTHY_ERP);
    const widget = await mintWidget('anonymous');
    // Do not escalate: an ASSIGNED handoff correctly projects NEEDS_HUMAN rather than PAUSED_ORPHAN.
    const receipt = await turn(widget, 'NM-L01-BLK còn hàng không?');
    conversationId = receipt.conversation_id;
    assert.equal((await waitTask(receipt.task_id, TERMINAL_STATES)).status, 'completed');
    assert.equal((await conversationSummary(company.access_token, conversationId)).ownership, 'AI_ACTIVE');
    const takeover = await requestApi(`conversations/${encodeURIComponent(conversationId)}/takeover`, {
      method: 'POST', token: company.access_token,
      body: { reason: 'Kiểm tra phiên tiếp quản hết hạn.', takeover_mode: 'FULL_CONTROL' },
    });
    assert.equal(takeover.response.status, 200);
    needsResume = true;
    assert.equal((await conversationSummary(company.access_token, conversationId)).ownership, 'HUMAN_ME');
    const expiresAt = Date.parse(takeover.body?.lease_expires_at);
    assert.ok(Number.isFinite(expiresAt), 'takeover must publish a lease expiry');
    const remaining = expiresAt - Date.now();
    if (remaining > 75_000) {
      t.skip(`takeover lease needs ${Math.ceil(remaining / 1000)}s to lapse; this scenario allows 75s`);
      return;
    }
    // Acquisition currently uses 60s. Do not heartbeat. The sweeper adds a separate 60s grace
    // window after observing absence, leaving time to observe the orphan and explicitly resume.
    await sleep(Math.max(0, remaining) + 200);
    const deadline = Date.now() + 10_000;
    let summary;
    do {
      summary = await conversationSummary(company.access_token, conversationId);
      if (summary.ownership === 'PAUSED_ORPHAN') break;
      await sleep(200);
    } while (Date.now() < deadline);
    assert.equal(summary.ownership, 'PAUSED_ORPHAN');
    assert.equal(summary.owner, null, 'expired leases must not advertise a live operator');
    const resumed = await requestApi(`conversations/${encodeURIComponent(conversationId)}/resume`, {
      method: 'POST', token: company.access_token,
      body: { handoff_summary: 'Phiên tiếp quản đã hết hạn; trả hội thoại cho trợ lý.' },
    });
    assert.equal(resumed.response.status, 200);
    needsResume = false;
    assert.equal(resumed.body?.status, 'ACTIVE');
    assert.equal((await conversationSummary(company.access_token, conversationId)).ownership, 'AI_ACTIVE');
  } finally {
    try {
      if (needsResume) {
        const restored = await requestApi(`conversations/${encodeURIComponent(conversationId)}/resume`, {
          method: 'POST', token: company.access_token, body: { handoff_summary: 'Kết thúc kiểm tra tiếp quản.' },
        });
        assert.equal(restored.response.status, 200, 'fixture takeover must be released');
      }
    } finally {
      await mockErpControl(originalErp);
    }
  }
});

test('T1.14: anonymous laptop recommendation quotes the recommended SKU mock ERP price', async (t) => {
  if (skipWithoutCompanyCredentials(t, { widget: true, erp: true })) return;
  const company = await login('company');
  const originalErp = await mockErpControl({});
  try {
    await mockErpControl(HEALTHY_ERP);
    const widget = await mintWidget('anonymous');
    const receipt = await turn(widget, 'Recommend a laptop under 20 million VND for graphic design.');
    const task = await waitTask(receipt.task_id, TERMINAL_STATES);
    assert.equal(task.status, 'completed');
    const summary = await conversationSummary(company.access_token, receipt.conversation_id);
    assert.equal(summary.customer, null, 'read-only advice must not require a verified customer or marketing consent');
    assert.match(task.answer ?? '', /Giá niêm yết/, 'anonymous advice must frame the ERP price as a list price, not a binding quote');
    const quote = /\((NM-[A-Z0-9-]+)\)\s*[—–-]\s*Giá niêm yết ERP:\s*(\d[\d,.]*\d|\d)\s*₫/.exec(task.answer ?? '');
    assert.ok(quote, 'the answer must pair a recommended SKU with its Vietnamese-formatted VND list price');
    const sku = quote[1];
    const quotedPrice = Number(quote[2].replace(/[,.]/g, ''));
    const authoritative = await signedErpPost('/api/v1/prices/lookup', { sku_id: sku });
    assert.equal(authoritative.sku_id, sku);
    assert.equal(authoritative.currency, 'VND');
    assert.equal(authoritative.owner_approved, true);
    assert.equal(quotedPrice, authoritative.list_price, 'recommendation price must equal the same SKU ERP price');
    assert.ok(quotedPrice > 0 && quotedPrice <= 20_000_000, 'the grounded recommendation must respect the requested budget');
  } finally {
    await mockErpControl(originalErp);
  }
});

test('T1.13: campaign recipient evidence includes consenting TEST customer and excludes revoked consent', async (t) => {
  if (skipWithoutCompanyCredentials(t)) return;
  if (process.env.STACK_AUTH_PROVIDER !== 'db') {
    t.skip('requires STACK_AUTH_PROVIDER=db for tenant-scoped cohort SQL in the disposable stack DB');
    return;
  }
  const company = await login('company');
  const tenantId = readStackState().tenantId;
  const status = await requestApi('testing/status', { token: company.access_token });
  assert.equal(status.response.status, 200);
  if (!status.body?.enabled) {
    t.skip('Test Customer Lab is disabled for the stack tenant');
    return;
  }
  const customers = [];
  let campaignRunId;
  let campaignSettled = false;
  try {
    for (const label of ['consenting', 'revoked']) {
      const email = `lifecycle-${label}-${randomUUID()}@example.invalid`;
      const created = await requestApi('testing/customers', {
        method: 'POST', token: company.access_token,
        body: {
          display_name: `Lifecycle campaign ${label} ${randomUUID()}`,
          primary_email: email,
          identities: [{ channel_type: 'email', channel_identifier: email, is_primary: true }],
          consents: [{
            consent_type: 'marketing_messaging', channel: 'email', is_granted: true,
            opt_in_method: 'stack_test', evidence_text: 'Synthetic campaign consent fixture.',
          }],
        },
      });
      assert.equal(created.response.status, 201);
      assert.equal(created.body?.customer?.data_class, 'TEST');
      assert.equal(typeof created.body?.customer?.id, 'string');
      customers.push(created.body.customer.id);
    }
    const [consentingId, revokedId] = customers;
    await ageCampaignFixtures(tenantId, customers);
    const revoked = await requestApi(`testing/customers/${encodeURIComponent(revokedId)}/consent`, {
      method: 'POST', token: company.access_token,
      body: {
        consent_type: 'marketing_messaging', channel: 'email', is_granted: false,
        opt_in_method: 'stack_test', evidence_text: 'Synthetic customer withdrew marketing consent.',
      },
    });
    assert.equal(revoked.response.status, 200);
    assert.equal(revoked.body?.consent?.is_granted, false);
    for (const id of customers) {
      const profile = await requestApi(`customers/${encodeURIComponent(id)}/profile`, { token: company.access_token });
      assert.equal(profile.response.status, 200);
      assert.equal(profile.body?.segment, 'HIBERNATING', 'both customers must qualify independently of consent');
      assert.equal(profile.body?.consent_marketing, id === consentingId);
      assert.ok(profile.body?.identities?.some((identity) =>
        identity.channel === 'email' && typeof identity.verified_at === 'string'));
    }
    const segments = await requestApi('campaigns/segments', { token: company.access_token });
    assert.equal(segments.response.status, 200);
    assert.ok(segments.body?.segments?.some((segment) => segment.segment_id === 'inactive_90d' && segment.audience_count >= 1));
    const draft = await requestApi('campaigns/drafts', {
      method: 'POST', token: company.access_token,
      body: {
        idempotency_key: `lifecycle-consent-${randomUUID()}`,
        name: `Kiểm tra đồng ý nhận tin ${randomUUID()}`,
        segment_id: 'inactive_90d', objective: 'winback',
        instruction: 'Soạn lời mời quay lại cho khách hàng đã đồng ý nhận tin qua email.',
        content_constraints: { channel: 'EMAIL_HTML', locale: 'vi-VN', max_length: 800 },
      },
    });
    assert.equal(draft.response.status, 202);
    const runId = draft.body?.task_id;
    assert.equal(typeof runId, 'string');
    campaignRunId = runId;
    assert.equal((await waitTask(runId, TERMINAL_STATES)).status, 'awaiting_human');
    const pending = await requestApi('approvals?status=PENDING', { token: company.access_token });
    assert.equal(pending.response.status, 200);
    const approval = pending.body?.items?.find((item) => item.run_id === runId);
    assert.ok(approval, 'campaign must pause for AUTH-4 approval');
    const detail = await requestApi(`approvals/${encodeURIComponent(approval.approval_id)}`, { token: company.access_token });
    assert.equal(detail.response.status, 200);
    const decision = await requestApi(`approvals/${encodeURIComponent(approval.approval_id)}/decision`, {
      method: 'POST', token: company.access_token,
      body: { decision: 'APPROVE', reason: 'Duyệt kiểm tra đồng ý nhận tin.', expected_payload_sha256: detail.body.payload_sha256 },
    });
    assert.equal(decision.response.status, 202);
    assert.equal((await waitTask(runId, ['completed', 'failed', 'stopped'])).status, 'completed');
    campaignSettled = true;

    // The existing run/trace APIs intentionally expose evidence IDs, not provider response bodies.
    // Read only this tenant/run's immutable recipient evidence; no receipt or delivery is invented.
    const evidence = await sql(
      `SELECT raw_payload->'receipt'->'response_payload' AS audience
         FROM agentos.evidence_records
        WHERE tenant_id = $1 AND run_id = $2
          AND raw_payload->'action'->>'skill_id' = 'skill.mkt.segment_audience'`,
      [tenantId, runId],
    );
    assert.equal(evidence.length, 1, 'campaign must persist one authoritative audience receipt');
    const audience = evidence[0]?.audience;
    assert.equal(audience?.segment_id, 'inactive_90d');
    assert.ok(Array.isArray(audience?.customer_ids), 'audience evidence must name its recipients');
    assert.ok(audience.customer_ids.includes(consentingId), 'consenting customer must be eligible');
    assert.ok(!audience.customer_ids.includes(revokedId), 'revoked customer must never be a campaign recipient');
    assert.equal(audience.matched_customer_count, audience.customer_ids.length);
    const campaign = await requestApi(`campaigns/${encodeURIComponent(runId)}`, { token: company.access_token });
    assert.equal(campaign.response.status, 200);
    assert.equal(campaign.body?.status, 'approved');
    assert.equal(campaign.body?.dispatch?.status, 'NOT_INTEGRATED', 'recipient eligibility must not claim actual delivery');
  } finally {
    try {
      if (campaignRunId !== undefined && !campaignSettled) {
        const pending = await requestApi('approvals?status=PENDING', { token: company.access_token });
        assert.equal(pending.response.status, 200);
        if (pending.body?.items?.some((item) => item.run_id === campaignRunId)) {
          await rejectPendingApproval(company.access_token, campaignRunId);
          await waitTask(campaignRunId, ['completed', 'failed', 'stopped']);
        }
      }
    } finally {
      await Promise.all(customers.map(async (id) => {
        const deleted = await requestApi(`testing/customers/${encodeURIComponent(id)}`, { method: 'DELETE', token: company.access_token });
        assert.equal(deleted.response.status, 200, 'only this scenario\'s TEST customers must be removed');
        assert.equal(deleted.body?.deleted, true);
      }));
    }
  }
});
