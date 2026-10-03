import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { login, requestApi, turn, waitTask } from './lib/api.mjs';
import { readStackState } from './lib/stack.mjs';
import { mintWidget } from './lib/widget.mjs';

const TERMINAL_STATES = ['awaiting_human', 'completed', 'failed', 'stopped'];

function skipWithoutCompanyCredentials(t, second = false) {
  const dbAuth = (process.env.STACK_AUTH_PROVIDER ?? 'demo').trim().toLowerCase() === 'db';
  const credentials = dbAuth
    ? readStackState().auth?.[second ? 'secondCompany' : 'company']
    : { email: process.env.DEMO_COMPANY_ADMIN_EMAIL, password: process.env.DEMO_COMPANY_ADMIN_PASSWORD };
  if (!credentials?.email || !credentials?.password) {
    t.skip(`the stack ${second ? 'second ' : ''}company login credentials are unavailable`);
    return true;
  }
  return false;
}

function stubLlmSettings() {
  const url = new URL(readStackState().llmStubUrl);
  url.hostname = 'host.docker.internal';
  return {
    mode: 'CUSTOM',
    provider_id: `stack-governance-${randomUUID()}`,
    base_url: url.toString(),
    reasoning_model: 'llm-stub',
    fast_model: 'llm-stub',
    timeout_ms: 5000,
    structured_mode: 'json_object',
  };
}

function storedLlmSettings(settings) {
  return {
    mode: settings.mode,
    monthly_token_budget: settings.monthly_token_budget,
    ...(settings.mode === 'CUSTOM' ? {
      provider_id: settings.provider_id,
      base_url: settings.base_url,
      reasoning_model: settings.reasoning_model,
      fast_model: settings.fast_model,
      timeout_ms: settings.timeout_ms,
      structured_mode: settings.structured_mode,
    } : {}),
  };
}

async function readLlmSettings(token) {
  const result = await requestApi('company/settings/llm', { token });
  assert.equal(result.response.status, 200, `LLM settings read returned HTTP ${result.response.status}`);
  assert.ok(['INHERIT', 'CUSTOM'].includes(result.body?.mode));
  return result.body;
}

async function putLlmSettings(token, body) {
  const result = await requestApi('company/settings/llm', { method: 'PUT', token, body });
  assert.equal(result.response.status, 200, `LLM settings update returned HTTP ${result.response.status}`);
  return result.body;
}

async function hasCampaignSegment(t, token) {
  const result = await requestApi('campaigns/segments', { token });
  assert.equal(result.response.status, 200, `campaign segments returned HTTP ${result.response.status}`);
  if (!result.body?.segments?.some((segment) => segment.segment_id === 'inactive_90d')) {
    t.skip('the stack campaign segment inactive_90d is unavailable');
    return false;
  }
  return true;
}

async function createCampaign(token, taskName) {
  const result = await requestApi('campaigns/drafts', {
    method: 'POST',
    token,
    body: {
      idempotency_key: `stack-${taskName}-${randomUUID()}`,
      name: `Stack ${taskName} ${randomUUID()}`,
      segment_id: 'inactive_90d',
      objective: 'winback',
      instruction: 'Create a tenant-scoped reactivation draft for the inactive segment.',
    },
  });
  assert.equal(result.response.status, 202, `campaign draft returned HTTP ${result.response.status}`);
  assert.equal(typeof result.body?.task_id, 'string');
  return result.body.task_id;
}

async function campaignApproval(token, taskId) {
  const trace = await requestApi(`runs/${encodeURIComponent(taskId)}/trace`, { token });
  assert.equal(trace.response.status, 200, `campaign trace returned HTTP ${trace.response.status}`);
  assert.equal(typeof trace.body?.approval_id, 'string', 'campaign run has no persisted approval');
  const detail = await requestApi(`approvals/${encodeURIComponent(trace.body.approval_id)}`, { token });
  assert.equal(detail.response.status, 200, `approval detail returned HTTP ${detail.response.status}`);
  assert.equal(detail.body?.run_id, taskId);
  assert.match(detail.body?.payload_sha256 ?? '', /^[a-f0-9]{64}$/i);
  return detail.body;
}

async function putGovernance(token, settings, version) {
  const result = await requestApi('company/settings/governance', {
    method: 'PUT',
    token,
    headers: { 'If-Match': String(version) },
    body: {
      require_distinct_approver: settings.require_distinct_approver,
      approval_expiry_hours: settings.approval_expiry_hours,
      takeover_lease_seconds: settings.takeover_lease_seconds,
    },
  });
  assert.equal(result.response.status, 200, `governance update returned HTTP ${result.response.status}`);
  return result.body;
}

test('T1.5 an unconfigured LLM fails a campaign with LLM_NOT_CONFIGURED and zero retries', (t) => {
  // global-setup always supplies the stub's OPENAI_API_KEY and PRIMARY_REASONING_MODEL.
  // INHERIT falls back to that ENV provider; CUSTOM without a secret is invalid.
  // Do not revoke an existing custom secret to manufacture an unreachable configuration.
  t.skip('LLM_NOT_CONFIGURED is unreachable through the public company LLM settings API in this stack: INHERIT resolves the boot environment provider, and CUSTOM requires a configured secret.');
});

