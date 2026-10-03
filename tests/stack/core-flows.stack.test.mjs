import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { login, messages, requestApi, turn, waitTask } from './lib/api.mjs';
import { sql } from './lib/db.mjs';
import { mintWidget } from './lib/widget.mjs';
import { readStackState } from './lib/stack.mjs';

const TERMINAL_STATES = ['awaiting_human', 'completed', 'failed', 'stopped'];

async function taskDiagnostic(taskId) {
  try {
    const { tenantId } = readStackState();
    return await sql(
      `SELECT last_error_class, error_details
       FROM agentos.platform_durable_tasks
       WHERE tenant_id = $1 AND task_id = $2`,
      [tenantId, taskId],
    );
  } catch (error) {
    return { diagnostic_query_error: error instanceof Error ? error.message : 'unknown' };
  }
}

async function taskAssertionMessage(task) {
  const errorCode = task.error?.code ?? 'none';
  const diagnostic = await taskDiagnostic(task.task_id);
  return `task.error?.code=${errorCode}; platform_durable_tasks diagnostics=${JSON.stringify(diagnostic)}`;
}

async function assertAgentMessage(task, conversationMessages, label) {
  const context = await taskAssertionMessage(task);
  assert.equal(task.status, 'completed', `${label}: ${context}`);
  assert.ok(typeof task.answer === 'string' && task.answer.trim().length > 0, `${label}: ${context}`);
  assert.ok(
    conversationMessages.some((message) => message.sender_type === 'agent' && message.content.trim().length > 0),
    `${label} conversation has no agent message: ${context}`,
  );
}

test('R1 Sales advisor turn completes with an agent message', async () => {
  const widget = await mintWidget('C05');
  const receipt = await turn(widget, 'I need a laptop under 20 million VND for graphic design.');
  const task = await waitTask(receipt.task_id, TERMINAL_STATES);
  const conversationMessages = await messages(widget.operatorToken, receipt.conversation_id);
  await assertAgentMessage(task, conversationMessages, 'R1 Sales advisor');
});

test('R3 asking for a person enqueues a care handoff', async () => {
  const widget = await mintWidget('C05');
  const receipt = await turn(widget, 'I want to speak to a person');
  const task = await waitTask(receipt.task_id, TERMINAL_STATES);
  const context = await taskAssertionMessage(task);
  assert.equal(task.status, 'awaiting_human', `R3 handoff task did not await a person: ${context}`);

  const { tenantId } = readStackState();
  const handoffs = await sql(
    `SELECT id, status
     FROM agentos.care_handoffs
     WHERE tenant_id = $1 AND conversation_id = $2 AND status = 'ENQUEUED'`,
    [tenantId, receipt.conversation_id],
  );
  assert.ok(handoffs.length > 0, `R3 ENQUEUED care_handoffs row missing: ${context}`);
});

test('R4 Vietnamese SKU stock question completes with an agent message', async () => {
  // A separate persona keeps this turn out of the conversation R3 handed to a person.
  const widget = await mintWidget('C06');
  const receipt = await turn(widget, 'NM-L01-BLK còn hàng không, giá bao nhiêu?');
  const task = await waitTask(receipt.task_id, TERMINAL_STATES);
  const conversationMessages = await messages(widget.operatorToken, receipt.conversation_id);
  await assertAgentMessage(task, conversationMessages, 'R4 SKU availability');
});

test('R6 campaign draft for inactive_90d reaches awaiting_human', async () => {
  const company = await login('company');
  const { response, body } = await requestApi('campaigns/drafts', {
    method: 'POST',
    token: company.access_token,
    body: {
      idempotency_key: `stack-campaign-${randomUUID()}`,
      name: 'Stack win-back inactive 90d',
      segment_id: 'inactive_90d',
      objective: 'winback',
      instruction: 'Create a tenant-scoped reactivation draft for the inactive segment.',
    },
  });
  assert.equal(response.status, 202, `campaign draft returned HTTP ${response.status}`);
  assert.equal(typeof body?.task_id, 'string', 'campaign draft response omitted task_id');

  const task = await waitTask(body.task_id, TERMINAL_STATES);
  const context = await taskAssertionMessage(task);
  assert.equal(task.status, 'awaiting_human', `R6 campaign task did not await human review: ${context}`);
});
