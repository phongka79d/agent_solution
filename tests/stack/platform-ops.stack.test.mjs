import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { signRequest } from '../../services/mock-erp/src/hmac.mjs';
import { login, requestApi, turn, waitTask } from './lib/api.mjs';
import { llmStubControl, readStackState } from './lib/stack.mjs';

const TASK_TERMINAL_STATES = ['awaiting_human', 'completed', 'failed', 'stopped'];

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function llmStubProviderUrl() {
  const url = new URL(readStackState().llmStubUrl);
  url.hostname = 'host.docker.internal';
  return url.toString();
}

function widgetOrigin() {
  return (process.env.DEMO_WIDGET_ORIGINS ?? 'http://localhost:3000').split(',')[0]?.trim() ?? '';
}

async function configureCompanyLlm(token, providerId) {
  const { response } = await requestApi('company/settings/llm', {
    method: 'PUT',
    token,
    body: {
      mode: 'CUSTOM',
      provider_id: providerId,
      base_url: llmStubProviderUrl(),
      reasoning_model: 'llm-stub',
      fast_model: 'llm-stub',
      timeout_ms: 5000,
      structured_mode: 'json_object',
      api_key: `stack-test-${randomUUID()}`,
    },
  });
  assert.equal(response.status, 200, `company LLM configuration returned HTTP ${response.status}`);
  const probe = await requestApi('company/settings/llm/test', { method: 'POST', token });
  assert.equal(probe.response.status, 200, `company LLM test returned HTTP ${probe.response.status}`);
  assert.equal(probe.body?.outcome, 'PASS');
}

async function createTestWidget(token, name) {
  const origin = widgetOrigin();
  assert.ok(origin, 'stack storefront origin is unavailable');
  const customerResult = await requestApi('testing/customers', {
    method: 'POST',
    token,
    body: {
      display_name: `Stack ${name} ${randomUUID()}`,
      primary_email: `stack-${randomUUID()}@example.invalid`,
      primary_phone: '+15555550123',
    },
  });
  assert.equal(customerResult.response.status, 201, `TEST customer creation returned HTTP ${customerResult.response.status}`);
  const customerId = customerResult.body?.customer?.id;
  assert.equal(typeof customerId, 'string');
  const session = await requestApi(`testing/customers/${encodeURIComponent(customerId)}/widget-session`, {
    method: 'POST',
    token,
    body: { origin },
  });
  assert.equal(session.response.status, 201, `TEST widget session returned HTTP ${session.response.status}`);
  assert.equal(typeof session.body?.access_token, 'string');
  return { ...session.body, origin };
}

async function inviteAndAcceptCompanyAdmin(platformToken, tenantId, outboxFiles) {
  const email = `stack-${randomUUID()}@example.invalid`;
  const password = `StackTest-${randomUUID()}-Aa!`;
  const outboxDir = process.env.EMAIL_OUTBOX_DIR;
  assert.ok(outboxDir, 'stack invitation outbox is unavailable');
  const existingFiles = new Set(await readdir(outboxDir));
  const invitation = await requestApi(`platform/companies/${encodeURIComponent(tenantId)}/invitations`, {
    method: 'POST',
    token: platformToken,
    body: { email, role_bundle: 'COMPANY_ADMIN' },
  });
  assert.equal(invitation.response.status, 201, `company invitation returned HTTP ${invitation.response.status}`);

  let invitationToken;
  for (const name of await readdir(outboxDir)) {
    if (existingFiles.has(name) || !name.startsWith('invitation-') || !name.endsWith('.json')) continue;
    const file = join(outboxDir, name);
    const payload = JSON.parse(await readFile(file, 'utf8'));
    if (payload.to !== email) continue;
    outboxFiles.push(file);
    invitationToken = new URL(payload.invitation_url, 'http://localhost').searchParams.get('token');
    break;
  }
  assert.ok(invitationToken, 'the new invitation was not present in the private outbox');

  const accepted = await requestApi('auth/invitations/accept', {
    method: 'POST',
    body: { token: invitationToken, password, display_name: `Stack admin ${randomUUID()}` },
  });
  assert.equal(accepted.response.status, 200, `invitation acceptance returned HTTP ${accepted.response.status}`);
  assert.equal(accepted.body?.tenant_id, tenantId);

  const authenticated = await requestApi('auth/login', {
    method: 'POST',
    body: { email, password, audience: 'company', tenant_id: tenantId },
  });
  assert.equal(authenticated.response.status, 200, `invited company login returned HTTP ${authenticated.response.status}`);
  assert.equal(typeof authenticated.body?.access_token, 'string');
  return authenticated.body;
}

