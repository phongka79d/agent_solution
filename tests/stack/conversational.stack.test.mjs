import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { signRequest } from '../../services/mock-erp/src/hmac.mjs';
import { apiV1Url, login, requestApi, turn, waitTask } from './lib/api.mjs';
import { sql } from './lib/db.mjs';
import { llmStubControl, readStackState } from './lib/stack.mjs';
import { mintWidget, mintWidgetForCustomer } from './lib/widget.mjs';

const TERMINAL_STATES = ['awaiting_human', 'completed', 'failed', 'stopped'];
const HANDOFF_MESSAGE = 'Đã chuyển cho nhân viên hỗ trợ';
const TERMINAL_RESPONSE_SQL = `
  SELECT response_kind, template_key, reason_code, sources
    FROM agentos.run_responses
   WHERE tenant_id = $1 AND run_id = $2
`;

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

function authProvider() {
  return (process.env.AUTH_PROVIDER ?? 'demo').trim().toLowerCase();
}

async function optionalCompanyAccount() {
  if (authProvider() !== 'db') return null;
  return login('company', { authProvider: 'db', as: 'second' });
}

async function storefrontRequest(widget, message, idempotencyKey, { module, token = widget.access_token } = {}) {
  const response = await fetch(`${apiV1Url()}/storefront/stream`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      origin: widget.origin,
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      message,
      idempotency_key: idempotencyKey,
      ...(module === undefined ? {} : { module }),
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    let body = null;
    try {
      body = await response.json();
    } catch {
      // The status assertion still reports non-JSON refusals.
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


async function hasTestLab(companyToken) {
  const { response, body } = await requestApi('testing/status', { token: companyToken });
  if (!response.ok) return { available: false, reason: `Test Customer Lab status returned HTTP ${response.status}` };
  if (!body?.enabled || !['DEMO', 'TEST'].includes(body.data_class)) {
    return { available: false, reason: `Test Customer Lab is unavailable for data class ${String(body?.data_class)}` };
  }
  return { available: true };
}

async function createTestCustomer(companyToken, options = {}) {
  const { response, body } = await requestApi('testing/customers', {
    method: 'POST',
    token: companyToken,
    body: {
      display_name: options.displayName ?? `Stack conversation customer ${randomUUID()}`,
      ...(options.email === undefined ? {} : { primary_email: options.email }),
      ...(options.phone === undefined ? {} : { primary_phone: options.phone }),
      ...(options.defaultShippingAddress === undefined ? {} : { default_shipping_address: options.defaultShippingAddress }),
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

async function taskResponse(taskId) {
  const { tenantId } = readStackState();
  const [row] = await sql(TERMINAL_RESPONSE_SQL, [tenantId, taskId]);
  assert.ok(row, `run_responses row missing for task ${taskId}`);
  return row;
}

async function runToCompletion(widget, message, label) {
  const receipt = await turn(widget, message);
  const task = await waitTask(receipt.task_id, TERMINAL_STATES);
  assert.equal(task.status, 'completed', `${label} task ended ${task.status}: ${JSON.stringify(task.error)}`);
  assert.ok(typeof task.answer === 'string' && task.answer.trim().length > 0, `${label} task has no customer reply`);
  return { receipt, task, response: await taskResponse(receipt.task_id) };
}

async function signedMockErpPost(path, body) {
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
    },
    body: rawBody,
    signal: AbortSignal.timeout(10_000),
  });
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    // The caller reports the status when a service has no JSON response.
  }
  return { response, payload };
}

function assertVietnameseErrorMessage(body) {
  assert.equal(typeof body?.message, 'string', 'error envelope omitted message');
  assert.match(body.message, /[ăâđêôơưáàảãạấầẩẫậắằẳẵặếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ]/i,
    `error message is not Vietnamese: ${body.message}`);
}

function restoreFaultScenarios(faults) {
  return faults
    .filter((fault) => fault.remaining > 0)
    .map(({ match, mode, remaining }) => ({ match, mode, times: remaining }));
}

// T1.1 / T3.3: grounded Care answers cite an immutable knowledge source version.
test('Care return-policy FAQ answer cites a knowledge source version', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  const widget = await mintWidget('anonymous');
  const { task } = await runToCompletion(widget, 'What is your return policy?', 'Care return-policy FAQ');
  const citations = Array.isArray(task.sources) ? task.sources : [];
  assert.ok(citations.some((source) => typeof source.source_file === 'string'
    && source.source_file.startsWith('customer-care/')
    && typeof source.source_version === 'string'
    && /^[a-f0-9]{64}$/i.test(source.source_version)),
  `Care FAQ answer omitted the source version: ${JSON.stringify(task.sources)}`);
});

// T1.3: the customer sees the durable system handoff message and Company sees queue ownership.
test('escalation appends the customer-visible handoff message and projects NEEDS_HUMAN', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  const company = await login('company');
  const widget = await mintWidget('anonymous');
  const receipt = await turn(widget, 'I want to speak to a person');
  const task = await waitTask(receipt.task_id, TERMINAL_STATES);
  assert.equal(task.status, 'awaiting_human');

  const customerMessages = await requestApi(
    `storefront/conversations/${encodeURIComponent(receipt.conversation_id)}/messages`,
    { token: widget.access_token, headers: { origin: widget.origin } },
  );
  assert.equal(customerMessages.response.status, 200);
  assert.ok(customerMessages.body?.messages?.some((message) => message.role === 'system' && message.text === HANDOFF_MESSAGE),
    `customer-visible handoff system message missing: ${JSON.stringify(customerMessages.body?.messages)}`);

  const companyConversations = await requestApi('conversations?limit=200', { token: company.access_token });
  assert.equal(companyConversations.response.status, 200);
  const listed = companyConversations.body?.items?.find((item) => item.conversation_id === receipt.conversation_id);
  assert.equal(listed?.ownership, 'NEEDS_HUMAN', 'Company inbox did not project the enqueued human handoff');
});

// T1.4: each safe conversational fallback is a persisted typed response, not an unfinished task.
test('greeting, unsupported FAQ, and anonymous order lookup complete with typed Care replies', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  const cases = [
    { label: 'greeting', message: 'hi', kind: 'CLARIFICATION' },
    {
      label: 'off-topic FAQ',
      message: 'Who won the 1998 FIFA World Cup?',
      kind: 'NO_ANSWER',
      template: 'care.faq_no_answer_offer_handoff',
      answer: /nhân viên hỗ trợ/i,
    },
    {
      label: 'anonymous order lookup',
      message: `Where is my order ORD-${randomUUID().slice(0, 8).toUpperCase()}?`,
      template: 'care.identity_required',
      answer: /xác minh danh tính/i,
    },
  ];

  for (const scenario of cases) {
    const widget = await mintWidget('anonymous');
    const { receipt, task, response } = await runToCompletion(widget, scenario.message, scenario.label);
    if (scenario.kind !== undefined) assert.equal(response.response_kind, scenario.kind, `${scenario.label} response type`);
    if (scenario.template !== undefined) assert.equal(response.template_key, scenario.template, `${scenario.label} response template`);
    if (scenario.answer !== undefined) assert.match(task.answer, scenario.answer, `${scenario.label} response text`);
    if (scenario.label === 'anonymous order lookup') {
      assert.equal(response.response_kind, 'CLARIFICATION');
      const [conversation] = await sql(
        'SELECT customer_id::text AS customer_id FROM agentos.conversations WHERE tenant_id = $1 AND id = $2::uuid',
        [readStackState().tenantId, receipt.conversation_id],
      );
      assert.equal(conversation?.customer_id, null, 'anonymous widget must not resolve to a verified customer');
    }
  }
});

