import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';

import { waitTask as pollTask } from '../../scripts/demo/lib/wait-task.mjs';
import { signRequest } from '../../services/mock-erp/src/hmac.mjs';
import { login, messages, requestApi, turn, waitTask } from './lib/api.mjs';
import { sql } from './lib/db.mjs';
import { llmStubControl, readStackState } from './lib/stack.mjs';
import { mintWidget } from './lib/widget.mjs';

const TERMINAL_STATES = ['awaiting_human', 'completed', 'failed', 'stopped'];
const SKU = 'NM-L01-BLK';

function skipWithoutCredentials(t, audience) {
  const provider = (process.env.STACK_AUTH_PROVIDER ?? 'demo').trim().toLowerCase();
  const prefix = audience === 'company' ? 'DEMO_COMPANY_ADMIN' : 'DEMO_PLATFORM_ADMIN';
  const credentials = provider === 'db' ? readStackState().auth?.[audience] : {
    email: process.env[`${prefix}_EMAIL`], password: process.env[`${prefix}_PASSWORD`],
  };
  if (!credentials?.email || !credentials.password) {
    t.skip(`the stack ${audience} login credentials are unavailable`);
    return true;
  }
  return false;
}

async function erpBinding(token) {
  const result = await requestApi('company/integrations', { token });
  assert.equal(result.response.status, 200);
  const binding = result.body?.items?.find((item) => item.connector_id === 'API-001')?.binding;
  assert.ok(binding, 'API-001 binding is unavailable');
  assert.ok(Number.isSafeInteger(binding.version));
  return binding;
}

async function connectErp(token, config = { base_url: 'http://mock-erp:8081/api/v1', auth_scheme: 'HMAC_MOCK' }) {
  const current = await erpBinding(token);
  const updated = await requestApi('company/integrations/API-001', {
    method: 'PUT', token, headers: { 'If-Match': String(current.version) },
    body: { config, secret: process.env.MOCK_SECRET_KEY },
  });
  assert.equal(updated.response.status, 200, `ERP configuration returned HTTP ${updated.response.status}`);
  const probe = await requestApi('company/integrations/API-001/test', { method: 'POST', token });
  assert.equal(probe.response.status, 200);
  assert.equal(probe.body?.outcome, 'PASS');
  assert.ok(Array.isArray(probe.body?.checks));
  assert.ok(probe.body.checks.length > 0);
  assert.ok(probe.body.checks.every((check) => check.outcome === 'PASS'));
  assert.equal(probe.body?.binding?.status, 'BOUND');
  return probe.body.binding;
}

async function responseFor(tenantId, taskId) {
  const [response] = await sql(
    `SELECT response_kind, template_key, reason_code FROM agentos.run_responses
      WHERE tenant_id = $1 AND run_id = $2`,
    [tenantId, taskId],
  );
  assert.ok(response, 'the completed turn has no durable typed response');
  return response;
}

async function assertVisibleAnswer(token, receipt, task) {
  assert.equal(task.status, 'completed');
  assert.equal(typeof task.answer, 'string');
  assert.ok(task.answer.trim(), 'the completed task has no answer');
  const history = await messages(token, receipt.conversation_id);
  assert.ok(history.some((message) => message.sender_type === 'agent' && message.content === task.answer),
    'the task answer was not persisted as an agent message');
}

