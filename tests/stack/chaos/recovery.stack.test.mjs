import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { afterEach, beforeEach } from 'node:test';

import { apiV1Url, login, messages, requestApi, turn, waitTask } from '../lib/api.mjs';
import { sql } from '../lib/db.mjs';
import { readStackState, controlStackService, llmStubControl, mockErpControl } from '../lib/stack.mjs';
import { mintWidget } from '../lib/widget.mjs';

const DEFAULT_ERP_CONTROL = { failure_rate: 0, latency_ms: 0, swallow_after_write: false };

const ERP_REFUSAL_CODES = Object.freeze({
  TIMEOUT: true,
  PROVIDER_TIMEOUT: true,
  AUTHORITATIVE_SOURCE_UNAVAILABLE: true,
});
// Readiness probes run serially and can each consume their two-second network timeout.
const READINESS_REQUEST_TIMEOUT_MS = 15_000;

async function resetChaosControls() {
  await Promise.all([
    mockErpControl(DEFAULT_ERP_CONTROL),
    llmStubControl({ faults: [] }),
  ]);
}

beforeEach(resetChaosControls);
afterEach(resetChaosControls);

function assertAuthoritativeRefusalWithoutPrice(stages, answer, context) {
  assert.ok(
    stages.some((stage) => stage.status === 'refused' && Object.hasOwn(ERP_REFUSAL_CODES, stage.refusal_code)),
    `${context}: Sales did not record an ERP refusal: ${JSON.stringify(stages)}`,
  );
  assert.doesNotMatch(
    answer,
    /(?:[$€£₫]\s*\d|\b(?:VND|VNĐ)\s*[\d,.]+|[\d,.]+\s*(?:VND|VNĐ|đồng|đ|₫)|(?:giá|price)[^\d]{0,16}\d[\d,.]*)/i,
    `${context}: customer reply must not contain an unverified price`,
  );
}
const TERMINAL_STATES = ['awaiting_human', 'completed', 'failed', 'stopped'];
const TASK_TERMINAL_STATES = TERMINAL_STATES;
const STOREFRONT_REQUEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 100;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function taskRunId(taskId) {
  const { tenantId } = readStackState();
  const [task] = await sql(
    `SELECT run_id
       FROM agentos.platform_durable_tasks
      WHERE tenant_id = $1 AND run_id = $2`,
    [tenantId, taskId],
  );
  assert.ok(task?.run_id, `durable task ${taskId} is unavailable`);
  return task.run_id;
}

async function waitForPersistedPlan(taskId, timeoutMs = 30_000) {
  const { tenantId } = readStackState();
  const deadline = Date.now() + timeoutMs;
  let lastState = 'missing';
  while (Date.now() < deadline) {
    const [task] = await sql(
      `SELECT durable.state,
              durable.state_payload ? 'plan' AS has_plan,
              EXISTS (
                SELECT 1
                  FROM agentos.run_stage_results AS result
                 WHERE result.tenant_id = durable.tenant_id
                   AND result.run_id = durable.run_id
                   AND result.stage = 'PLAN'
                   AND result.status = 'completed'
              ) AS plan_completed
         FROM agentos.platform_durable_tasks AS durable
        WHERE durable.tenant_id = $1 AND durable.run_id = $2`,
      [tenantId, taskId],
    );
    lastState = task?.state ?? 'missing';
    if (task?.state === 'running' && task.has_plan === true && task.plan_completed === true) return;
    if (task === undefined || ['completed', 'failed', 'stopped', 'awaiting_human'].includes(task.state)) break;
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`worker did not expose a running PLAN checkpoint for ${taskId}; last state=${lastState}`);
}

async function stageResults(taskId) {
  const { tenantId } = readStackState();
  const runId = await taskRunId(taskId);
  return sql(
    `SELECT stage, status, refusal_code
       FROM agentos.run_stage_results
      WHERE tenant_id = $1 AND run_id = $2
      ORDER BY started_at, step_index, stage`,
    [tenantId, runId],
  );
}

async function apiReadiness() {
  const { apiUrl } = readStackState();
  const response = await fetch(new URL('/ready', apiUrl), { signal: AbortSignal.timeout(READINESS_REQUEST_TIMEOUT_MS) });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Keep the HTTP status useful when the process is between restarts.
  }
  return { response, body };
}

async function waitForReady(timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const result = await apiReadiness();
      last = `HTTP ${result.response.status} ${JSON.stringify(result.body)}`;
      if (result.response.status === 200 && result.body?.status === 'ready') return result;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(500);
  }
  throw new Error(`API did not become ready: ${last}`);
}

