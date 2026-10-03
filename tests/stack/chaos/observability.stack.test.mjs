import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { login, requestApi, turn, waitTask } from '../lib/api.mjs';
import { sql } from '../lib/db.mjs';
import { controlStackService, readStackState } from '../lib/stack.mjs';
import { mintWidget } from '../lib/widget.mjs';

const TERMINAL_STATES = ['awaiting_human', 'completed', 'failed', 'stopped'];
const STAGE_STATUSES = new Set(['completed', 'failed', 'refused', 'awaiting_human']);
const WORKER_FAILURE_TIMEOUT_MS = 90_000;

function skipWithoutCredentials(t, ...audiences) {
  const dbAuth = (process.env.STACK_AUTH_PROVIDER ?? 'demo').trim().toLowerCase() === 'db';
  for (const audience of audiences) {
    const prefix = audience === 'company' ? 'DEMO_COMPANY_ADMIN' : 'DEMO_PLATFORM_ADMIN';
    const credentials = dbAuth
      ? readStackState().auth?.[audience]
      : { email: process.env[`${prefix}_EMAIL`], password: process.env[`${prefix}_PASSWORD`] };
    if (!credentials?.email || !credentials?.password) {
      t.skip(`the stack ${audience} login credentials are unavailable`);
      return true;
    }
  }
  return false;
}

async function readRunTrace(token, runId) {
  const { tenantId } = readStackState();
  const path = `platform/companies/${encodeURIComponent(tenantId)}/runs/${encodeURIComponent(runId)}`;
  const detail = await requestApi(path, { token });
  assert.equal(detail.response.status, 200, `run detail returned HTTP ${detail.response.status}`);
  assert.equal(detail.body?.run_id, runId);
  assert.equal(detail.body?.domain, 'sales');
  assert.equal(detail.body?.state, 'completed');
  const trace = await requestApi(`${path}/trace`, { token });
  assert.equal(trace.response.status, 200, `run trace returned HTTP ${trace.response.status}`);
  assert.equal(trace.body?.run_id, runId);
  assert.ok(Array.isArray(trace.body?.stages), 'run trace must expose persisted stage results');
  return { detail: detail.body, trace: trace.body };
}

function assertNoCustomerPii(value, email, phone, surface) {
  const serialized = JSON.stringify(value);
  assert.equal(typeof serialized, 'string', `${surface} must return JSON`);
  assert.equal(serialized.includes(email), false, `${surface} leaked the TEST customer's email`);
  assert.equal(serialized.includes(phone), false, `${surface} leaked the TEST customer's phone`);
  assert.equal(serialized.includes(phone.slice(1)), false, `${surface} leaked the normalized TEST phone`);
}

async function waitForWorkerState(token, expectedState, timeoutMs = WORKER_FAILURE_TIMEOUT_MS) {
  const started = performance.now();
  let lastState = 'no response';
  while (performance.now() - started < timeoutMs) {
    const { response, body } = await requestApi('platform/health', { token });
    assert.equal(response.status, 200, `platform health returned HTTP ${response.status}`);
    const workers = body?.probes?.workers;
    assert.ok(Array.isArray(workers?.items), 'platform health must expose worker heartbeats');
    lastState = workers.state;
    if (lastState === expectedState) {
      assert.ok(performance.now() - started <= timeoutMs, `worker state exceeded ${timeoutMs}ms`);
      return workers;
    }
    await sleep(Math.min(1_000, Math.max(1, timeoutMs - (performance.now() - started))));
  }
  assert.fail(`worker did not become ${expectedState} within ${timeoutMs}ms; last state=${lastState}`);
}