test('T2.6 ERP connect and probe power Sales stock/price; disconnect yields a typed connector refusal', async (t) => {
  if (skipWithoutCredentials(t, 'company')) return;
  if (!process.env.MOCK_SECRET_KEY) {
    t.skip('the stack mock ERP signing key is unavailable');
    return;
  }
  const company = await login('company');
  const token = company.access_token;
  const { tenantId } = readStackState();
  try {
    const connected = await connectErp(token);
    const widget = await mintWidget('anonymous');
    const receipt = await turn(widget, `${SKU} còn hàng không, giá bao nhiêu?`);
    const task = await waitTask(receipt.task_id, TERMINAL_STATES);
    await assertVisibleAnswer(token, receipt, task);
    assert.equal((await responseFor(tenantId, receipt.task_id)).response_kind, 'ANSWER');
    const executed = await sql(
      `SELECT DISTINCT skill_id FROM agentos.run_stage_results
        WHERE tenant_id = $1 AND run_id = $2 AND stage = 'EXECUTION' AND status = 'completed'`,
      [tenantId, receipt.task_id],
    );
    for (const skillId of ['skill.sales.check_stock', 'skill.sales.check_price']) {
      assert.ok(executed.some((stage) => stage.skill_id === skillId), `${skillId} did not use the connected ERP`);
    }

    const disconnected = await requestApi('company/integrations/API-001/disconnect', {
      method: 'POST', token, headers: { 'If-Match': String(connected.version) },
    });
    assert.equal(disconnected.response.status, 200);
    assert.equal(disconnected.body?.binding?.status, 'UNBOUND');
    // The runtime gate may retain the previous verdict for at most five seconds.
    await pause(5_100);
    const refusedReceipt = await turn(widget, `${SKU} còn hàng không, giá bao nhiêu?`);
    const refusedTask = await waitTask(refusedReceipt.task_id, TERMINAL_STATES);
    await assertVisibleAnswer(token, refusedReceipt, refusedTask);
    const refusal = await responseFor(tenantId, refusedReceipt.task_id);
    assert.equal(refusal.response_kind, 'REFUSAL');
    assert.equal(refusal.template_key, 'core.skill_unavailable');
    assert.equal(refusal.reason_code, 'CONNECTOR_UNBOUND');
  } finally {
    // Later stack scenarios share this DEMO tenant; leave a verified, usable mock binding.
    await connectErp(token);
    // The runtime gate may retain the disconnected verdict for up to five seconds; let it expire
    // so the next scenario's Sales turns see the reconnected binding.
    await pause(5_100);
  }
});

async function inviteAdmin(platformToken, tenantId, outboxFiles) {
  const email = `stack-onboarding-${randomUUID()}@example.invalid`;
  const password = `StackTest-${randomUUID()}-Aa!`;
  const outboxDir = process.env.EMAIL_OUTBOX_DIR;
  assert.ok(outboxDir, 'stack invitation outbox is unavailable');
  const existing = new Set(await readdir(outboxDir));
  const invited = await requestApi(`platform/companies/${encodeURIComponent(tenantId)}/invitations`, {
    method: 'POST', token: platformToken, body: { email, role_bundle: 'COMPANY_ADMIN' },
  });
  assert.equal(invited.response.status, 201);
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
  assert.ok(invitationToken, 'the tenant invitation was not delivered to the private outbox');
  const accepted = await requestApi('auth/invitations/accept', {
    method: 'POST', body: { token: invitationToken, password, display_name: 'Stack onboarding admin' },
  });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body?.tenant_id, tenantId);
  const authenticated = await requestApi('auth/login', {
    method: 'POST', body: { email, password, audience: 'company', tenant_id: tenantId },
  });
  assert.equal(authenticated.response.status, 200);
  assert.equal(typeof authenticated.body?.access_token, 'string');
  return authenticated.body;
}