async function waitForDependencyFailure(dependency, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    try {
      const result = await apiReadiness();
      last = `HTTP ${result.response.status} ${JSON.stringify(result.body)}`;
      if (
        result.response.status === 503
        && result.body?.status === 'not_ready'
        && result.body.failures?.some((failure) => failure.dependency === dependency)
      ) return result;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await sleep(250);
  }
  throw new Error(`API readiness did not report ${dependency} unavailable: ${last}`);
}

async function storefrontRequest(widget, message) {
  const response = await fetch(`${apiV1Url()}/storefront/stream`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${widget.access_token}`,
      origin: widget.origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message, module: 'sales', idempotency_key: randomUUID() }),
    signal: AbortSignal.timeout(STOREFRONT_REQUEST_TIMEOUT_MS),
  });
  let body = null;
  if (response.headers.get('content-type')?.includes('text/plain') && response.body) {
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
    try {
      body = JSON.parse(firstLine.split(/\r?\n/, 1)[0]);
    } catch {
      // Keep the status if the stream does not begin with a JSON receipt.
    }
  } else {
    try {
      body = await response.json();
    } catch {
      // Fault scenarios expect a typed refusal; retain status if the server returns a non-JSON body.
    }
  }
  return { response, body };
}

async function orderCount() {
  const { tenantId } = readStackState();
  const [row] = await sql(
    'SELECT count(*)::int AS count FROM agentos.orders WHERE tenant_id = $1',
    [tenantId],
  );
  return row?.count ?? 0;
}

test('worker resumes its persisted PLAN checkpoint after restart without duplicating effects', async () => {
  const { tenantId } = readStackState();
  let workerNeedsRestart = false;
  try {
    const ordersBefore = await orderCount();
    const widget = await mintWidget('C05');
    const message = 'What is the price and availability for NM-L01-BLK?';
    await mockErpControl({ ...DEFAULT_ERP_CONTROL, latency_ms: 3_000 });
    const receipt = await turn(widget, message);
    await waitForPersistedPlan(receipt.task_id);
    workerNeedsRestart = true;
    await controlStackService('kill', 'worker');
    await controlStackService('up', 'worker');
    workerNeedsRestart = false;

    const task = await waitTask(receipt.task_id, TASK_TERMINAL_STATES);
    assert.equal(task.status, 'completed');
    assert.ok(typeof task.answer === 'string' && task.answer.trim().length > 0);
    // This recovery intentionally runs with a different ERP latency from a normal run and may
    // re-read price after restart, so answer equality is not a stable invariant here.
    const conversationMessages = await messages(widget.operatorToken, receipt.conversation_id);
    const agentMessages = conversationMessages.filter((message) => message.sender_type === 'agent');
    assert.equal(agentMessages.length, 1, 'resuming after a crash must not append a duplicate answer');
    assert.equal(agentMessages[0]?.content, task.answer);

    const runId = await taskRunId(receipt.task_id);
    const [effects] = await sql(
      `SELECT count(*)::int AS total,
              count(DISTINCT (request_id, skill_id, step_index))::int AS distinct_effects
         FROM agentos.effect_reservations
        WHERE tenant_id = $1 AND run_id = $2`,
      [tenantId, runId],
    );
    assert.ok(effects?.total > 0, 'the run should have durable effect reservations');
    assert.equal(effects?.total, effects?.distinct_effects, 'a resumed run must not reserve an effect twice');
    assert.equal(await orderCount(), ordersBefore, 'a read-only Sales recovery must not create duplicate ERP orders');
  } finally {
    await mockErpControl(DEFAULT_ERP_CONTROL);
    if (workerNeedsRestart) await controlStackService('up', 'worker');
  }
});

test('ERP latency beyond the adapter deadline is refused authoritatively and recovers when latency is cleared', async () => {
  try {
    const { erpTimeoutMs } = readStackState();
    await mockErpControl({ ...DEFAULT_ERP_CONTROL, latency_ms: erpTimeoutMs + 1_000 });
    const widget = await mintWidget('C06');
    const receipt = await turn(widget, 'NM-L01-BLK còn hàng không, giá bao nhiêu?');
    const task = await waitTask(receipt.task_id, TERMINAL_STATES);
    assert.equal(task.status, 'completed');
    assert.ok(typeof task.answer === 'string' && task.answer.trim().length > 0);
    assertAuthoritativeRefusalWithoutPrice(await stageResults(receipt.task_id), task.answer, 'ERP latency');

    await mockErpControl(DEFAULT_ERP_CONTROL);
    const recoveredWidget = await mintWidget('C06');
    const recoveredReceipt = await turn(recoveredWidget, 'NM-L01-BLK còn hàng không, giá bao nhiêu?');
    const recovered = await waitTask(recoveredReceipt.task_id, TASK_TERMINAL_STATES);
    assert.equal(recovered.status, 'completed');
    assert.ok(typeof recovered.answer === 'string' && recovered.answer.trim().length > 0);
    assert.ok(
      !(await stageResults(recoveredReceipt.task_id)).some((stage) => Object.hasOwn(ERP_REFUSAL_CODES, stage.refusal_code)),
      'recovered Sales turn must not retain an ERP timeout refusal',
    );
  } finally {
    await mockErpControl(DEFAULT_ERP_CONTROL);
  }
});

test('ERP outage is visible to readiness, Sales refuses without authoritative data, and recovers after ERP starts', async () => {
  let erpStopped = false;
  try {
    erpStopped = true;
    await controlStackService('stop', 'mock-erp');
    const readiness = await waitForDependencyFailure('sor');
    assert.equal(readiness.body?.failures?.some((failure) => failure.dependency === 'sor'), true);

    const widget = await mintWidget('C06');
    const receipt = await turn(widget, 'NM-L01-BLK còn hàng không, giá bao nhiêu?');
    const task = await waitTask(receipt.task_id, TERMINAL_STATES);
    assert.equal(task.status, 'completed');
    assert.ok(typeof task.answer === 'string' && task.answer.trim().length > 0);
    assertAuthoritativeRefusalWithoutPrice(await stageResults(receipt.task_id), task.answer, 'ERP outage');

    await controlStackService('start', 'mock-erp');
    erpStopped = false;
    await waitForReady();
    const recoveredWidget = await mintWidget('C06');
    const recoveredReceipt = await turn(recoveredWidget, 'NM-L01-BLK còn hàng không, giá bao nhiêu?');
    const recovered = await waitTask(recoveredReceipt.task_id, TERMINAL_STATES);
    assert.equal(recovered.status, 'completed');
    assert.ok(typeof recovered.answer === 'string' && recovered.answer.trim().length > 0);
    assert.ok(
      !(await stageResults(recoveredReceipt.task_id)).some((stage) => Object.hasOwn(ERP_REFUSAL_CODES, stage.refusal_code)),
      'Sales must return to an authoritative result after ERP recovery',
    );
  } finally {
    if (erpStopped) await controlStackService('start', 'mock-erp');
  }
});

test('LLM 5xx, timeout, and invalid JSON faults produce bounded, typed refusals', async (t) => {
  const cases = [
    { mode: '500', times: 4, remaining: 1, errorCode: 'PROVIDER_TIMEOUT' },
    { mode: 'timeout', times: 3, remaining: 2, errorCode: 'PROVIDER_TIMEOUT' },
    { mode: 'invalid_json', times: 3, remaining: 2, errorCode: 'PROVIDER_REJECTED' },
  ];

  for (const scenario of cases) {
    await t.test(scenario.mode, { timeout: 90_000 }, async () => {
      await llmStubControl({ faults: [] });
      const widget = await mintWidget('C06');
      const message = `chaos LLM ${scenario.mode} ${randomUUID()}`;
      try {
        await llmStubControl({
          faults: [{ match: { kind: 'intent', contains: message }, mode: scenario.mode, times: scenario.times }],
        });
        const { response, body } = await storefrontRequest(widget, message);
        if (scenario.mode === 'invalid_json') {
          assert.equal(response.status, 200, 'a Sales turn with invalid classifier JSON must be admitted');
          assert.equal(typeof body?.task_id, 'string', `Sales receipt omitted task_id: ${JSON.stringify(body)}`);
          const task = await waitTask(body.task_id, TERMINAL_STATES);
          assert.equal(task.status, 'completed', `invalid-JSON run ended ${task.status}: ${JSON.stringify(task.error)}`);
          const [savedResponse] = await sql(
            'SELECT response_kind FROM agentos.run_responses WHERE tenant_id = $1 AND run_id = $2',
            [readStackState().tenantId, body.task_id],
          );
          assert.equal(savedResponse?.response_kind, 'REFUSAL');

          const company = await login('company');
          const story = await requestApi(`runs/${encodeURIComponent(body.task_id)}/story`, { token: company.access_token });
          assert.equal(story.response.status, 200);
          assert.match(JSON.stringify(story.body), /PROVIDER_REJECTED|LLM_INVALID_RESPONSE|INVALID_JSON|invalid JSON|unusable response/i,
            'run story did not expose the provider JSON failure reason');
        } else {
          assert.notEqual(response.status, 200, 'provider failures must not admit a turn');
          assert.equal(body?.error_code, scenario.errorCode, `unexpected refusal body: ${JSON.stringify(body)}`);
        }
        const faultState = await llmStubControl({ readOnly: true });
        assert.equal(faultState[0]?.remaining, scenario.remaining, 'provider attempts must stay within the configured bound');
      } finally {
        await llmStubControl({ faults: [] });
      }
    });
  }
});

test('Redis loss fails takeover closed without claiming the conversation, then takeover recovers', async () => {
  const company = await login('company');
  const widget = await mintWidget('anonymous');
  const receipt = await turn(widget, 'I want to speak to a person');
  const escalated = await waitTask(receipt.task_id, TERMINAL_STATES);
  assert.equal(escalated.status, 'awaiting_human');

  const { tenantId } = readStackState();
  const [before] = await sql(
    `SELECT state, takeover_operator_id
       FROM agentos.conversations
      WHERE tenant_id = $1 AND id = $2::uuid`,
    [tenantId, receipt.conversation_id],
  );
  assert.ok(before, 'handoff conversation must exist before takeover');
  assert.equal(before.takeover_operator_id, null, 'queued handoff must not already have an operator owner');

  let redisStopped = false;
  try {
    redisStopped = true;
    await controlStackService('stop', 'redis');
    await waitForDependencyFailure('redis');
    const takeover = await requestApi(`conversations/${encodeURIComponent(receipt.conversation_id)}/takeover`, {
      method: 'POST',
      token: company.access_token,
      body: { reason: 'chaos Redis outage', takeover_mode: 'FULL_CONTROL' },
    });
    assert.equal(takeover.response.status, 503, 'takeover must fail closed with a typed dependency refusal while Redis is unavailable');
    assert.equal(takeover.body?.error_code, 'CAPABILITY_UNAVAILABLE');
    assert.equal(takeover.body?.retryable, true);
    assert.match(takeover.body?.message ?? '', /tạm thời không khả dụng/i);

    const [conversation] = await sql(
      `SELECT state, takeover_operator_id
         FROM agentos.conversations
        WHERE tenant_id = $1 AND id = $2::uuid`,
      [tenantId, receipt.conversation_id],
    );
    assert.equal(conversation?.state, before.state, 'failed lease acquisition must not change conversation state');
    assert.equal(
      conversation?.takeover_operator_id,
      before.takeover_operator_id,
      'failed lease acquisition must not assign or replace an owner',
    );

    await controlStackService('start', 'redis');
    redisStopped = false;
    await waitForReady();
    const recoveryDeadline = Date.now() + 30_000;
    let recovered;
    while (Date.now() < recoveryDeadline) {
      const attempt = await requestApi(`conversations/${encodeURIComponent(receipt.conversation_id)}/takeover`, {
        method: 'POST',
        token: company.access_token,
        body: { reason: 'chaos Redis recovered', takeover_mode: 'FULL_CONTROL' },
      });
      if (attempt.response.status === 200) {
        recovered = attempt;
        break;
      }
      assert.equal(attempt.response.status, 503, `recovery refusal returned HTTP ${attempt.response.status}`);
      assert.equal(attempt.body?.error_code, 'CAPABILITY_UNAVAILABLE',
        `recovery refusal was not the typed Redis dependency error: ${JSON.stringify(attempt.body)}`);
      assert.equal(attempt.body?.retryable, true, 'Redis recovery refusal must be retryable');
      assert.match(attempt.body?.message ?? '', /tạm thời không khả dụng/i);
      await sleep(250);
    }
    assert.equal(recovered?.response.status, 200, 'recovered takeover did not succeed within 30 seconds');
    assert.equal(recovered.body?.status, 'HUMAN_TAKEOVER');
  } finally {
    if (redisStopped) await controlStackService('start', 'redis');
  }
});

test('Postgres restart restores API readiness and a new Sales turn completes', async () => {
  await controlStackService('restart', 'postgres');
  await waitForReady();
  const widget = await mintWidget('C06');
  const receipt = await turn(widget, 'NM-L01-BLK còn hàng không, giá bao nhiêu?');
  const task = await waitTask(receipt.task_id, TASK_TERMINAL_STATES);
  assert.equal(task.status, 'completed');
  assert.ok(typeof task.answer === 'string' && task.answer.trim().length > 0);
});

test('database-backed auth session survives API restart', async (t) => {
  if ((process.env.AUTH_PROVIDER ?? 'demo').trim().toLowerCase() !== 'db') {
    t.skip('AUTH_PROVIDER is not db; database-backed session persistence is not enabled in this stack');
    return;
  }
  const signedIn = await login('company', { authProvider: 'db' });
  assert.equal(typeof signedIn.identity?.user_id, 'string');
  const token = signedIn.access_token;
  const before = await requestApi('auth/session', { token });
  assert.equal(before.response.status, 200);

  await controlStackService('restart', 'api');
  try {
    await waitForReady();
    const after = await requestApi('auth/session', { token });
    assert.equal(after.response.status, 200, `DB session did not survive API restart (HTTP ${after.response.status})`);
    assert.equal(after.body?.identity?.user_id, signedIn.identity.user_id);
  } finally {
    await waitForReady();
  }
});
