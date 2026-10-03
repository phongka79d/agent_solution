import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  assertBudgetAvailable,
  assertUsageRecorded,
  login,
  mintWidget,
  requestApi,
  turn,
  usageBefore,
  waitTask,
} from './helpers.mjs';

const TERMINAL_STATES = ['awaiting_human', 'completed', 'failed', 'stopped'];

async function platformAndCompany() {
  await assertBudgetAvailable();
  const [company, platform] = await Promise.all([login('company'), login('platform')]);
  assert.equal(typeof company.membership?.tenant_id, 'string', 'company login omitted tenant_id');
  return { company, platform, tenantId: company.membership.tenant_id };
}

test('real-provider Sales intent turn completes and records usage', { timeout: 300_000 }, async () => {
  const { company, platform, tenantId } = await platformAndCompany();
  const before = await usageBefore(platform.access_token, tenantId, 'sales');
  const widget = await mintWidget(company.access_token);
  const receipt = await turn(widget, 'I need a laptop under 20 million VND for graphic design.');
  const task = await waitTask(company.access_token, receipt.task_id, TERMINAL_STATES);

  assert.equal(task.status, 'completed', `Sales intent turn ended ${task.status}`);
  assert.ok(typeof task.answer === 'string' && task.answer.trim().length > 0, 'Sales intent turn returned no customer answer');
  await assertUsageRecorded(platform.access_token, tenantId, 'sales', before);
});

test('Care FAQ answer is grounded in NovaMart return policy and records usage', { timeout: 300_000 }, async () => {
  const { company, platform, tenantId } = await platformAndCompany();
  // Platform projections name the Care domain by its wire value `support` (migrations 0043/0051).
  const before = await usageBefore(platform.access_token, tenantId, 'support');
  const widget = await mintWidget(company.access_token);
  const receipt = await turn(widget, 'What is NovaMart’s return policy for an unopened laptop?');
  const task = await waitTask(company.access_token, receipt.task_id, TERMINAL_STATES);

  assert.equal(task.status, 'completed', `Care FAQ turn ended ${task.status}`);
  assert.match(task.answer ?? '', /14(?:[ -]day| ngày)/i, 'Care FAQ answer omitted the 14-day return window');
  assert.match(task.answer ?? '', /unopened|chưa mở|chưa khui|niêm phong/i, 'Care FAQ answer omitted the unopened-item requirement');
  const citations = Array.isArray(task.sources) ? task.sources : [];
  assert.ok(
    citations.some((source) => source.source_file?.startsWith('customer-care/')
      && typeof source.source_version === 'string'
      && /^[a-f0-9]{64}$/i.test(source.source_version)),
    'Care FAQ answer omitted its immutable knowledge source version',
  );

  await assertUsageRecorded(platform.access_token, tenantId, 'support', before);
});

test('real-provider campaign draft reaches awaiting_human and records usage', { timeout: 300_000 }, async () => {
  const { company, platform, tenantId } = await platformAndCompany();
  const before = await usageBefore(platform.access_token, tenantId, 'marketing');
  const draftId = randomUUID();
  // Names are customer-visible copy: unique, but never a raw UUID (the UI copy lint rejects those).
  const draftLabel = Date.now().toString(36).toUpperCase();
  const draft = await requestApi('campaigns/drafts', {
    method: 'POST',
    token: company.access_token,
    body: {
      idempotency_key: `live-campaign-${draftId}`,
      name: `Live campaign ${draftLabel}`,
      segment_id: 'inactive_90d',
      objective: 'winback',
      instruction: 'Create a synthetic NovaMart customer win-back draft for human review.',
    },
  });
  assert.equal(draft.response.status, 202, `campaign draft returned HTTP ${draft.response.status}`);
  assert.equal(typeof draft.body?.task_id, 'string', 'campaign draft omitted task_id');
  const task = await waitTask(company.access_token, draft.body.task_id, TERMINAL_STATES);

  assert.equal(task.status, 'awaiting_human', `campaign draft ended ${task.status} instead of awaiting human review`);
  await assertUsageRecorded(platform.access_token, tenantId, 'marketing', before);
});