async function configureCompany(token, tenantId) {
  const before = await requestApi('company/settings/profile', { token });
  assert.equal(before.response.status, 200);
  const profile = await requestApi('company/settings/profile', {
    method: 'PUT', token, headers: { 'If-Match': String(before.body.version) },
    body: {
      company_name: 'Stack connected company', industry: 'Retail', locale: 'vi-VN',
      timezone: 'Asia/Ho_Chi_Minh', currency: 'USD', brand_profile: { voice: 'Clear and factual' },
    },
  });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.body?.tenant_id, tenantId);
  assert.equal(profile.body?.currency, 'USD');
  const providerUrl = new URL(readStackState().llmStubUrl);
  providerUrl.hostname = 'host.docker.internal';
  const llm = await requestApi('company/settings/llm', {
    method: 'PUT', token,
    body: {
      mode: 'CUSTOM', provider_id: `stack-onboarding-${randomUUID()}`, base_url: providerUrl.toString(),
      reasoning_model: 'llm-stub', fast_model: 'llm-stub', timeout_ms: 5000,
      structured_mode: 'json_object', api_key: `stack-test-${randomUUID()}`,
    },
  });
  assert.equal(llm.response.status, 200);
  const probe = await requestApi('company/settings/llm/test', { method: 'POST', token });
  assert.equal(probe.response.status, 200);
  assert.equal(probe.body?.outcome, 'PASS');

  const path = '/__sim/seed';
  const body = JSON.stringify({
    tenant_id: tenantId, customers: [], orders: [],
    products: [{
      sku_id: SKU, name: 'Second company stock fixture', brand: 'Stack Test', category: 'Accessories',
      description: 'Tenant-isolated stock and price', list_price: 913, original_list_price: 1000,
      floor_price: 700, currency: 'USD',
    }],
    inventory: [{ sku_id: SKU, available_quantity: 7, physical_qty: 9, reserved_qty: 2 }],
  });
  const seeded = await fetch(new URL(path, readStackState().mockErpUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json', 'x-tenant-id': tenantId,
      'x-mock-signature': signRequest(process.env.MOCK_SECRET_KEY, 'POST', path, body),
    },
    body, signal: AbortSignal.timeout(5000),
  });
  assert.equal(seeded.status, 200);
  await connectErp(token);
  const activated = await requestApi('company/ai-team/sales/activate', { method: 'POST', token });
  assert.equal(activated.response.status, 200);
  assert.equal(activated.body?.activation_status, 'ACTIVE');
}

async function companyWidget(token) {
  const origin = (process.env.DEMO_WIDGET_ORIGINS ?? 'http://localhost:3000').split(',')[0]?.trim();
  assert.ok(origin, 'the stack widget origin is unavailable');
  const customer = await requestApi('testing/customers', {
    method: 'POST', token, body: { display_name: `Stack onboarding customer ${randomUUID()}` },
  });
  assert.equal(customer.response.status, 201);
  assert.equal(typeof customer.body?.customer?.id, 'string');
  const widget = await requestApi(`testing/customers/${encodeURIComponent(customer.body.customer.id)}/widget-session`, {
    method: 'POST', token, body: { origin },
  });
  assert.equal(widget.response.status, 201);
  assert.equal(typeof widget.body?.access_token, 'string');
  return { ...widget.body, origin };
}