// T1.4 / §13.2 isolation: mapped status is shown only to the server-verified owner.
test('verified TEST customer sees own PAID order as Đang xử lý; another customer gets no details', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  const company = await login('company');
  const lab = await hasTestLab(company.access_token);
  if (!lab.available) {
    t.skip(lab.reason);
    return;
  }
  const orderNumber = `ORD-${randomUUID().slice(0, 8).toUpperCase()}`;
  const amount = 87_654_321;
  const owner = await createTestCustomer(company.access_token, {
    displayName: `Stack order owner ${randomUUID()}`,
    order: {
      order_number: orderNumber,
      status: 'paid',
      total_amount: amount,
      currency: 'VND',
      items: [{ sku_id: 'NM-L01-BLK', quantity: 1 }],
    },
  });
  const other = await createTestCustomer(company.access_token, {
    displayName: `Stack unrelated customer ${randomUUID()}`,
  });
  const ownerWidget = await mintWidgetForCustomer(owner.id, company.access_token);
  const otherWidget = await mintWidgetForCustomer(other.id, company.access_token);

  const own = await runToCompletion(ownerWidget, `Where is my order ${orderNumber}?`, 'verified own order lookup');
  assert.match(own.task.answer, /Đang xử lý/i, 'PAID order was not projected with the customer-facing processing label');
  assert.doesNotMatch(own.task.answer, /Đã giao/i, 'PAID order was incorrectly projected as delivered');

  const foreign = await runToCompletion(otherWidget, `Where is my order ${orderNumber}?`, 'foreign TEST order lookup');
  for (const secret of [orderNumber, owner.display_name, String(amount), '87,654,321', 'Đang xử lý', 'Đã giao']) {
    assert.equal(foreign.task.answer.includes(secret), false, `foreign order reply leaked ${secret}`);
  }
  const [conversation] = await sql(
    'SELECT customer_id::text AS customer_id FROM agentos.conversations WHERE tenant_id = $1 AND id = $2::uuid',
    [readStackState().tenantId, foreign.receipt.conversation_id],
  );
  assert.equal(conversation?.customer_id, other.id);
});