async function createKnowledgeDocument(token, namespace, type, slug) {
  const created = await requestApi('knowledge/documents', {
    method: 'POST',
    token,
    body: {
      namespace,
      type,
      slug,
      title: `Stack ${namespace} guidance`,
      body: `Approved stack fixture for ${namespace}: answer clearly and use only tenant-approved information.`,
    },
  });
  assert.equal(created.response.status, 201, `knowledge document creation returned HTTP ${created.response.status}`);
  const documentId = created.body?.document_id;
  assert.equal(typeof documentId, 'string');
  const submitted = await requestApi(`knowledge/documents/${encodeURIComponent(documentId)}/submit`, {
    method: 'POST',
    token,
  });
  assert.equal(submitted.response.status, 200, `knowledge submission returned HTTP ${submitted.response.status}`);
  return documentId;
}

async function waitForKnowledgeAvailable(token, documentId) {
  const deadline = Date.now() + 60_000;
  let status = 'unknown';
  do {
    const current = await requestApi(`knowledge/documents/${encodeURIComponent(documentId)}`, { token });
    assert.equal(current.response.status, 200, `knowledge status returned HTTP ${current.response.status}`);
    status = current.body?.status;
    if (status === 'AVAILABLE') return current.body;
    await pause(250);
  } while (Date.now() < deadline);
  assert.equal(status, 'AVAILABLE', `approved knowledge document did not become AVAILABLE within 60 seconds`);
}

async function seedTenantErpCatalog(tenantId) {
  const secret = process.env.MOCK_SECRET_KEY;
  assert.ok(secret, 'stack mock ERP signing key is unavailable');
  const { mockErpUrl } = readStackState();
  const path = '/__sim/seed';
  const skuId = `STACK-${tenantId.slice(0, 8)}-SKU`;
  const rawBody = JSON.stringify({
    tenant_id: tenantId,
    customers: [],
    orders: [],
    products: [{
      sku_id: skuId,
      name: 'Stack tenant product',
      brand: 'Stack Test',
      category: 'Accessories',
      description: 'Synthetic per-tenant ERP fixture',
      list_price: 900,
      original_list_price: 1000,
      floor_price: 700,
      currency: 'USD',
    }],
    inventory: [{ sku_id: skuId, available_quantity: 8, physical_qty: 10, reserved_qty: 2 }],
  });
  const response = await fetch(new URL(path, mockErpUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-tenant-id': tenantId,
      'x-mock-signature': signRequest(secret, 'POST', path, rawBody),
    },
    body: rawBody,
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 200, `per-tenant mock ERP seed returned HTTP ${response.status}`);
}

async function bindTenantErp(token) {
  const integrations = await requestApi('company/integrations', { token });
  assert.equal(integrations.response.status, 200);
  const erp = integrations.body?.items?.find((item) => item.connector_id === 'API-001');
  assert.ok(erp?.binding, 'API-001 binding is unavailable');
  const updated = await requestApi('company/integrations/API-001', {
    method: 'PUT',
    token,
    headers: { 'If-Match': String(erp.binding.version) },
    body: {
      config: { base_url: 'http://mock-erp:8081/api/v1', auth_scheme: 'HMAC_MOCK' },
      secret: process.env.MOCK_SECRET_KEY,
    },
  });
  assert.equal(updated.response.status, 200, `ERP integration update returned HTTP ${updated.response.status}`);
  const probe = await requestApi('company/integrations/API-001/test', { method: 'POST', token });
  assert.equal(probe.response.status, 200, `ERP integration probe returned HTTP ${probe.response.status}`);
  assert.equal(probe.body?.outcome, 'PASS');
  assert.ok(probe.body?.checks?.every((check) => check.outcome === 'PASS'));
}