test('T2.4 distinct-approver governance refuses the campaign owner with APPROVER_MUST_DIFFER', async (t) => {
  if ((process.env.STACK_AUTH_PROVIDER ?? 'demo').trim().toLowerCase() !== 'db') {
    t.skip('requires STACK_AUTH_PROVIDER=db and two distinct company operators');
    return;
  }
  if (skipWithoutCompanyCredentials(t) || skipWithoutCompanyCredentials(t, true)) return;
  const company = await login('company');
  const second = await login('company', { as: 'second' });
  const token = company.access_token;
  if (!await hasCampaignSegment(t, token)) return;
  const initial = await requestApi('company/settings/governance', { token });
  assert.equal(initial.response.status, 200);
  const previous = initial.body;
  let taskId;
  try {
    const enabled = await putGovernance(token, { ...previous, require_distinct_approver: true }, previous.version);
    assert.equal(enabled.require_distinct_approver, true);
    taskId = await createCampaign(token, 'T2.4');
    const waiting = await waitTask(taskId, TERMINAL_STATES);
    assert.equal(waiting.status, 'awaiting_human');
    const approval = await campaignApproval(token, taskId);
    assert.equal(approval.status, 'PENDING');
    const refused = await requestApi(`approvals/${encodeURIComponent(approval.approval_id)}/decision`, {
      method: 'POST',
      token,
      body: {
        decision: 'APPROVE',
        reason: 'Attempt self-approval with distinct approvers required.',
        expected_payload_sha256: approval.payload_sha256,
      },
    });
    assert.equal(refused.response.status, 403);
    assert.equal(refused.body?.error_code, 'APPROVER_MUST_DIFFER');
    const unchanged = await campaignApproval(token, taskId);
    assert.equal(unchanged.status, 'PENDING');
    assert.equal(unchanged.decided_by, null);
    assert.equal(unchanged.payload_sha256, approval.payload_sha256);
  } finally {
    try {
      if (taskId !== undefined) {
        const task = await waitTask(taskId, TERMINAL_STATES);
        if (task.status === 'awaiting_human') {
          const approval = await campaignApproval(second.access_token, taskId);
          const cancelled = await requestApi(`approvals/${encodeURIComponent(approval.approval_id)}/decision`, {
            method: 'POST',
            token: second.access_token,
            body: {
              decision: 'CANCEL',
              reason: 'Clean up the distinct-approver stack campaign without dispatching it.',
              expected_payload_sha256: approval.payload_sha256,
            },
          });
          assert.equal(cancelled.response.status, 202, `campaign cleanup returned HTTP ${cancelled.response.status}`);
          assert.equal(cancelled.body?.status, 'QUEUED', 'the independent operator must queue the cancellation');
          const stopped = await waitTask(taskId, ['completed', 'failed', 'stopped']);
          assert.equal(stopped.status, 'stopped');
        }
      }
    } finally {
      const current = await requestApi('company/settings/governance', { token });
      assert.equal(current.response.status, 200);
      const restored = await putGovernance(token, previous, current.body.version);
      assert.equal(restored.require_distinct_approver, previous.require_distinct_approver);
      assert.equal(restored.approval_expiry_hours, previous.approval_expiry_hours);
      assert.equal(restored.takeover_lease_seconds, previous.takeover_lease_seconds);
    }
  }
});

test('T2.5 the next turn records the newly configured company model in the provider ledger', async (t) => {
  if (skipWithoutCompanyCredentials(t)) return;
  if (!(process.env.DEMO_WIDGET_ORIGINS ?? 'http://localhost:3000').split(',')[0]?.trim()) {
    t.skip('the stack widget origin is unavailable');
    return;
  }
  const company = await login('company');
  const token = company.access_token;
  const widget = await mintWidget('anonymous');
  const previous = await readLlmSettings(token);
  const suffix = randomUUID();
  const reasoningModel = `stack-reasoning-${suffix}`;
  const fastModel = `stack-fast-${suffix}`;
  try {
    const changed = await putLlmSettings(token, {
      ...stubLlmSettings(),
      reasoning_model: reasoningModel,
      fast_model: fastModel,
      monthly_token_budget: null,
      // Keep an existing custom secret intact; the local stub accepts any non-empty test key.
      ...(previous.mode === 'CUSTOM' && previous.secret_configured ? {} : {
        api_key: `stack-model-${randomUUID()}`,
      }),
    });
    assert.equal(changed.effective?.reasoning_model, reasoningModel);
    assert.equal(changed.effective?.fast_model, fastModel);
    const receipt = await turn(widget, 'I need a laptop for graphic design.');
    const completed = await waitTask(receipt.task_id, TERMINAL_STATES);
    assert.equal(completed.status, 'completed');
    const trace = await requestApi(`runs/${encodeURIComponent(receipt.task_id)}/trace`, { token });
    assert.equal(trace.response.status, 200);
    assert.equal(trace.body?.run_id, receipt.task_id);
    assert.ok(Array.isArray(trace.body?.provider_calls), 'the run trace omitted its provider ledger');
    const intentCall = trace.body.provider_calls.find((call) => call.model === fastModel);
    assert.ok(intentCall, 'the next turn did not record the updated fast model in its intent provider call');
    // API classification uses CONTEXT; the recorded intent/hypothesis call may use HYPOTHESIS.
    assert.ok(['CONTEXT', 'HYPOTHESIS'].includes(intentCall.stage), `unexpected intent provider stage: ${intentCall.stage}`);
    assert.equal(intentCall.tenant_id, readStackState().tenantId);
    assert.equal(intentCall.run_id, receipt.task_id);
    assert.equal(intentCall.observed_status, 'SUCCESS');
    assert.ok(intentCall.prompt_tokens > 0);
    assert.ok(intentCall.completion_tokens > 0);
  } finally {
    // Restore a previously unconfigured CUSTOM state without retaining the temporary credential.
    if (previous.mode === 'CUSTOM' && !previous.secret_configured) {
      await putLlmSettings(token, { mode: 'INHERIT' });
    }
    await putLlmSettings(token, storedLlmSettings(previous));
  }
});