// T3.3: indexing, citation to the approved content hash, and archive invalidation are exercised end-to-end.
test('knowledge draft approval publishes its version and archive removes it from Care answers', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  const approver = await optionalCompanyAccount();
  if (approver === null) {
    t.skip('a second DB-authenticated company operator is unavailable for distinct knowledge approval');
    return;
  }
  if (!Array.isArray(approver.permissions) || !approver.permissions.includes('knowledge:approve')) {
    t.skip('the second company account does not have knowledge:approve');
    return;
  }

  const company = await login('company');
  const slug = `stack-return-${randomUUID()}`;
  const marker = `STACKPOLICY${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
  const draft = await requestApi('knowledge/documents', {
    method: 'POST',
    token: company.access_token,
    body: {
      namespace: 'customer-care',
      type: 'FAQ',
      slug,
      title: `Stack return policy ${marker}`,
      body: `## FAQ-1: What is the ${marker} return policy?\nThe ${marker} policy permits returns within 37 days when the product is unopened.`,
    },
  });
  assert.equal(draft.response.status, 201);
  assert.equal(draft.body?.status, 'DRAFT');
  const documentId = draft.body.document_id;

  let archivedSuccessfully = false;
  try {
    const submitted = await requestApi(`knowledge/documents/${encodeURIComponent(documentId)}/submit`, {
      method: 'POST', token: company.access_token,
    });
    assert.equal(submitted.response.status, 200);
    assert.equal(submitted.body?.status, 'REVIEW');

    const approved = await requestApi(`knowledge/documents/${encodeURIComponent(documentId)}/approve`, {
      method: 'POST', token: approver.access_token,
    });
    assert.equal(approved.response.status, 200);
    assert.ok(['APPROVED', 'AVAILABLE'].includes(approved.body?.status));
    const contentHash = approved.body.content_sha256;
    assert.match(contentHash, /^[a-f0-9]{64}$/i);

    const waitForAvailable = async () => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const current = await requestApi(`knowledge/documents/${encodeURIComponent(documentId)}`, { token: company.access_token });
        assert.equal(current.response.status, 200);
        if (current.body?.status === 'AVAILABLE') return current.body;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`approved knowledge document ${documentId} did not become AVAILABLE`);
    };
    await waitForAvailable();

    const widget = await mintWidget('anonymous');
    const question = `What is the ${marker} return policy?`;
    const answer = await runToCompletion(widget, question, 'new approved knowledge answer');
    const citations = Array.isArray(answer.task.sources) ? answer.task.sources : [];
    assert.ok(citations.some((source) => source.source_version === contentHash
      && typeof source.source_file === 'string'
      && source.source_file.startsWith('customer-care/')),
    `Care answer did not cite the approved knowledge version: ${JSON.stringify(answer.task.sources)}`);
    assert.match(answer.task.answer, new RegExp(marker, 'i'));

    const archived = await requestApi(`knowledge/documents/${encodeURIComponent(documentId)}/archive`, {
      method: 'POST', token: company.access_token,
    });
    assert.equal(archived.response.status, 200);
    archivedSuccessfully = true;
    assert.equal(archived.body?.status, 'ARCHIVED');

    const afterArchiveWidget = await mintWidget('anonymous');
    const afterArchive = await runToCompletion(afterArchiveWidget, question, 'Care answer after knowledge archive');
    assert.equal(
      (Array.isArray(afterArchive.task.sources) ? afterArchive.task.sources : []).some((source) => source.source_version === contentHash),
      false,
      'Care cited an archived knowledge version',
    );
    assert.equal(afterArchive.task.answer.includes(marker), false, 'Care continued using archived knowledge content');
  } finally {
    if (!archivedSuccessfully) {
      const cleanup = await requestApi(`knowledge/documents/${encodeURIComponent(documentId)}/archive`, {
        method: 'POST', token: company.access_token,
      });
      assert.equal(cleanup.response.status, 200, `knowledge cleanup archive returned HTTP ${cleanup.response.status}`);
    }
  }
});