test('platform provider changes are audited and retryable marketing runs can be re-queued', async (t) => {
  if (!process.env.DEMO_PLATFORM_ADMIN_EMAIL || !process.env.DEMO_PLATFORM_ADMIN_PASSWORD) {
    t.skip('the stack platform login credentials are unavailable');
    return;
  }
  const platform = await login('platform');
  const company = await login('company');
  const { tenantId } = readStackState();

  const health = await requestApi('platform/health', { token: platform.access_token });
  assert.equal(health.response.status, 200, `platform health returned HTTP ${health.response.status}`);
  assert.equal(typeof health.body?.probes?.migrations?.state, 'string');

  const providerId = `stack-provider-${randomUUID()}`;
  const reason = `Stack test provider update ${randomUUID()}`;
  const provider = await requestApi(`platform/providers/${encodeURIComponent(providerId)}`, {
    method: 'PUT',
    token: platform.access_token,
    body: {
      display_name: 'Stack Test LLM Provider',
      base_url: llmStubProviderUrl(),
      reasoning_model: 'llm-stub',
      fast_model: 'llm-stub',
      timeout_ms: 5000,
      structured_mode: 'json_object',
      is_default: false,
      api_key: `stack-provider-${randomUUID()}`,
      reason,
    },
  });
  assert.equal(provider.response.status, 200, `platform provider update returned HTTP ${provider.response.status}`);
  const providerProbe = await requestApi(`platform/providers/${encodeURIComponent(providerId)}/test`, {
    method: 'POST',
    token: platform.access_token,
  });
  assert.equal(providerProbe.response.status, 200, `platform provider probe returned HTTP ${providerProbe.response.status}`);
  assert.equal(providerProbe.body?.outcome, 'PASS');

  const audit = await requestApi('platform/audit?limit=200', { token: platform.access_token });
  assert.equal(audit.response.status, 200, `platform audit returned HTTP ${audit.response.status}`);
  assert.equal(audit.body?.chain_verified, true);
  assert.ok(audit.body?.items?.some((item) => item.action === 'llm.provider.upsert' && item.reason === reason));

  await configureCompanyLlm(company.access_token, `stack-retry-${randomUUID()}`);
  const segments = await requestApi('campaigns/segments', { token: company.access_token });
  if (!segments.response.ok || !segments.body?.segments?.some((segment) => segment.segment_id === 'inactive_90d')) {
    t.skip('the stack campaign segment inactive_90d is unavailable');
    return;
  }

  const oldFaults = await llmStubControl({ readOnly: true });
  const restorableFaults = oldFaults
    .filter((fault) => Number.isSafeInteger(fault.remaining) && fault.remaining > 0)
    .map((fault) => ({ match: fault.match, mode: fault.mode, times: fault.remaining }));
  try {
    // Exhaust 3 adapter attempts × 2 skill attempts × 4 durable attempts.
    await llmStubControl({ faults: [{ match: { kind: 'marketing' }, mode: '500', times: 24 }] });
    const draft = await requestApi('campaigns/drafts', {
      method: 'POST',
      token: company.access_token,
      body: {
        idempotency_key: `stack-platform-retry-${randomUUID()}`,
        name: `Stack retry campaign ${randomUUID()}`,
        segment_id: 'inactive_90d',
        objective: 'winback',
        instruction: 'Create a tenant-scoped reactivation draft.',
      },
    });
    assert.equal(draft.response.status, 202, `campaign draft returned HTTP ${draft.response.status}`);
    const failed = await waitTask(draft.body.task_id, TASK_TERMINAL_STATES);
    assert.equal(failed.status, 'failed');
    const consumedFault = await llmStubControl({ readOnly: true });
    assert.equal(consumedFault[0]?.remaining, 0, 'marketing provider retries did not exhaust the injected 500 fault');

    const runs = await requestApi(`platform/runs?${new URLSearchParams({ company_id: tenantId, limit: '200' })}`, {
      token: platform.access_token,
    });
    assert.equal(runs.response.status, 200, `platform run list returned HTTP ${runs.response.status}`);
    const run = runs.body?.items?.find((item) => item.run_id === draft.body.task_id);
    assert.ok(run, 'failed campaign run is absent from the platform run list');
    assert.equal(run.failure_class, 'RETRYABLE');
    assert.equal(run.retry_eligible, true);

    await llmStubControl({ faults: [] });

    const retried = await requestApi(`platform/companies/${encodeURIComponent(tenantId)}/runs/${encodeURIComponent(run.run_id)}/retry`, {
      method: 'POST',
      token: platform.access_token,
      body: { reason: 'Retry after the injected local provider faults were cleared.' },
    });
    assert.equal(retried.response.status, 202, `platform run retry returned HTTP ${retried.response.status}`);
    assert.equal(retried.body?.run_id, run.run_id);
    const recovered = await waitTask(run.run_id, TASK_TERMINAL_STATES);
    assert.equal(recovered.status, 'awaiting_human');
  } finally {
    await llmStubControl({ faults: restorableFaults });
  }
});