async function prepareMarketing(token, approverToken) {
  // The knowledge-backed brand audit reads every allowlisted namespace/slug.
  const documents = [
    {
      namespace: 'brand', type: 'BRAND_VOICE', slug: 'voice',
      title: 'Stack factual brand voice', body: 'Be clear and factual. Do not invent product claims or discounts.',
    },
    {
      namespace: 'brand', type: 'BRAND_VOICE', slug: 'terminology',
      title: 'Stack brand terminology', body: 'Use the product names and categories from the tenant catalog.',
    },
    {
      namespace: 'brand', type: 'BRAND_VOICE', slug: 'prohibited-claims',
      title: 'Stack prohibited brand claims', body: '# Prohibited claims\n- Guaranteed zero risk\n- 100% money back guarantee',
    },
    {
      namespace: 'marketing', type: 'MARKETING_GUIDELINE', slug: 'playbook',
      title: 'Stack marketing playbook', body: 'Create factual reactivation drafts for the requested tenant segment.',
    },
    {
      namespace: 'marketing', type: 'MARKETING_GUIDELINE', slug: 'content-guidelines',
      title: 'Stack marketing content guidelines', body: 'Use clear, concise copy. Do not invent claims, prices or discounts.',
    },
  ];
  for (const body of documents) {
    const document = await requestApi('knowledge/documents', { method: 'POST', token, body });
    assert.equal(document.response.status, 201);
    const documentId = document.body?.document_id;
    assert.equal(typeof documentId, 'string');
    const submitted = await requestApi(`knowledge/documents/${encodeURIComponent(documentId)}/submit`, { method: 'POST', token });
    assert.equal(submitted.response.status, 200);
    const approved = await requestApi(`knowledge/documents/${encodeURIComponent(documentId)}/approve`, {
      method: 'POST', token: approverToken,
    });
    assert.equal(approved.response.status, 200);
    const deadline = Date.now() + 60_000;
    for (;;) {
      const current = await requestApi(`knowledge/documents/${encodeURIComponent(documentId)}`, { token });
      assert.equal(current.response.status, 200);
      if (current.body?.status === 'AVAILABLE') break;
      assert.ok(Date.now() < deadline, `approved ${body.namespace}/${body.slug} document did not become AVAILABLE`);
      await pause(250);
    }
  }
  const activated = await requestApi('company/ai-team/marketing/activate', { method: 'POST', token });
  assert.equal(activated.response.status, 200);
  assert.equal(activated.body?.activation_status, 'ACTIVE');
  const governance = await requestApi('company/settings/governance', { token });
  assert.equal(governance.response.status, 200);
  const configured = await requestApi('company/settings/governance', {
    method: 'PUT', token, headers: { 'If-Match': String(governance.body.version) },
    body: {
      require_distinct_approver: true, approval_expiry_hours: governance.body.approval_expiry_hours,
      takeover_lease_seconds: governance.body.takeover_lease_seconds,
    },
  });
  assert.equal(configured.response.status, 200);
  for (const skillId of ['skill.mkt.segment_audience', 'skill.mkt.generate_content', 'skill.mkt.dispatch_campaign']) {
    const current = await requestApi(`skills/${skillId}`, { token });
    assert.equal(current.response.status, 200);
    const skill = current.body?.skill;
    assert.ok(skill);
    const enabled = await requestApi(`skills/${skillId}/settings`, {
      method: 'PATCH', token,
      headers: skill.version === null ? {} : { 'If-Match': skill.version },
      body: { enabled: true, config: skill.config, connector_id: skill.connector_id },
    });
    assert.equal(enabled.response.status, 200);
    const assigned = await requestApi(`skills/${skillId}/agents`, {
      method: 'PUT', token, body: { agents: skill.allowed_agents },
    });
    assert.equal(assigned.response.status, 200);
  }
}

async function campaignDraft(token) {
  const result = await requestApi('campaigns/drafts', {
    method: 'POST', token,
    body: {
      idempotency_key: `stack-onboarding-draft-${randomUUID()}`, name: 'Second company campaign',
      segment_id: 'inactive_90d', objective: 'winback', instruction: 'Create a clear, tenant-scoped reactivation draft.',
    },
  });
  assert.equal(result.response.status, 202);
  assert.equal(typeof result.body?.task_id, 'string');
  return result.body.task_id;
}