// §6: AUTH-4 create_order is approved once and produces exactly one mock ERP order.
test('verified TEST customer COD order waits for AUTH-4 approval and creates one ERP order', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  if (!process.env.MOCK_SECRET_KEY) {
    t.skip('the signed mock ERP read key is unavailable');
    return;
  }
  const company = await login('company');
  const lab = await hasTestLab(company.access_token);
  if (!lab.available) {
    t.skip(lab.reason);
    return;
  }
  const customer = await createTestCustomer(company.access_token, {
    displayName: `Stack COD customer ${randomUUID()}`,
    defaultShippingAddress: {
      recipient_name: 'Stack Test Customer',
      phone: '0900000000',
      postal_code: '700000',
      city: 'Ho Chi Minh City',
      district: 'District 1',
      address_line1: '1 Stack Test Street',
    },
  });
  const widget = await mintWidgetForCustomer(customer.id, company.access_token);

  const send = await storefrontRequest(
    widget,
    'I want to place an order for 1 SKU NM-L01-BLK and pay by COD.',
    `stack-cod-order-${randomUUID()}`,
    { module: 'sales' },
  );
  assert.equal(send.response.status, 200);
  assert.equal(typeof send.receipt?.task_id, 'string');
  const waiting = await waitTask(send.receipt.task_id, TERMINAL_STATES);
  assert.equal(waiting.status, 'awaiting_human', `COD order did not wait for approval: ${JSON.stringify(waiting.error)}`);

  const pending = await requestApi('approvals?status=PENDING', { token: company.access_token });
  assert.equal(pending.response.status, 200);
  const approval = pending.body?.items?.find((item) => item.run_id === send.receipt.task_id);
  assert.ok(approval, `AUTH-4 order approval missing for task ${send.receipt.task_id}`);
  const detail = await requestApi(`approvals/${encodeURIComponent(approval.approval_id)}`, { token: company.access_token });
  assert.equal(detail.response.status, 200);
  assert.match(detail.body?.payload_sha256 ?? '', /^[a-f0-9]{64}$/i);
  const [approvalRecord] = await sql(
    'SELECT authority_required FROM agentos.approvals WHERE tenant_id = $1 AND id = $2::uuid',
    [readStackState().tenantId, approval.approval_id],
  );
  assert.equal(approvalRecord?.authority_required, 'AUTH-4');

  const decisionBody = {
    decision: 'APPROVE',
    reason: 'Approve the verified TEST customer COD order.',
    expected_payload_sha256: detail.body.payload_sha256,
  };
  const decision = await requestApi(`approvals/${encodeURIComponent(approval.approval_id)}/decision`, {
    method: 'POST', token: company.access_token, body: decisionBody,
  });
  assert.equal(decision.response.status, 202);
  assert.equal(decision.body?.task_id, send.receipt.task_id);
  const duplicateDecision = await requestApi(`approvals/${encodeURIComponent(approval.approval_id)}/decision`, {
    method: 'POST', token: company.access_token, body: decisionBody,
  });
  assert.equal(duplicateDecision.response.status, 202, 'an identical decision replay was not idempotently accepted');
  assert.equal(duplicateDecision.body?.task_id, decision.body?.task_id);
  const conflictingDecision = await requestApi(`approvals/${encodeURIComponent(approval.approval_id)}/decision`, {
    method: 'POST',
    token: company.access_token,
    body: { ...decisionBody, decision: 'REJECT', reason: 'Conflict with the already queued APPROVE.' },
  });
  assert.equal(conflictingDecision.response.status, 409, 'a conflicting second decision was not rejected');

  const completed = await waitTask(send.receipt.task_id, ['completed', 'failed', 'stopped']);
  assert.equal(completed.status, 'completed', `approved COD order run ended ${completed.status}: ${JSON.stringify(completed.error)}`);
  // The mock ERP has no /__sim read route; this signed projection includes its simulated orders.
  const history = await signedMockErpPost('/api/v1/customers/sales-history', {
    tenant_id: readStackState().tenantId,
    customer_id: customer.id,
  });
  assert.equal(history.response.status, 200, `mock ERP sales-history returned HTTP ${history.response.status}`);
  assert.equal(history.payload?.total_order_count, 1, 'mock ERP did not contain exactly one order for the TEST customer');
  assert.equal(history.payload?.recent_orders?.length, 1);
  assert.ok(history.payload.recent_orders[0]?.line_items?.some((item) => item.sku_id === 'NM-L01-BLK'));
  assert.equal(history.payload.recent_orders[0]?.payment_method, 'CVS_COD');
});