async function waitForReadiness({ schemaBehind = false, timeoutMs = 180_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    let response;
    let body;
    try {
      response = await fetch(new URL('/ready', readStackState().apiUrl), {
        signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - Date.now()))),
      });
      body = await response.json();
    } catch {
      // A restarting process may close the connection before it can return JSON.
      last = 'connection unavailable';
      await sleep(500);
      continue;
    }
    last = `HTTP ${response.status}, status=${body?.status}`;
    if (schemaBehind) {
      if (response.status === 503 && body?.status === 'not_ready'
        && body.failures?.some((failure) => failure.dependency === 'schema' && failure.reason === 'SCHEMA_BEHIND')) {
        return { response, body };
      }
    } else if (response.status === 200 && body?.status === 'ready') {
      return { response, body };
    }
    await sleep(500);
  }
  assert.fail(`API did not report ${schemaBehind ? 'SCHEMA_BEHIND' : 'ready'}: ${last}`);
}

test('T5.1 completed Sales trace has a timed result for every entered stage', async (t) => {
  if (skipWithoutCredentials(t, 'company', 'platform')) return;
  const platform = await login('platform');
  const widget = await mintWidget('C06');
  const receipt = await turn(widget, 'NM-L01-BLK còn hàng không, giá bao nhiêu?');
  const task = await waitTask(receipt.task_id, TERMINAL_STATES);
  assert.equal(task.status, 'completed');
  const { detail, trace } = await readRunTrace(platform.access_token, receipt.task_id);

  // The platform trace deliberately omits raw entry rows and step/attempt identifiers.
  // Compare its results with the immutable entry ledger, including repeated stage occurrences.
  const entries = await sql(
    `SELECT stage, entered_at
       FROM agentos.run_stage_events
      WHERE tenant_id = $1 AND run_id = $2
      ORDER BY attempt_ordinal, entered_at, step_index, stage`,
    [readStackState().tenantId, receipt.task_id],
  );
  assert.ok(entries.some((entry) => entry.stage === 'SIGNAL'), 'Sales must enter SIGNAL');
  assert.ok(entries.some((entry) => entry.stage === 'PLAN'), 'Sales must enter PLAN');
  assert.equal(detail.stage_event_count, entries.length);
  const remainingResults = new Map();
  let stageDurationMs = 0;
  for (const result of trace.stages) {
    assert.ok(STAGE_STATUSES.has(result.status), `${result.stage} has no terminal stage status`);
    assert.ok(Number.isSafeInteger(result.duration_ms) && result.duration_ms >= 0,
      `${result.stage} has no nonnegative duration`);
    const startedAt = Date.parse(result.started_at);
    const completedAt = Date.parse(result.completed_at);
    assert.ok(Number.isFinite(startedAt) && Number.isFinite(completedAt) && completedAt >= startedAt,
      `${result.stage} has invalid stage timestamps`);
    const key = JSON.stringify([result.stage, startedAt]);
    remainingResults.set(key, (remainingResults.get(key) ?? 0) + 1);
    stageDurationMs += result.duration_ms;
  }
  for (const entry of entries) {
    const key = JSON.stringify([entry.stage, new Date(entry.entered_at).getTime()]);
    const count = remainingResults.get(key) ?? 0;
    assert.ok(count > 0, `${entry.stage} entry is missing its corresponding result`);
    remainingResults.set(key, count - 1);
  }
  assert.ok([...remainingResults.values()].every((count) => count === 0), 'trace contains unentered stage results');
  assert.ok(Number.isSafeInteger(detail.duration_ms) && detail.duration_ms > 0, 'run duration must be positive');
  assert.equal(trace.duration_ms, detail.duration_ms);
  assert.ok(stageDurationMs > 0, 'completed stages must record elapsed time');
  assert.ok(stageDurationMs <= detail.duration_ms,
    `stage durations (${stageDurationMs}ms) exceed total run duration (${detail.duration_ms}ms)`);
});