test('DB-auth tenant onboarding waits for AVAILABLE knowledge and isolates company tasks', async (t) => {
  if ((process.env.STACK_AUTH_PROVIDER ?? 'demo').trim().toLowerCase() !== 'db') {
    t.skip('requires STACK_AUTH_PROVIDER=db');
    return;
  }
  const platform = await login('platform');
  const companyA = await login('company');
  const created = await requestApi('provisioning/tenants', {
    method: 'POST',
    token: platform.access_token,
    body: {
      display_name: `Stack onboarded company ${randomUUID()}`,
      data_class: 'TEST',
      idempotency_key: `stack-onboarding-${randomUUID()}`,
    },
  });
  assert.equal(created.response.status, 201, `tenant provisioning returned HTTP ${created.response.status}`);
  const tenantB = created.body?.tenant_id;
  assert.equal(typeof tenantB, 'string');
  assert.equal(created.body?.data_class, 'TEST');

  const outboxFiles = [];
  try {
    const companyB1 = await inviteAndAcceptCompanyAdmin(platform.access_token, tenantB, outboxFiles);
    const companyB2 = await inviteAndAcceptCompanyAdmin(platform.access_token, tenantB, outboxFiles);

    const careBefore = await requestApi('company/ai-team/care', { token: companyB1.access_token });
    assert.equal(careBefore.response.status, 200);
    assert.ok(careBefore.body?.unmet?.some((item) => item.reason_key === 'KNOWLEDGE_NOT_APPROVED'));
    const careBlocked = await requestApi('company/ai-team/care/activate', {
      method: 'POST',
      token: companyB1.access_token,
    });
    assert.equal(careBlocked.response.status, 409);
    assert.equal(careBlocked.body?.error_code, 'PREREQUISITES_UNMET');

    const careDocumentId = await createKnowledgeDocument(
      companyB1.access_token,
      'customer-care',
      'FAQ',
      `stack-customer-care-${randomUUID()}`,
    );
    const brandDocumentId = await createKnowledgeDocument(
      companyB1.access_token,
      'brand',
      'BRAND_VOICE',
      `stack-brand-${randomUUID()}`,
    );
    for (const documentId of [careDocumentId, brandDocumentId]) {
      const approved = await requestApi(`knowledge/documents/${encodeURIComponent(documentId)}/approve`, {
        method: 'POST',
        token: companyB2.access_token,
      });
      assert.equal(approved.response.status, 200, `knowledge approval returned HTTP ${approved.response.status}`);
    }
    await waitForKnowledgeAvailable(companyB2.access_token, careDocumentId);
    await waitForKnowledgeAvailable(companyB2.access_token, brandDocumentId);

    const marketingBeforeLlm = await requestApi('company/ai-team/marketing', { token: companyB1.access_token });
    assert.equal(marketingBeforeLlm.response.status, 200);
    assert.ok(marketingBeforeLlm.body?.unmet?.some((item) => item.reason_key === 'LLM_NOT_VERIFIED'));
    assert.ok(!marketingBeforeLlm.body?.unmet?.some((item) => item.reason_key === 'BRAND_NOT_APPROVED'));
    await configureCompanyLlm(companyB1.access_token, `stack-company-${randomUUID()}`);
    const marketingReady = await requestApi('company/ai-team/marketing', { token: companyB1.access_token });
    assert.equal(marketingReady.response.status, 200);
    assert.equal(marketingReady.body?.unmet?.length, 0);
    const careActive = await requestApi('company/ai-team/care/activate', {
      method: 'POST',
      token: companyB1.access_token,
    });
    assert.equal(careActive.response.status, 200, `Care activation returned HTTP ${careActive.response.status}`);
    assert.equal(careActive.body?.activation_status, 'ACTIVE');
    const marketingActive = await requestApi('company/ai-team/marketing/activate', {
      method: 'POST',
      token: companyB1.access_token,
    });
    assert.equal(marketingActive.response.status, 200, `Marketing activation returned HTTP ${marketingActive.response.status}`);
    assert.equal(marketingActive.body?.activation_status, 'ACTIVE');

    await seedTenantErpCatalog(tenantB);
    await bindTenantErp(companyB1.access_token);
    const salesActive = await requestApi('company/ai-team/sales/activate', {
      method: 'POST',
      token: companyB1.access_token,
    });
    assert.equal(salesActive.response.status, 200, `Sales activation returned HTTP ${salesActive.response.status}`);
    assert.equal(salesActive.body?.activation_status, 'ACTIVE');

    const widgetA = await createTestWidget(companyA.access_token, 'company A');
    const widgetB = await createTestWidget(companyB1.access_token, 'company B');
    const taskA = await turn(widgetA, 'Hello, I need help with my order.');
    const taskB = await turn(widgetB, 'Hello, I need help with my order.');

    const companyAReadingB = await requestApi(`tasks/${encodeURIComponent(taskB.task_id)}`, { token: companyA.access_token });
    assert.equal(companyAReadingB.response.status, 404);
    assert.equal(companyAReadingB.body?.error_code, 'TASK_NOT_FOUND');
    const companyBReadingA = await requestApi(`tasks/${encodeURIComponent(taskA.task_id)}`, { token: companyB1.access_token });
    assert.equal(companyBReadingA.response.status, 404);
    assert.equal(companyBReadingA.body?.error_code, 'TASK_NOT_FOUND');
  } finally {
    await Promise.all(outboxFiles.map((file) => unlink(file).catch(() => {})));
  }
});