// §13.2 invalid-input and Vietnamese error-envelope assertions.
test('bad module, invalid campaign segment, and out-of-range settings are typed HTTP 400 refusals', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  const company = await login('company');
  const widget = await mintWidget('anonymous');
  const { tenantId } = readStackState();
  const before = await sql('SELECT count(*)::int AS count FROM agentos.platform_durable_tasks WHERE tenant_id = $1', [tenantId]);
  const invalidModule = await storefrontRequest(widget, 'hi', `bad-module-${randomUUID()}`, { module: 'unknown-module' });
  assert.equal(invalidModule.response.status, 400);
  // `module` is an enum-constrained PostMessageRequest field; malformed values are VALIDATION_FAILED.
  assert.equal(invalidModule.body?.error_code, 'VALIDATION_FAILED');
  assertVietnameseErrorMessage(invalidModule.body);

  const invalidSegment = await requestApi('campaigns/drafts', {
    method: 'POST',
    token: company.access_token,
    body: {
      idempotency_key: `bad-segment-${randomUUID()}`,
      name: `Invalid segment ${randomUUID()}`,
      segment_id: `invalid-${randomUUID()}`,
      objective: 'winback',
      instruction: 'This request must be rejected before a task is created.',
    },
  });
  assert.equal(invalidSegment.response.status, 400);
  assert.equal(invalidSegment.body?.error_code, 'VALIDATION_FAILED');
  assertVietnameseErrorMessage(invalidSegment.body);

  const settings = await requestApi('company/settings/governance', { token: company.access_token });
  assert.equal(settings.response.status, 200);
  const validValues = {
    require_distinct_approver: settings.body.require_distinct_approver,
    approval_expiry_hours: settings.body.approval_expiry_hours,
    takeover_lease_seconds: settings.body.takeover_lease_seconds,
  };
  for (const [label, changes] of [
    ['approval expiry below range', { approval_expiry_hours: 0 }],
    ['approval expiry above range', { approval_expiry_hours: 721 }],
    ['takeover lease below range', { takeover_lease_seconds: 29 }],
    ['takeover lease above range', { takeover_lease_seconds: 601 }],
  ]) {
    const invalid = await requestApi('company/settings/governance', {
      method: 'PUT',
      token: company.access_token,
      headers: { 'if-match': `"${settings.body.version}"` },
      body: { ...validValues, ...changes },
    });
    assert.equal(invalid.response.status, 400, `${label} returned HTTP ${invalid.response.status}`);
    assert.equal(invalid.body?.error_code, 'VALIDATION_FAILED', `${label} did not return a typed validation error`);
    assertVietnameseErrorMessage(invalid.body);
  }
  const after = await sql('SELECT count(*)::int AS count FROM agentos.platform_durable_tasks WHERE tenant_id = $1', [tenantId]);
  assert.equal(after[0]?.count, before[0]?.count, 'invalid requests created a durable task');
});

// Auth/CSRF gates that cannot be exercised at this API layer are explicit skips, not false passes.
test('wrong password is refused by DB auth when AUTH_PROVIDER=db', async (t) => {
  if (authProvider() !== 'db') {
    t.skip('AUTH_PROVIDER is not db; the stack is using demo auth rather than durable DB authentication');
    return;
  }
  if (skipWithoutCredentials(t, 'company')) return;
  const result = await requestApi('auth/login', {
    method: 'POST',
    body: {
      email: process.env.DEMO_COMPANY_ADMIN_EMAIL,
      password: 'intentionally-wrong-stack-password',
      audience: 'company',
      tenant_id: readStackState().tenantId,
    },
  });
  assert.equal(result.response.status, 401);
  assert.equal(result.body?.error_code, 'AUTHENTICATION_FAILED');
});

test('BFF missing-CSRF check is not applicable to the API-level stack suite', (t) => {
  t.skip('CSRF is enforced by the browser-facing BFF; direct API requests do not traverse that boundary');
});

test('foreign X-Tenant-ID assertion is refused before company data is returned', async (t) => {
  if (skipWithoutCredentials(t, 'company')) return;
  const company = await login('company');
  const mismatch = await requestApi('company/settings/governance', {
    token: company.access_token,
    headers: { 'x-tenant-id': randomUUID() },
  });
  assert.equal(mismatch.response.status, 403);
  assert.equal(mismatch.body?.error_code, 'TENANT_BINDING_MISMATCH');
  assert.equal(mismatch.body?.settings, undefined);
});