test('T5.2 verified TEST customer email and phone stay out of audit JSON and run trace', async (t) => {
  if (skipWithoutCredentials(t, 'company', 'platform')) return;
  const company = await login('company');
  const platform = await login('platform');
  const origin = (process.env.DEMO_WIDGET_ORIGINS ?? 'http://localhost:3000').split(',')[0]?.trim();
  if (!origin) {
    t.skip('the stack widget origin is unavailable');
    return;
  }
  const email = `audit-${randomUUID()}@example.invalid`;
  const phone = `+849${randomInt(10_000_000, 100_000_000)}`;
  let customerId;
  try {
    const created = await requestApi('testing/customers', {
      method: 'POST',
      token: company.access_token,
      body: {
        display_name: `Stack audit privacy ${randomUUID()}`,
        primary_email: email,
        primary_phone: phone,
        identities: [
          { channel_type: 'email', channel_identifier: email, is_primary: true },
          { channel_type: 'phone', channel_identifier: phone },
        ],
      },
    });
    customerId = created.body?.customer?.id;
    assert.equal(created.response.status, 201, `TEST customer creation returned HTTP ${created.response.status}`);
    assert.equal(typeof customerId, 'string');
    const customer = created.body.customer;
    assert.equal(customer.data_class, 'TEST');
    assert.equal(customer.verification_status, 'verified');
    for (const identifier of [email, phone]) {
      assert.ok(customer.identities?.some((identity) => identity.channel_identifier === identifier && identity.verified === true),
        'the TEST fixture must have verified email and phone identities');
    }
    const session = await requestApi(`testing/customers/${encodeURIComponent(customerId)}/widget-session`, {
      method: 'POST', token: company.access_token, body: { origin },
    });
    assert.equal(session.response.status, 201, `TEST widget session returned HTTP ${session.response.status}`);
    assert.equal(session.body?.customer_id, customerId);
    const receipt = await turn({ ...session.body, origin }, 'NM-L01-BLK còn hàng không, giá bao nhiêu?');
    const task = await waitTask(receipt.task_id, TERMINAL_STATES);
    assert.equal(task.status, 'completed');
    const { detail, trace } = await readRunTrace(platform.access_token, receipt.task_id);
    assert.ok(trace.stages.some((stage) => stage.stage === 'CONTEXT' && stage.detail?.customer_verified === true),
      'the Sales run must hydrate the verified customer rather than execute anonymously');

    const { tenantId } = readStackState();
    const companyAudit = await requestApi('company/audit?limit=200', { token: company.access_token });
    const platformAudit = await requestApi(`platform/audit?${new URLSearchParams({ tenant_id: tenantId, limit: '200' })}`, {
      token: platform.access_token,
    });
    for (const [surface, result] of [['company audit', companyAudit], ['platform audit', platformAudit]]) {
      assert.equal(result.response.status, 200, `${surface} returned HTTP ${result.response.status}`);
      assert.ok(Array.isArray(result.body?.items), `${surface} must return an audit page`);
      assertNoCustomerPii(result.body, email, phone, surface);
    }
    assertNoCustomerPii(detail, email, phone, 'run detail');
    assertNoCustomerPii(trace, email, phone, 'run trace');

    // API allowlists alone cannot prove that the immutable backing ledgers were redacted.
    const records = await sql(
      `SELECT 'audit_records' AS ledger, to_jsonb(audit) AS record
         FROM agentos.audit_records AS audit
        WHERE tenant_id = $1 AND run_id = $2
       UNION ALL
       SELECT 'agent_run_logs' AS ledger, to_jsonb(log) AS record
         FROM agentos.agent_run_logs AS log
        WHERE tenant_id = $1 AND run_id = $2`,
      [tenantId, receipt.task_id],
    );
    for (const ledger of ['audit_records', 'agent_run_logs']) {
      assert.ok(records.some((row) => row.ledger === ledger && row.record.skill === 'skill.sales.check_price'),
        `${ledger} must contain this Sales turn's price-check audit, not an empty privacy check`);
    }
    const auditIds = records.filter((row) => row.ledger === 'audit_records').map((row) => row.record.id);
    assert.deepEqual(trace.audit_entries.map((entry) => entry.audit_ref).sort(), auditIds.sort(),
      'the trace must reference the audit rows belonging to this run');
    assertNoCustomerPii(records, email, phone, 'persisted run audit ledgers');
  } finally {
    if (typeof customerId === 'string') {
      const removed = await requestApi(`testing/customers/${encodeURIComponent(customerId)}`, {
        method: 'DELETE', token: company.access_token,
      });
      assert.equal(removed.response.status, 200, `TEST fixture cleanup returned HTTP ${removed.response.status}`);
      assert.equal(removed.body?.deleted, true);
    }
  }
});

