import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { apiV1Url, login, requestApi, turn, waitTask } from './lib/api.mjs';
import { sql } from './lib/db.mjs';
import { llmStubControl, mockErpControl, readStackState } from './lib/stack.mjs';
import { mintWidget, mintWidgetForCustomer } from './lib/widget.mjs';

const TERMINAL_STATES = ['awaiting_human', 'completed', 'failed', 'stopped'];
const DEFAULT_ERP_CONTROL = { failure_rate: 0, latency_ms: 0, swallow_after_write: false };

function skipWithoutCredentials(t, audience) {
  const prefix = audience === 'company' ? 'DEMO_COMPANY_ADMIN' : 'DEMO_PLATFORM_ADMIN';
  if (!process.env[`${prefix}_EMAIL`] || !process.env[`${prefix}_PASSWORD`]) {
    t.skip(`the stack ${audience} login credentials are unavailable`);
    return true;
  }
  return false;
}

function skipWithoutWidgetOrigin(t) {
  if (process.env.DEMO_WIDGET_ORIGINS !== undefined
    && !process.env.DEMO_WIDGET_ORIGINS.split(',')[0]?.trim()) {
    t.skip('the stack widget origin is unavailable');
    return true;
  }
  return false;
}

async function widgetRequest(widget, message, idempotencyKey, token = widget.access_token) {
  const headers = {
    accept: 'application/json',
    origin: widget.origin,
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
  const response = await fetch(`${apiV1Url()}/storefront/stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ message, idempotency_key: idempotencyKey }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      // The status is still asserted when a refusal has no JSON body.
    }
    return { response, body };
  }
  if (!response.body) throw new Error('storefront stream response has no body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let firstLine = '';
  try {
    while (!firstLine.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      firstLine += decoder.decode(value, { stream: true });
      if (firstLine.length > 16_384) throw new Error('storefront receipt exceeded the expected size');
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const receipt = JSON.parse(firstLine.split(/\r?\n/, 1)[0]);
  return { response, receipt };
}

async function countTasks(tenantId) {
  const [row] = await sql(
    'SELECT count(*)::int AS count FROM agentos.platform_durable_tasks WHERE tenant_id = $1',
    [tenantId],
  );
  return row?.count ?? 0;
}

async function waitForResumeEventConsumption(tenantId, runId) {
  const deadline = Date.now() + 30_000;
  do {
    const [task] = await sql(
      `SELECT state_payload ? 'resume_event' AS has_resume_event
         FROM agentos.platform_durable_tasks
        WHERE tenant_id = $1 AND run_id = $2`,
      [tenantId, runId],
    );
    if (!task) throw new Error(`handoff evidence task ${runId} disappeared`);
    if (task.has_resume_event === false) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(`handoff evidence repair was not consumed for task ${runId}`);
}

async function createTestCustomer(companyToken, options = {}) {
  const { response, body } = await requestApi('testing/customers', {
    method: 'POST',
    token: companyToken,
    body: {
      display_name: options.displayName ?? `Stack test customer ${randomUUID()}`,
      consents: [{
        consent_type: 'order_updates',
        channel: 'web_chat',
        is_granted: true,
        opt_in_method: 'stack_test',
        evidence_text: 'synthetic stack fixture',
      }],
      ...(options.order === undefined ? {} : { order: options.order }),
    },
  });
  assert.equal(response.status, 201, `TEST customer creation returned HTTP ${response.status}`);
  assert.equal(body?.customer?.data_class, 'TEST');
  return body.customer;
}

async function hasTestLab(companyToken) {
  const { response, body } = await requestApi('testing/status', { token: companyToken });
  if (!response.ok) return { available: false, reason: `Test Customer Lab status returned HTTP ${response.status}` };
  if (!body?.enabled || !['DEMO', 'TEST'].includes(body.data_class)) {
    return { available: false, reason: `Test Customer Lab is unavailable for data class ${String(body?.data_class)}` };
  }
  return { available: true };
}

test('storefront rejects empty and oversized messages before creating a durable task', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  const widget = await mintWidget('anonymous');
  const { tenantId } = readStackState();
  const cases = [
    { label: 'empty', message: '' },
    { label: 'oversized', message: 'x'.repeat(4001) },
  ];
  for (const scenario of cases) {
    const before = await countTasks(tenantId);
    const { response, body } = await widgetRequest(widget, scenario.message, `invalid-${randomUUID()}`);
    assert.ok(response.status >= 400 && response.status < 500, `${scenario.label} message returned HTTP ${response.status}`);
    assert.equal(body?.error_code, 'VALIDATION_FAILED', `${scenario.label} message did not return a typed validation error`);
    assert.equal(await countTasks(tenantId), before, `${scenario.label} message created a durable task`);
  }
});

test('storefront and platform routes refuse missing or wrong-audience credentials', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutCredentials(t, 'platform') || skipWithoutWidgetOrigin(t)) return;
  const company = await login('company');
  const platform = await login('platform');
  const widget = await mintWidget('anonymous');

  const missing = await widgetRequest(widget, 'hello', `no-token-${randomUUID()}`, '');
  assert.equal(missing.response.status, 401);
  assert.equal(missing.body?.error_code, 'AUTHENTICATION_FAILED');

  const operator = await widgetRequest(widget, 'hello', `operator-${randomUUID()}`, company.access_token);
  assert.equal(operator.response.status, 403);
  assert.equal(operator.body?.error_code, 'INSUFFICIENT_AUTHORITY');

  const { response, body } = await requestApi('platform/usage?from=2025-01-01T00%3A00%3A00Z&to=2030-01-01T00%3A00%3A00Z', {
    token: company.access_token,
  });
  assert.equal(response.status, 403);
  assert.equal(body?.error_code, 'INSUFFICIENT_AUTHORITY');
  assert.ok(platform.access_token);
});

test('storefront idempotency replays one task and rejects a changed body', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  const widget = await mintWidget('anonymous');
  const key = `duplicate-${randomUUID()}`;
  const message = 'I need a laptop for graphic design.';

  const first = await widgetRequest(widget, message, key);
  assert.equal(first.response.status, 200);
  assert.equal(typeof first.receipt?.task_id, 'string');
  const task = await waitTask(first.receipt.task_id, TERMINAL_STATES);
  assert.ok(TERMINAL_STATES.includes(task.status));

  const replay = await widgetRequest(widget, message, key);
  assert.equal(replay.response.status, 200);
  assert.equal(replay.receipt?.task_id, first.receipt.task_id);
  assert.equal(replay.receipt?.conversation_id, first.receipt.conversation_id);

  const conflict = await widgetRequest(widget, 'I need a camera instead.', key);
  assert.equal(conflict.response.status, 409);
  assert.equal(conflict.body?.error_code, 'IDEMPOTENCY_CONFLICT');
});

test('ERP loss makes a Sales price answer explicitly non-authoritative', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  if (!process.env.MOCK_SECRET_KEY) {
    t.skip('the signed mock ERP simulation control is unavailable');
    return;
  }
  try {
    await mockErpControl({ failure_rate: 1, latency_ms: 0, swallow_after_write: false });
    const widget = await mintWidget('anonymous');
    const receipt = await turn(widget, 'NM-L01-BLK còn hàng không, giá bao nhiêu?');
    const task = await waitTask(receipt.task_id, TERMINAL_STATES);
    assert.equal(task.status, 'completed', `Sales price turn ended ${task.status}`);
    assert.match(task.answer ?? '', /chưa lấy được giá chính thức/i);
    assert.doesNotMatch(task.answer ?? '', /\b\d{1,3}(?:[,.]\d{3})+\s*(?:VND|đồng)\b/i);
  } finally {
    await mockErpControl(DEFAULT_ERP_CONTROL);
  }
});

test('a one-shot LLM 429 is retried and the storefront turn completes', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  if (!process.env.LLM_STUB_CONTROL_TOKEN) {
    t.skip('the authenticated stack LLM fault control is unavailable');
    return;
  }
  try {
    await llmStubControl({ faults: [{ match: { kind: 'intent' }, mode: '429', times: 1 }] });
    const widget = await mintWidget('anonymous');
    const receipt = await turn(widget, 'I need a laptop for graphic design.');
    const task = await waitTask(receipt.task_id, TERMINAL_STATES);
    assert.equal(task.status, 'completed');
    assert.ok(typeof task.answer === 'string' && task.answer.trim().length > 0);
    assert.deepEqual(await llmStubControl({ readOnly: true }), [
      { match: { kind: 'intent' }, mode: '429', remaining: 0 },
    ]);
  } finally {
    await llmStubControl({ faults: [] });
  }
});

test('new provisioning has an empty platform company overview', async (t) => {
  if (skipWithoutCredentials(t, 'platform')) return;
  const platform = await login('platform');
  const idempotencyKey = `empty-company-${randomUUID()}`;
  const created = await requestApi('provisioning/tenants', {
    method: 'POST',
    token: platform.access_token,
    body: {
      display_name: `Stack empty company ${randomUUID()}`,
      data_class: 'TEST',
      idempotency_key: idempotencyKey,
    },
  });
  assert.equal(created.response.status, 201, `tenant provisioning returned HTTP ${created.response.status}`);
  assert.equal(typeof created.body?.tenant_id, 'string');

  const overview = await requestApi(`platform/companies/${encodeURIComponent(created.body.tenant_id)}/overview`, {
    token: platform.access_token,
  });
  assert.equal(overview.response.status, 200);
  assert.equal(overview.body?.tenant_id, created.body.tenant_id);
  assert.equal(overview.body?.data_class, 'TEST');
  assert.equal(overview.body?.runs_total, 0);
  assert.equal(overview.body?.runs_failed, 0);
  assert.equal(overview.body?.runs_running, 0);
  assert.equal(overview.body?.runs_waiting, 0);
  assert.equal(overview.body?.reconciliation_count, 0);
  assert.equal(overview.body?.last_activity_at, null);
});

test('a customer cannot read another TEST customer’s order details', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  const company = await login('company');
  const lab = await hasTestLab(company.access_token);
  if (!lab.available) {
    t.skip(lab.reason);
    return;
  }
  const orderNumber = `TEST-ISO-${randomUUID().slice(0, 8).toUpperCase()}`;
  const customerA = await createTestCustomer(company.access_token, {
    displayName: `Stack owner ${randomUUID()}`,
    order: {
      order_number: orderNumber,
      status: 'paid',
      total_amount: 87654321,
      currency: 'VND',
      items: [{ sku_id: 'NM-L01-BLK', quantity: 1 }],
    },
  });
  const customerB = await createTestCustomer(company.access_token, {
    displayName: `Stack other ${randomUUID()}`,
  });
  const widgetB = await mintWidgetForCustomer(customerB.id, company.access_token);

  const receipt = await turn(widgetB, `Where is my order ${orderNumber}?`);
  const task = await waitTask(receipt.task_id, TERMINAL_STATES);
  assert.equal(task.status, 'completed');
  assert.ok(typeof task.answer === 'string' && task.answer.trim().length > 0);
  assert.doesNotMatch(task.answer, new RegExp(orderNumber, 'i'));
  assert.doesNotMatch(task.answer, new RegExp(customerA.display_name, 'i'));
  assert.doesNotMatch(task.answer, /87,654,321|87654321|paid|đã giao/i);

  const [conversation] = await sql(
    'SELECT customer_id::text AS customer_id FROM agentos.conversations WHERE tenant_id = $1 AND id = $2::uuid',
    [readStackState().tenantId, receipt.conversation_id],
  );
  assert.equal(conversation?.customer_id, customerB.id);
});

test('Test Customer Lab reset removes TEST rows while preserving DEMO rows and profile configuration', async (t) => {
  if (skipWithoutCredentials(t, 'company')) return;
  const company = await login('company');
  const lab = await hasTestLab(company.access_token);
  if (!lab.available) {
    t.skip(lab.reason);
    return;
  }
  const { tenantId } = readStackState();
  const [demoBefore] = await sql(
    "SELECT count(*)::int AS count FROM agentos.customers WHERE tenant_id = $1 AND data_class = 'DEMO'",
    [tenantId],
  );
  const [profileBefore] = await sql(
    `SELECT company_name, industry, locale, timezone, currency, brand_profile, version
       FROM agentos.tenant_profiles WHERE tenant_id = $1`,
    [tenantId],
  );
  if (!demoBefore || demoBefore.count < 1) {
    t.skip('the seeded DEMO customer rows required for the preservation check are unavailable');
    return;
  }
  if (!profileBefore) {
    t.skip('the seeded tenant profile required for the configuration preservation check is unavailable');
    return;
  }

  const created = await requestApi('testing/customers', {
    method: 'POST',
    token: company.access_token,
    body: { display_name: `Reset me ${randomUUID()}` },
  });
  assert.equal(created.response.status, 201);
  const customerId = created.body?.customer?.id;
  assert.equal(created.body?.customer?.data_class, 'TEST');

  const dryRun = await requestApi('testing/reset', {
    method: 'POST',
    token: company.access_token,
    body: { dry_run: true },
  });
  assert.equal(dryRun.response.status, 200);
  assert.ok(dryRun.body?.counts?.customers >= 1);
  assert.equal(typeof dryRun.body?.confirm_token, 'string');

  const reset = await requestApi('testing/reset', {
    method: 'POST',
    token: company.access_token,
    body: { dry_run: false, confirm_token: dryRun.body.confirm_token },
  });
  assert.equal(reset.response.status, 200);
  assert.equal(reset.body?.dry_run, false);

  const missing = await requestApi(`testing/customers/${encodeURIComponent(customerId)}`, {
    token: company.access_token,
  });
  assert.equal(missing.response.status, 404);
  const [demoAfter] = await sql(
    "SELECT count(*)::int AS count FROM agentos.customers WHERE tenant_id = $1 AND data_class = 'DEMO'",
    [tenantId],
  );
  const [profileAfter] = await sql(
    `SELECT company_name, industry, locale, timezone, currency, brand_profile, version
       FROM agentos.tenant_profiles WHERE tenant_id = $1`,
    [tenantId],
  );
  assert.equal(demoAfter?.count, demoBefore.count);
  assert.deepEqual(profileAfter, profileBefore);
});

test('escalation, takeover, operator reply, widget read, and resume preserve conversation ownership', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  const company = await login('company');
  const widget = await mintWidget('anonymous');
  const receipt = await turn(widget, 'I want to speak to a person');
  const task = await waitTask(receipt.task_id, TERMINAL_STATES);
  assert.equal(task.status, 'awaiting_human');

  const { tenantId } = readStackState();
  const handoffsBefore = await sql(
    `SELECT id::text AS id, status FROM agentos.care_handoffs
      WHERE tenant_id = $1 AND conversation_id = $2::uuid`,
    [tenantId, receipt.conversation_id],
  );
  assert.ok(handoffsBefore.some((handoff) => handoff.status === 'ENQUEUED'));

  const takeover = await requestApi(`conversations/${encodeURIComponent(receipt.conversation_id)}/takeover`, {
    method: 'POST',
    token: company.access_token,
    body: { reason: 'stack takeover scenario', takeover_mode: 'FULL_CONTROL' },
  });
  assert.equal(takeover.response.status, 200);
  const [paused] = await sql(
    'SELECT state FROM agentos.conversations WHERE tenant_id = $1 AND id = $2::uuid',
    [tenantId, receipt.conversation_id],
  );
  assert.equal(paused?.state, 'paused_takeover');

  const operatorReplyText = `A human operator is replying ${randomUUID()}.`;
  const reply = await requestApi(`conversations/${encodeURIComponent(receipt.conversation_id)}/operator-messages`, {
    method: 'POST',
    token: company.access_token,
    body: { message: operatorReplyText, idempotency_key: `operator-reply-${randomUUID()}` },
  });
  assert.equal(reply.response.status, 201);

  const widgetRead = await requestApi(`storefront/conversations/${encodeURIComponent(receipt.conversation_id)}/messages`, {
    token: widget.access_token,
    headers: { origin: widget.origin },
  });
  assert.equal(widgetRead.response.status, 200);
  assert.ok(widgetRead.body?.messages?.some((message) => message.role === 'operator' && message.text === operatorReplyText));

  await waitForResumeEventConsumption(tenantId, receipt.task_id);

  const resumed = await requestApi(`conversations/${encodeURIComponent(receipt.conversation_id)}/resume`, {
    method: 'POST',
    token: company.access_token,
    body: { handoff_summary: 'The operator answered the customer.' },
  });
  assert.equal(
    resumed.response.status,
    200,
    `resume returned HTTP ${resumed.response.status}: ${JSON.stringify(resumed.body)}`,
  );
  assert.equal(resumed.body?.status, 'ACTIVE');
  const [open] = await sql(
    'SELECT state FROM agentos.conversations WHERE tenant_id = $1 AND id = $2::uuid',
    [tenantId, receipt.conversation_id],
  );
  assert.equal(open?.state, 'open');
  const handoffsAfter = await sql(
    `SELECT status FROM agentos.care_handoffs
      WHERE tenant_id = $1 AND conversation_id = $2::uuid`,
    [tenantId, receipt.conversation_id],
  );
  assert.ok(handoffsAfter.some((handoff) => handoff.status === 'COMPLETED'));
});

test('campaign approval resumes the draft and reports delivery as not integrated', async (t) => {
  if (skipWithoutCredentials(t, 'company')) return;
  const company = await login('company');
  const segments = await requestApi('campaigns/segments', { token: company.access_token });
  if (!segments.response.ok || !segments.body?.segments?.some((segment) => segment.segment_id === 'inactive_90d')) {
    t.skip('the stack campaign segment inactive_90d is unavailable');
    return;
  }

  const draft = await requestApi('campaigns/drafts', {
    method: 'POST',
    token: company.access_token,
    body: {
      idempotency_key: `stack-campaign-${randomUUID()}`,
      name: `Stack campaign ${randomUUID()}`,
      segment_id: 'inactive_90d',
      objective: 'winback',
      instruction: 'Create a tenant-scoped reactivation draft for the inactive segment.',
    },
  });
  assert.equal(draft.response.status, 202);
  const waiting = await waitTask(draft.body.task_id, TERMINAL_STATES);
  assert.equal(waiting.status, 'awaiting_human');

  const pending = await requestApi('approvals?status=PENDING', { token: company.access_token });
  assert.equal(pending.response.status, 200);
  const item = pending.body?.items?.find((candidate) => candidate.run_id === draft.body.task_id);
  assert.ok(item, `pending campaign approval missing for task ${draft.body.task_id}`);
  const detail = await requestApi(`approvals/${encodeURIComponent(item.approval_id)}`, { token: company.access_token });
  assert.equal(detail.response.status, 200);
  assert.match(detail.body?.payload_sha256 ?? '', /^[a-f0-9]{64}$/i);

  const decision = await requestApi(`approvals/${encodeURIComponent(item.approval_id)}/decision`, {
    method: 'POST',
    token: company.access_token,
    body: {
      decision: 'APPROVE',
      reason: 'Approve the stack campaign draft for review.',
      expected_payload_sha256: detail.body.payload_sha256,
    },
  });
  assert.equal(decision.response.status, 202);
  // The decision resumes the same run asynchronously; it stays awaiting_human until the worker claims it.
  const completed = await waitTask(decision.body.task_id, ['completed', 'failed', 'stopped']);
  assert.equal(completed.status, 'completed');

  const campaign = await requestApi(`campaigns/${encodeURIComponent(draft.body.task_id)}`, {
    token: company.access_token,
  });
  assert.equal(campaign.response.status, 200);
  assert.equal(campaign.body?.status, 'approved');
  assert.equal(campaign.body?.dispatch?.status, 'NOT_INTEGRATED');
});