test('company account without knowledge:approve cannot approve a document', async (t) => {
  if (authProvider() !== 'db') {
    if (skipWithoutCredentials(t, 'company')) return;
    t.skip('a separate DB-authenticated company account without knowledge:approve is unavailable');
    return;
  }

  const company = await login('company', { authProvider: 'db' });
  const { tenantId } = readStackState();
  const email = `stack-limited-approval-${randomUUID()}@example.invalid`;
  const password = `StackTest-${randomUUID()}-Aa!`;
  const outboxDir = process.env.EMAIL_OUTBOX_DIR;
  assert.ok(outboxDir, 'stack invitation outbox is unavailable');
  const existing = new Set(await readdir(outboxDir));
  const outboxFiles = [];
  let userId;
  let documentId;
  try {
    const invited = await requestApi('company/users', {
      method: 'POST', token: company.access_token, body: { email, role_bundle: 'OPERATOR' },
    });
    assert.equal(invited.response.status, 201);
    assert.equal(invited.body?.role_bundle, 'OPERATOR');
    let invitationToken;
    for (const name of await readdir(outboxDir)) {
      if (existing.has(name) || !name.startsWith('invitation-') || !name.endsWith('.json')) continue;
      const file = join(outboxDir, name);
      const payload = JSON.parse(await readFile(file, 'utf8'));
      if (payload.to !== email) continue;
      outboxFiles.push(file);
      invitationToken = new URL(payload.invitation_url, 'http://localhost').searchParams.get('token');
      break;
    }
    assert.ok(invitationToken, 'the company invitation was not delivered to the private outbox');
    const accepted = await requestApi('auth/invitations/accept', {
      method: 'POST', body: { token: invitationToken, password, display_name: 'Stack limited approval operator' },
    });
    assert.equal(accepted.response.status, 200);
    assert.equal(accepted.body?.accepted, true);
    assert.equal(accepted.body?.tenant_id, tenantId);
    assert.equal(accepted.body?.scope, 'company');
    const members = await requestApi('company/users', { token: company.access_token });
    assert.equal(members.response.status, 200);
    assert.ok(Array.isArray(members.body?.items), 'company users response omitted members');
    const member = members.body.items.find((item) => item.email === email);
    userId = member?.user_id;
    assert.equal(typeof userId, 'string');
    assert.equal(member.role_bundle, 'OPERATOR');
    assert.equal(member.status, 'ACTIVE');
    const authenticated = await requestApi('auth/login', {
      method: 'POST', body: { email, password, audience: 'company', tenant_id: tenantId },
    });
    assert.equal(authenticated.response.status, 200);
    const limited = authenticated.body;
    assert.equal(typeof limited?.access_token, 'string');
    assert.equal(limited.membership?.scope, 'company');
    assert.equal(limited.identity?.user_id, userId);
    assert.ok(Array.isArray(limited.permissions), 'DB login omitted the operator permissions');
    assert.equal(limited.permissions.includes('knowledge:approve'), false);

    const slug = `stack-denied-approval-${randomUUID()}`;
    const created = await requestApi('knowledge/documents', {
      method: 'POST', token: company.access_token,
      body: {
        namespace: 'customer-care', type: 'FAQ', slug, title: `Limited approval ${slug}`,
        body: '## FAQ-1: Limited approval test\nThis document exists only to verify the approval permission boundary.',
      },
    });
    assert.equal(created.response.status, 201);
    documentId = created.body.document_id;
    const submitted = await requestApi(`knowledge/documents/${encodeURIComponent(documentId)}/submit`, {
      method: 'POST', token: company.access_token,
    });
    assert.equal(submitted.response.status, 200);
    const denied = await requestApi(`knowledge/documents/${encodeURIComponent(documentId)}/approve`, {
      method: 'POST', token: limited.access_token,
    });
    assert.equal(denied.response.status, 403);
    assert.equal(denied.body?.error_code, 'INSUFFICIENT_AUTHORITY');
  } finally {
    try {
      if (documentId) {
        await requestApi(`knowledge/documents/${encodeURIComponent(documentId)}/archive`, {
          method: 'POST', token: company.access_token,
        });
      }
    } finally {
      try {
        if (userId) {
          const deactivated = await requestApi('company/users', {
            method: 'PATCH', token: company.access_token, body: { user_id: userId, status: 'DEACTIVATED' },
          });
          assert.equal(deactivated.response.status, 200);
        }
      } finally {
        await Promise.all(outboxFiles.map((file) => unlink(file)));
      }
    }
  }
});

// Platform projections stay aggregate-only even when TEST customer PII exists in the tenant.
test('platform company and run projections do not expose TEST customer PII', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutCredentials(t, 'platform')) return;
  const company = await login('company');
  const platform = await login('platform');
  const lab = await hasTestLab(company.access_token);
  if (!lab.available) {
    t.skip(lab.reason);
    return;
  }
  const marker = randomUUID();
  const customer = await createTestCustomer(company.access_token, {
    displayName: `Stack PII ${marker}`,
    email: `pii-${marker}@example.invalid`,
    phone: `090-${marker.slice(0, 8)}`,
    defaultShippingAddress: {
      recipient_name: `Recipient ${marker}`,
      phone: `090-${marker.slice(0, 8)}`,
      postal_code: '700000',
      city: 'Ho Chi Minh City',
      district: 'District 1',
      address_line1: `Private Street ${marker}`,
    },
  });
  assert.equal(customer.data_class, 'TEST');
  const widget = await mintWidgetForCustomer(customer.id, company.access_token);

  const runReceipt = await turn(widget, 'What is your return policy?');
  await waitTask(runReceipt.task_id, TERMINAL_STATES);

  const tenantId = readStackState().tenantId;
  const overview = await requestApi(`platform/companies/${encodeURIComponent(tenantId)}/overview`, {
    token: platform.access_token,
  });
  assert.equal(overview.response.status, 200);
  const runs = await requestApi(`platform/runs?${new URLSearchParams({ company_id: tenantId, limit: '200' })}`, {
    token: platform.access_token,
  });
  assert.equal(runs.response.status, 200);
  const listedRun = runs.body.items.find((item) => item.run_id === runReceipt.task_id);
  assert.ok(listedRun, 'platform run list includes the customer-facing task');
  const detail = await requestApi(
    `platform/companies/${encodeURIComponent(tenantId)}/runs/${encodeURIComponent(runReceipt.task_id)}`,
    { token: platform.access_token },
  );
  assert.equal(detail.response.status, 200);

  const privateValues = [
    customer.display_name,
    `pii-${marker}@example.invalid`,
    `090-${marker.slice(0, 8)}`,
    `Private Street ${marker}`,
  ];
  const forbiddenFields = new Set([
    'customer', 'customer_id', 'customer_email', 'customer_phone', 'customer_display_name',
    'email', 'phone', 'primary_email', 'primary_phone', 'shipping_address', 'address', 'address_line1',
  ]);
  const inspectKeys = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) inspectKeys(item);
    } else if (value !== null && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) {
        assert.equal(forbiddenFields.has(key), false, `platform projection included PII field ${key}`);
        inspectKeys(nested);
      }
    }
  };
  for (const projection of [overview.body, runs.body, detail.body]) {
    const serialized = JSON.stringify(projection);
    for (const privateValue of privateValues) {
      assert.equal(serialized.includes(privateValue), false, `platform projection leaked TEST customer data ${privateValue}`);
    }
    inspectKeys(projection);
  }
});