test('T8.6 platform health reports a stopped worker as FAILED within 90 seconds and recovers', async (t) => {
  if (skipWithoutCredentials(t, 'platform')) return;
  const platform = await login('platform');
  const healthy = await waitForWorkerState(platform.access_token, 'HEALTHY');
  assert.ok(healthy.items.some((worker) => worker.age_seconds !== null && worker.age_seconds <= 60),
    'the baseline must contain a live worker heartbeat');
  try {
    const stoppedAt = performance.now();
    await controlStackService('stop', 'worker');
    const remainingMs = WORKER_FAILURE_TIMEOUT_MS - (performance.now() - stoppedAt);
    assert.ok(remainingMs > 0, 'stopping the worker exhausted the health detection deadline');
    const failed = await waitForWorkerState(platform.access_token, 'FAILED', remainingMs);
    assert.ok(failed.items.length === 0 || failed.items.some((worker) => worker.age_seconds > 60),
      'worker failure must reflect absent or stale heartbeats');
  } finally {
    await controlStackService('start', 'worker');
    await waitForWorkerState(platform.access_token, 'HEALTHY');
  }
});

test('T0.5 API restart reports SCHEMA_BEHIND until the newest migration ledger row is restored', async () => {
  await waitForReadiness();
  // sql() deliberately opens READ ONLY transactions. This narrowly scoped fault uses the same
  // stack-owned connection and installed pg dependency, never altering a migration's actual DDL.
  const requireDatabase = createRequire(new URL('../../../packages/database/package.json', import.meta.url));
  const { Client } = requireDatabase('pg');
  const client = new Client({
    connectionString: readStackState().superDatabaseUrl,
    connectionTimeoutMillis: 10_000,
    query_timeout: 15_000,
    statement_timeout: 15_000,
  });
  await client.connect();
  let original;
  try {
    const saved = await client.query(
      `SELECT to_jsonb(ledger) AS record
         FROM agentos_meta.schema_migrations AS ledger
        ORDER BY filename DESC LIMIT 1`,
    );
    original = saved.rows[0]?.record;
    assert.equal(typeof original?.filename, 'string', 'the stack migration ledger must have an applied migration');
    assert.match(original.filename, /^\d+_[A-Za-z0-9_]+\.sql$/);
    const removed = await client.query(
      `DELETE FROM agentos_meta.schema_migrations AS ledger
        WHERE filename = $1 AND to_jsonb(ledger) = $2::jsonb
        RETURNING filename`,
      [original.filename, JSON.stringify(original)],
    );
    assert.equal(removed.rowCount, 1, 'only the saved, unchanged migration ledger row may be removed');
    await controlStackService('restart', 'api');
    const unavailable = await waitForReadiness({ schemaBehind: true });
    assert.equal(unavailable.response.status, 503);
    assert.ok(unavailable.body.failures.some((failure) => failure.dependency === 'schema' && failure.reason === 'SCHEMA_BEHIND'));
  } finally {
    try {
      if (original !== undefined) {
        // Preserve every column (including timestamp precision); never overwrite a changed row.
        await client.query(
          `INSERT INTO agentos_meta.schema_migrations
           SELECT * FROM jsonb_populate_record(NULL::agentos_meta.schema_migrations, $1::jsonb)
           ON CONFLICT (filename) DO NOTHING`,
          [JSON.stringify(original)],
        );
        const restored = await client.query(
          'SELECT to_jsonb(ledger) AS record FROM agentos_meta.schema_migrations AS ledger WHERE filename = $1',
          [original.filename],
        );
        assert.deepEqual(restored.rows[0]?.record, original, 'migration ledger restoration must be lossless');
      }
    } finally {
      try {
        await controlStackService('restart', 'api');
        await waitForReadiness();
      } finally {
        await client.end();
      }
    }
  }
});