test('DB-auth second-company connected onboarding', async (t) => {
  if ((process.env.STACK_AUTH_PROVIDER ?? 'demo').trim().toLowerCase() !== 'db') {
    t.skip('requires STACK_AUTH_PROVIDER=db');
    return;
  }
  if (skipWithoutCredentials(t, 'platform') || skipWithoutCredentials(t, 'company')) return;
  assert.ok(process.env.MOCK_SECRET_KEY, 'the stack mock ERP signing key is unavailable');
  assert.ok(process.env.LLM_STUB_CONTROL_TOKEN, 'the stack LLM fault control is unavailable');
  const platform = await login('platform');
  const companyA = await login('company');
  const created = await requestApi('provisioning/tenants', {
    method: 'POST', token: platform.access_token,
    body: { display_name: `Stack connected ${randomUUID()}`, data_class: 'TEST', idempotency_key: randomUUID() },
  });
  assert.equal(created.response.status, 201);
  const tenantId = created.body?.tenant_id;
  assert.equal(typeof tenantId, 'string');
  assert.notEqual(tenantId, readStackState().tenantId);
  assert.equal(created.body?.data_class, 'TEST');
  const grants = await sql('SELECT code, assigned_authority FROM agentos.agents WHERE tenant_id = $1', [tenantId]);
  assert.equal(grants.find((agent) => agent.code === 'SAL-02')?.assigned_authority, 'AUTH-3');
  assert.equal(grants.find((agent) => agent.code === 'MKT-02')?.assigned_authority, 'AUTH-3');
  assert.equal(grants.find((agent) => agent.code === 'MKT-03')?.assigned_authority, 'AUTH-2');
  assert.ok(grants.every((agent) => ['AUTH-0', 'AUTH-1', 'AUTH-2', 'AUTH-3'].includes(agent.assigned_authority)),
    'provisioning must never assign the AUTH-4 approval route as a clearance');
  const outboxFiles = [];
  try {
    const company = await inviteAdmin(platform.access_token, tenantId, outboxFiles);
    const approver = await inviteAdmin(platform.access_token, tenantId, outboxFiles);
    const token = company.access_token;
    await configureCompany(token, tenantId);

    await t.test('T2.8 / §15.connected.4 a newly configured Sales company completes a widget turn without worker restart', async () => {
      const baseline = await requestApi('skills', { token });
      assert.equal(baseline.response.status, 200);
      for (const skillId of ['skill.sales.check_stock', 'skill.sales.check_price']) {
        const skill = baseline.body?.skills?.find((item) => item.skill_id === skillId);
        assert.equal(skill?.effect_class, 'READ');
        assert.equal(skill?.enabled, true, 'provisioning must enable READ skills without operator setup');
        assert.equal(skill?.availability?.available, true);
        assert.equal(skill?.availability?.reason, 'OK');
      }
      const widget = await companyWidget(token);
      const receipt = await turn(widget, `${SKU} còn hàng không, giá bao nhiêu?`);
      // The shared waitTask logs in as company A; use the same polling implementation with B's bearer.
      const task = await pollTask({
        baseUrl: readStackState().apiUrl, token, taskId: receipt.task_id,
        terminalStates: TERMINAL_STATES, timeoutMs: 120_000,
      });
      await assertVisibleAnswer(token, receipt, task);
      assert.equal((await responseFor(tenantId, receipt.task_id)).response_kind, 'ANSWER');
      assert.match(task.answer, /913/, 'Sales did not use the newly provisioned tenant ERP price');
      const isolated = await requestApi(`tasks/${encodeURIComponent(receipt.task_id)}`, { token: companyA.access_token });
      assert.equal(isolated.response.status, 404);
      assert.equal(isolated.body?.error_code, 'TASK_NOT_FOUND');
    });

    await t.test('T4.5 a campaign parks with attention and evidence-backed promotion unlocks draft skills', async () => {
      await prepareMarketing(token, approver.access_token);
      for (const skillId of ['skill.mkt.segment_audience', 'skill.mkt.generate_content']) {
        const before = await requestApi(`skills/${skillId}`, { token });
        assert.equal(before.response.status, 200);
        assert.equal(before.body?.skill?.availability?.available, false);
        assert.equal(before.body?.skill?.availability?.reason, 'PARKED_UNTIL_PROMOTED');
        const parkedId = await campaignDraft(token);
        const parked = await pollTask({
          baseUrl: readStackState().apiUrl, token, taskId: parkedId,
          terminalStates: [...TERMINAL_STATES, 'waiting'], timeoutMs: 120_000,
        });
        assert.equal(parked.status, 'waiting', 'the unpromoted draft must park before executing');
        const [checkpoint] = await sql(
          `SELECT t.state_payload->>'wait_reason' AS wait_reason
             FROM agentos.platform_durable_tasks t
            WHERE t.tenant_id = $1 AND t.run_id = $2`,
          [tenantId, parkedId],
        );
        assert.equal(checkpoint?.wait_reason, 'OTHER', 'a draft admission must not claim an unknown provider effect');
        // Earlier, promoted steps may have settled; the parked step itself must have no reservation.
        const [pendingReservation] = await sql(
          `SELECT COUNT(*)::int AS reservations FROM agentos.effect_reservations
            WHERE tenant_id = $1 AND run_id = $2 AND skill_id = $3`,
          [tenantId, parkedId, skillId],
        );
        assert.equal(pendingReservation?.reservations, 0, 'the draft-gated skill must park before reservation');
        const [executed] = await sql(
          `SELECT COUNT(*)::int AS executions FROM agentos.run_stage_results
            WHERE tenant_id = $1 AND run_id = $2 AND stage = 'EXECUTION' AND skill_id = $3`,
          [tenantId, parkedId, skillId],
        );
        assert.equal(executed?.executions, 0, 'the draft-gated skill must park before provider execution');
        const attention = await requestApi('company/attention', { token });
        assert.equal(attention.response.status, 200);
        assert.ok(attention.body?.items?.some((item) => item.type === 'PARKED_DRAFT'
          && item.domain === 'marketing' && item.params?.skill_id === skillId),
        'the parked draft has no company attention item');
        const [evidence] = await sql(
          `SELECT COUNT(*)::int AS observations,
                  COUNT(*) FILTER (WHERE r.stage = 'EXECUTION' AND NOT EXISTS (
                    SELECT 1 FROM agentos.audit_records a
                    WHERE a.tenant_id = r.tenant_id AND a.run_id = r.run_id AND a.skill = r.skill_id
                      AND (a.action->>'step_index' = r.step_index::text OR (
                        a.action->>'step_index' IS NULL AND EXISTS (
                          SELECT 1 FROM agentos.evidence_records e
                          WHERE e.tenant_id = r.tenant_id AND e.run_id = r.run_id AND e.step_index = r.step_index
                            AND e.raw_payload#>>'{action,skill_id}' = r.skill_id
                            AND e.effect_key = a.action->>'effect_key'
                        )
                      ))
                  ))::int AS audit_gaps,
                  COUNT(*) FILTER (WHERE summary_key IS NULL OR input_digest IS NULL OR output_digest IS NULL)::int AS evidence_gaps
             FROM agentos.run_stage_results r
            WHERE r.tenant_id = $1 AND r.skill_id = $2 AND r.started_at >= NOW() - INTERVAL '30 days'`,
          [tenantId, skillId],
        );
        assert.ok(evidence?.observations > 0, 'promotion requires observed skill stages');
        assert.equal(evidence.audit_gaps, 0, 'promotion requires persisted audits bound to executed skill steps');
        assert.equal(evidence.evidence_gaps, 0, 'promotion requires complete durable evidence');
        const inspection = await requestApi(`platform/companies/${encodeURIComponent(tenantId)}/autonomy`, {
          token: platform.access_token,
        });
        assert.equal(inspection.response.status, 200);
        const currentPolicy = inspection.body?.current?.find((policy) => policy.skill_id === skillId);
        const promotion = await requestApi(`company/autonomy/${skillId}/promotion-requests`, {
          method: 'POST', token,
          body: {
            policy_version: currentPolicy?.policy_version ?? 'MINIMUM',
            required_authority: before.body.skill.required_authority,
            reason: 'Review the server-recorded parked draft evidence.',
          },
        });
        assert.equal(promotion.response.status, 200);
        assert.equal(promotion.body?.request?.status, 'PENDING');
        assert.equal(promotion.body?.request?.evidence_window?.audit_complete, true);
        assert.equal(promotion.body?.request?.evidence_window?.evidence_complete, true);
        const requestId = promotion.body?.request?.request_id;
        assert.equal(typeof requestId, 'string');
        const decision = await requestApi(`company/autonomy/promotion-requests/${encodeURIComponent(requestId)}/decision`, {
          method: 'POST', token: approver.access_token,
          body: { decision: 'APPROVE', reason: 'Approve this evidence-backed draft capability.' },
        });
        assert.equal(decision.response.status, 200);
        assert.equal(decision.body?.request?.status, 'APPROVED');
        assert.notEqual(decision.body?.request?.approver_id, decision.body?.request?.requester_id);
        assert.equal(decision.body?.policy?.state, 'PROMOTED');
        const after = await requestApi(`skills/${skillId}`, { token });
        assert.equal(after.response.status, 200);
        assert.equal(after.body?.skill?.availability?.available, true);
        assert.equal(after.body?.skill?.availability?.reason, 'OK');
      }
    });

    await t.test('T8.1 platform retries a failed RETRYABLE run under the second company tenant', async () => {
      const oldFaults = await llmStubControl({ readOnly: true });
      const restore = oldFaults.filter((fault) => Number.isSafeInteger(fault.remaining) && fault.remaining > 0)
        .map((fault) => ({ match: fault.match, mode: fault.mode, times: fault.remaining }));
      try {
        // 3 provider attempts × 2 skill attempts × 4 durable attempts.
        await llmStubControl({ faults: [{ match: { kind: 'marketing' }, mode: '500', times: 24 }] });
        const taskId = await campaignDraft(token);
        const failed = await pollTask({
          baseUrl: readStackState().apiUrl, token, taskId,
          terminalStates: TERMINAL_STATES, timeoutMs: 120_000,
        });
        assert.equal(failed.status, 'failed');
        const runs = await requestApi(`platform/runs?${new URLSearchParams({ company_id: tenantId, limit: '200' })}`, {
          token: platform.access_token,
        });
        assert.equal(runs.response.status, 200);
        const run = runs.body?.items?.find((item) => item.run_id === taskId);
        assert.ok(run, 'the second-company failed run is missing from platform operations');
        assert.equal(run.failure_class, 'RETRYABLE');
        const [failure] = await sql(
          'SELECT error_details FROM agentos.platform_durable_tasks WHERE tenant_id = $1 AND run_id = $2',
          [tenantId, taskId],
        );
        assert.equal(failure?.error_details?.code, 'LLM_UNAVAILABLE',
          'the retry scenario must fail on the injected LLM fault, not an onboarding capability or clearance gap');
        assert.equal(run.retry_eligible, true);
        const wrongTenant = await requestApi(`platform/companies/${encodeURIComponent(readStackState().tenantId)}/runs/${encodeURIComponent(taskId)}/retry`, {
          method: 'POST', token: platform.access_token, body: { reason: 'Verify explicit target-tenant isolation.' },
        });
        assert.equal(wrongTenant.response.status, 404);
        assert.equal(wrongTenant.body?.error_code, 'TASK_NOT_FOUND');
        await llmStubControl({ faults: [] });
        const retried = await requestApi(`platform/companies/${encodeURIComponent(tenantId)}/runs/${encodeURIComponent(taskId)}/retry`, {
          method: 'POST', token: platform.access_token, body: { reason: 'The local provider fault is cleared.' },
        });
        assert.equal(retried.response.status, 202);
        assert.equal(retried.body?.run_id, taskId);
        assert.equal(retried.body?.status, 'accepted');
        const recovered = await pollTask({
          baseUrl: readStackState().apiUrl, token, taskId,
          terminalStates: TERMINAL_STATES, timeoutMs: 120_000,
        });
        assert.equal(recovered.status, 'awaiting_human');
        const isolated = await requestApi(`tasks/${encodeURIComponent(taskId)}`, { token: companyA.access_token });
        assert.equal(isolated.response.status, 404);
        const [stored] = await sql(
          `SELECT tenant_id, state AS lifecycle_state FROM agentos.platform_durable_tasks WHERE run_id = $1`, [taskId],
        );
        assert.equal(stored?.tenant_id, tenantId);
        assert.equal(stored?.lifecycle_state, 'awaiting_human');
      } finally {
        await llmStubControl({ faults: restore });
      }
    });
  } finally {
    try {
      // Tenant data and audit history are retained, but the synthetic company stops participating in polling.
      const suspended = await requestApi(`platform/companies/${encodeURIComponent(tenantId)}/suspend`, {
        method: 'POST', token: platform.access_token, body: { reason: 'Connected onboarding stack fixture cleanup.' },
      });
      assert.equal(suspended.response.status, 200);
    } finally {
      await Promise.all(outboxFiles.map((file) => unlink(file)));
    }
  }
});