// Skill settings are restored in finally even when the refusal assertion fails.
test('disabled check_price returns a typed refusal to the Sales customer', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  const company = await login('company');
  const skills = await requestApi('skills', { token: company.access_token });
  assert.equal(skills.response.status, 200);
  const skill = skills.body?.skills?.find((candidate) => candidate.skill_id === 'skill.sales.check_price');
  if (!skill) {
    t.skip('skill.sales.check_price is unavailable in the stack skill catalog');
    return;
  }
  if (typeof skill.version !== 'string') {
    t.skip('skill.sales.check_price has no version for an optimistic settings update');
    return;
  }
  const original = {
    enabled: skill.enabled,
    config: skill.config,
    connector_id: skill.connector_id,
  };
  let current = null;
  let settingsChanged = false;
  const updateSkill = (version, values) => requestApi('skills/skill.sales.check_price/settings', {
    method: 'PATCH',
    token: company.access_token,
    headers: { 'if-match': version },
    body: values,
  });

  try {
    const disabled = await updateSkill(skill.version, { ...original, enabled: false });
    if (disabled.response.status === 200) {
      settingsChanged = true;
      current = disabled.body?.skill ?? null;
    }
    assert.equal(disabled.response.status, 200, `disabling check_price returned HTTP ${disabled.response.status}`);
    assert.equal(current?.enabled, false);

    const widget = await mintWidget('anonymous');
    const response = await storefrontRequest(
      widget,
      'NM-L01-BLK còn hàng không, giá bao nhiêu?',
      `disabled-check-price-${randomUUID()}`,
      { module: 'sales' },
    );
    assert.equal(response.response.status, 200);
    const task = await waitTask(response.receipt.task_id, TERMINAL_STATES);
    assert.equal(task.status, 'completed');
    const saved = await taskResponse(response.receipt.task_id);
    assert.equal(saved.response_kind, 'REFUSAL');
    assert.equal(saved.template_key, 'core.skill_unavailable');
    assert.equal(saved.reason_code, 'DISABLED_BY_TENANT');
    assert.ok(typeof task.answer === 'string' && task.answer.trim().length > 0);
  } finally {
    if (settingsChanged) {
      if (typeof current?.version !== 'string') {
        const refreshed = await requestApi('skills/skill.sales.check_price', { token: company.access_token });
        assert.equal(refreshed.response.status, 200, 'could not reload check_price settings for cleanup');
        current = refreshed.body?.skill;
      }
      assert.equal(typeof current?.version, 'string', 'check_price cleanup has no current version');
      const restored = await updateSkill(current.version, original);
      assert.equal(restored.response.status, 200, `restoring check_price returned HTTP ${restored.response.status}`);
      assert.equal(restored.body?.skill?.enabled, original.enabled);
      assert.deepEqual(restored.body?.skill?.config, original.config);
      assert.equal(restored.body?.skill?.connector_id, original.connector_id);
    }
  }
});

// Provider JSON failures must be rendered as a typed refusal with a durable, human-readable cause.
test('LLM invalid JSON produces a typed refusal and a visible run-story failure reason', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  if (!process.env.LLM_STUB_CONTROL_TOKEN) {
    t.skip('the authenticated stack LLM fault control is unavailable');
    return;
  }
  const originalFaults = await llmStubControl({ readOnly: true });
  const uniqueMarker = `LLMJSON${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  try {
    await llmStubControl({ faults: [{ match: { kind: 'intent', contains: uniqueMarker }, mode: 'invalid_json', times: 1 }] });
    const widget = await mintWidget('anonymous');
    const response = await storefrontRequest(
      widget,
      `I need a laptop for graphic design ${uniqueMarker}`,
      `invalid-json-${randomUUID()}`,
      { module: 'sales' },
    );
    assert.equal(response.response.status, 200);
    const task = await waitTask(response.receipt.task_id, TERMINAL_STATES);
    assert.equal(task.status, 'completed', `invalid-JSON run ended ${task.status}: ${JSON.stringify(task.error)}`);
    const saved = await taskResponse(response.receipt.task_id);
    assert.equal(saved.response_kind, 'REFUSAL');
    assert.equal(saved.template_key, 'core.cannot_help');
    assert.equal(saved.reason_code, 'LLM_INVALID_RESPONSE');

    const company = await login('company');
    const story = await requestApi(`runs/${encodeURIComponent(response.receipt.task_id)}/story`, { token: company.access_token });
    assert.equal(story.response.status, 200);
    assert.match(JSON.stringify(story.body), /LLM_INVALID_RESPONSE/,
      'run story did not expose the typed provider failure reason');

    const consumed = await llmStubControl({ readOnly: true });
    assert.ok(consumed.some((fault) => fault.mode === 'invalid_json' && fault.remaining === 0),
      'the malformed JSON fault was not consumed by this turn');
  } finally {
    await llmStubControl({ faults: restoreFaultScenarios(originalFaults) });
  }
});

// Duplicate row: simultaneous replay with one idempotency key must yield one task receipt.
test('double-send with the same idempotency key returns exactly one task', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  const widget = await mintWidget('anonymous');
  const idempotencyKey = `same-send-${randomUUID()}`;
  const message = 'What is your return policy?';
  const [first, second] = await Promise.all([
    storefrontRequest(widget, message, idempotencyKey),
    storefrontRequest(widget, message, idempotencyKey),
  ]);
  assert.equal(first.response.status, 200);
  assert.equal(second.response.status, 200);
  assert.equal(first.receipt?.task_id, second.receipt?.task_id);
  assert.equal(first.receipt?.conversation_id, second.receipt?.conversation_id);
  const [count] = await sql(
    'SELECT count(*)::int AS count FROM agentos.platform_durable_tasks WHERE tenant_id = $1 AND run_id = $2',
    [readStackState().tenantId, first.receipt.task_id],
  );
  assert.equal(count?.count, 1);
  const completed = await waitTask(first.receipt.task_id, TERMINAL_STATES);
  assert.equal(completed.status, 'completed');
});

// The handoff's durable evidence event must be consumed before its assigned operator can complete it.
async function waitForHandoffEvidence(tenantId, runId) {
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

// Lease contention needs two distinct authenticated operators, which demo auth does not provision.
test('concurrent takeover of one conversation has exactly one winning operator', async (t) => {
  if (skipWithoutCredentials(t, 'company') || skipWithoutWidgetOrigin(t)) return;
  const secondOperator = await optionalCompanyAccount();
  if (secondOperator === null) {
    t.skip('a second DB-authenticated company operator is unavailable for a competing takeover');
    return;
  }
  if (!Array.isArray(secondOperator.permissions) || !secondOperator.permissions.includes('conversation:takeover')) {
    t.skip('the second company account does not have conversation:takeover');
    return;
  }

  const company = await login('company');
  const widget = await mintWidget('anonymous');
  const receipt = await turn(widget, 'I want to speak to a person');
  const handoff = await waitTask(receipt.task_id, TERMINAL_STATES);
  assert.equal(handoff.status, 'awaiting_human');

  const body = { reason: 'concurrent stack takeover', takeover_mode: 'FULL_CONTROL' };
  let winnerToken = null;
  try {
    const results = await Promise.all([
      requestApi(`conversations/${encodeURIComponent(receipt.conversation_id)}/takeover`, {
        method: 'POST', token: company.access_token, body,
      }),
      requestApi(`conversations/${encodeURIComponent(receipt.conversation_id)}/takeover`, {
        method: 'POST', token: secondOperator.access_token, body,
      }),
    ]);
    const winners = results.filter((result) => result.response.status === 200);
    const losers = results.filter((result) => result.response.status === 409);
    if (winners.length === 1) {
      const winnerIndex = results.indexOf(winners[0]);
      winnerToken = winnerIndex === 0 ? company.access_token : secondOperator.access_token;
    }
    assert.equal(winners.length, 1, `expected one takeover winner, got statuses ${results.map((item) => item.response.status)}`);
    assert.equal(losers.length, 1, `expected one takeover conflict, got statuses ${results.map((item) => item.response.status)}`);
  } finally {
    if (winnerToken !== null) {
      await waitForHandoffEvidence(readStackState().tenantId, receipt.task_id);
      const resumed = await requestApi(`conversations/${encodeURIComponent(receipt.conversation_id)}/resume`, {
        method: 'POST', token: winnerToken, body: { handoff_summary: 'Concurrent takeover test complete.' },
      });
      assert.equal(resumed.response.status, 200, JSON.stringify(resumed.body));
    }
  }
});
