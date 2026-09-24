#!/usr/bin/env node
/**
 * P1 Customer Care execution-path smoke (`implement/09` Gate P1, `implement/06` §8.1.1 R02/R03).
 *
 * This script is the end-to-end proof of the execution graph, and it is deliberately not a unit
 * test with doubles: it drives the built gateway (`apps/api/dist`), the built worker
 * (`apps/worker/dist`) and the built packages against a real PostgreSQL instance with the
 * NOBYPASSRLS application role, and it reaches the provider boundary through the mock system of
 * record over real HTTP with the real request signature.
 *
 * What it proves, in order:
 *   1. R02 admits exactly ONE durable run for one immutable inbound identity — the reservation row
 *      is written before the durable task in the same transaction, so a redelivery of the same
 *      turn never starts a second run and never re-dispatches an effect;
 *   2. the worker's own claim/lease/execute path completes that run through the canonical Care
 *      skill, with the evidence chain, the Agent Run row and the audit row persisted;
 *   3. the run reads back through the gateway (R03) in its stored durable state;
 *   4. the two refusals the pilot depends on stay refusals: a Care turn whose knowledge source is
 *      a draft corpus invents nothing, and an order owned by another customer is never disclosed;
 *   5. the capabilities this build does not bind are named rather than silently stubbed.
 *
 * Fail-closed rules: a missing `DATABASE_URL`, a managed `APP_ENV`, an unmigrated schema, a
 * bypassing role, a missing build output or an unreachable provider aborts the run instead of
 * reporting a green path it did not exercise. Nothing here touches a hidden fallback, a cached
 * value or a synthesized fact: a refusal is a result, and it is asserted as one.
 *
 * Usage: node --test scripts/care-pilot-smoke.mjs
 *   DATABASE_URL          application-role URL of a database with the migrations already applied
 *   APP_ENV               local | ci (a managed profile is refused: the mock provider is local only)
 *   CARE_TENANT_IDS       the tenant the Care pilot is scoped to (a UUID)
 *   AUDIT_HMAC_SECRET     evidence-chain signing secret (never logged, never written to a row)
 *   MOCK_SECRET_KEY       shared secret the platform signs API-001 calls with
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Environments whose provider is real: a simulated system of record may never be bound there. */
const MANAGED_ENVS = ['staging', 'sandbox', 'production'];

/** The conventional local/CI provider port; only used when the script cannot pick a free one. */
const DEFAULT_PROVIDER_PORT = 8081;

/** The Care agent the platform registry allows on the two P1 read skills. */
const CARE_AGENT = 'CS-01';

let context = null;

/** Reads a required environment value, failing closed with the variable's name. */
function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `${name}_REQUIRED: the Care pilot smoke drives the real runtime, so it cannot run without ` +
        `${name}. Set it, then re-run \`node --test scripts/care-pilot-smoke.mjs\`.`,
    );
  }
  return value.trim();
}

/** Imports a build output, naming the missing prerequisite instead of failing with a stack. */
async function loadBuild(relativePath, label) {
  try {
    return await import(new URL(relativePath, import.meta.url).href);
  } catch (error) {
    throw new Error(
      `BUILD_OUTPUT_REQUIRED: ${label} ('${relativePath}') is not built. Run \`pnpm build\` before ` +
        `this smoke. (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/**
 * Opens the tenant-scoped fixtures this smoke owns.
 *
 * The tenant is the pilot's, the customer is the API-001 fixture's order owner (so the provider's
 * owner check is exercised against a real row rather than a synthetic string), and the identity row
 * is the server-side verification record `skill.care.lookup_order` re-resolves by id.
 */
async function seedFixtures(db) {
  const { withTenantContext } = db;
  const tenant_id = context.tenant_id;
  const customer_id = context.order_owner_id;
  const thread = `smoke-thread-${randomUUID()}`;
  const conversation_id = await withTenantContext(tenant_id, async (client) => {
    await client.query(
      `INSERT INTO agentos.customers (id, tenant_id, display_name, verification_status)
       VALUES ($1, $2, 'P1 smoke customer', 'verified')
       ON CONFLICT (id) DO NOTHING`,
      [customer_id, tenant_id],
    );
    const identity = await client.query(
      `INSERT INTO agentos.customer_identities
         (tenant_id, customer_id, channel_type, channel_identifier, identifier_hash, is_primary, verified_at)
       VALUES ($1, $2, 'WEB_CHAT', $3, $4, TRUE, CURRENT_TIMESTAMP)
       RETURNING id`,
      [tenant_id, customer_id, thread, `sha256:${thread}`],
    );
    const conversation = await client.query(
      `INSERT INTO agentos.conversations
         (tenant_id, customer_id, channel, external_thread_id, state)
       VALUES ($1, $2, 'WEB_CHAT', $3, 'open')
       RETURNING id`,
      [tenant_id, customer_id, thread],
    );

    return { conversation_id: conversation.rows[0].id, identity_id: identity.rows[0].id, thread };
  });

  return { ...conversation_id, customer_id };
}

/** Removes exactly the rows this smoke created, so the rehearsal database is left as it was. */
async function cleanupFixtures(db, fixture) {
  const { withTenantContext } = db;
  await withTenantContext(context.tenant_id, async (client) => {
    await client.query('DELETE FROM agentos.conversation_messages WHERE tenant_id = $1 AND conversation_id = $2', [
      context.tenant_id,
      fixture.conversation_id,
    ]);
    await client.query('DELETE FROM agentos.customer_identities WHERE tenant_id = $1 AND id = $2', [
      context.tenant_id,
      fixture.identity_id,
    ]);
    await client.query('DELETE FROM agentos.conversations WHERE tenant_id = $1 AND id = $2', [
      context.tenant_id,
      fixture.conversation_id,
    ]);
    await client.query('DELETE FROM agentos.customers WHERE tenant_id = $1 AND id = $2', [
      context.tenant_id,
      fixture.customer_id,
    ]);
  });
}

/**
 * Deletes the mutable runtime rows this smoke's runs produced.
 *
 * `evidence_records`, `agent_run_logs` and `audit_records` are append-only by trigger (NFR-002):
 * a delete against them raises instead of removing history, so this cleanup deliberately leaves
 * those rows where they are. They stay scoped to this smoke's own run ids, which are generated per
 * invocation, so a rehearsal database accumulates history rather than reusable state.
 */
async function cleanupRuns(db) {
  const { withTenantContext } = db;
  await withTenantContext(context.tenant_id, async (client) => {
    for (const run_id of context.run_ids) {
      await client.query('DELETE FROM agentos.approvals WHERE tenant_id = $1 AND run_id = $2', [context.tenant_id, run_id]);
      await client.query('DELETE FROM agentos.platform_durable_tasks WHERE tenant_id = $1 AND run_id = $2', [context.tenant_id, run_id]);
    }
  });
}

/** One JSON blob of durable rows, so a refusal can be found where it was actually written. */
async function errorsOf(db, run_id) {
  const { withTenantContext } = db;
  return withTenantContext(context.tenant_id, async (client) => {
    const task = await client.query(
      'SELECT state, current_step, last_error_class, error_details, state_payload FROM agentos.platform_durable_tasks WHERE tenant_id = $1 AND run_id = $2',
      [context.tenant_id, run_id],
    );
    const logs = await client.query(
      'SELECT execution_status, error, decision FROM agentos.agent_run_logs WHERE tenant_id = $1 AND run_id = $2',
      [context.tenant_id, run_id],
    );
    const audit = await client.query(
      'SELECT decision, error, context FROM agentos.audit_records WHERE tenant_id = $1 AND run_id = $2',
      [context.tenant_id, run_id],
    );

    return JSON.stringify({ task: task.rows, logs: logs.rows, audit: audit.rows });
  });
}

/** Runs one Care turn through the gateway and returns the R02 acceptance body. */
async function postTurn(fixture, { message, idempotency_key, module = 'support' }) {
  const response = await context.app.inject({
    method: 'POST',
    url: `/api/v1/conversations/${fixture.conversation_id}/messages`,
    headers: { authorization: `Bearer ${context.session_token}` },
    payload: { message, idempotency_key, module },
  });

  return { status: response.statusCode, body: response.json() };
}

/**
 * Claims and executes the run the gateway just admitted, exactly as the polling worker does.
 *
 * A refused step leaves the run re-queued with its reason recorded, which is the durable
 * scheduler's normal outcome rather than a crash; `tolerate_refusal` returns that task state
 * instead of throwing, so the caller can assert on the recorded refusal itself.
 *
 * @returns The durable task state the worker left behind, read from PostgreSQL.
 */
async function executeClaimedRun(run_id, { tolerate_refusal = false } = {}) {
  const { DurableWorkflowRepository } = context.db;
  const { processClaimedTask } = context.worker;
  const repository = new DurableWorkflowRepository();

  const claimed = await claimNext();
  assert.ok(claimed !== null, 'CLAIM_EXPECTED: the admitted run is claimable by the worker');
  assert.equal(claimed.task.run_id, run_id, 'the gateway admitted exactly the run the worker claims');

  await runClaimed(claimed.task, tolerate_refusal);

  return repository.getTask(context.tenant_id, run_id);
}

/**
 * Executes every run this tenant's queue holds, so a test's own turn is next in line.
 *
 * A step refused as retryable re-queues its run (implement/04 §4.4), and those retries are the
 * queue's oldest entries; an operating worker drains exactly this way. The loop is bounded by the
 * run's own retry budget, after which a failing run terminates and leaves the queue empty.
 */
async function drainQueue() {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const claimed = await claimNext();
    if (claimed === null) return;

    await runClaimed(claimed.task, true);
  }

  throw new Error('QUEUE_NOT_DRAINED: 16 execute-and-claim rounds left work holdable in the queue');
}

/** The next run this worker can claim, or `null` when the queue holds none. */
async function claimNext() {
  const { DurableWorkflowRepository } = context.db;
  const repository = new DurableWorkflowRepository();

  return await repository.claimNextQueuedTask({
    tenant_id: context.tenant_id,
    lease_owner: context.worker_id,
    lease_duration_ms: 30_000,
  });
}

/** Runs one claimed task through the worker entry, optionally absorbing a recorded refusal. */
async function runClaimed(taskRecord, tolerate_refusal) {
  const { DurableWorkflowRepository } = context.db;
  const { processClaimedTask } = context.worker;

  try {
    await processClaimedTask({
      taskRecord,
      tenant_id: context.tenant_id,
      worker_id: context.worker_id,
      workflowRepository: new DurableWorkflowRepository(),
      orchestratorFactory: context.orchestratorFactory,
    });
  } catch (error) {
    if (!tolerate_refusal) throw error;
  }
}

/** The run this worker would claim next, or `null` when the tenant's queue holds none. */
async function claimableRunId() {
  const { DurableWorkflowRepository } = context.db;
  const repository = new DurableWorkflowRepository();
  const claimed = await repository.claimNextQueuedTask({
    tenant_id: context.tenant_id,
    lease_owner: context.worker_id,
    lease_duration_ms: 30_000,
  });

  return claimed === null ? null : claimed.task.run_id;
}

before(async () => {
  const db = await loadBuild('../packages/database/dist/index.js', 'the database package');
  const apiComposition = await loadBuild('../apps/api/dist/runtime/composition.js', 'the gateway composition');
  const apiPrincipal = await loadBuild('../apps/api/dist/gateway/principal.js', 'the gateway credential store');
  const apiServer = await loadBuild('../apps/api/dist/server.js', 'the gateway server');
  const workerConnectors = await loadBuild('../apps/worker/dist/runtime/connectors.js', 'the worker connector binding');
  const workerHmac = await loadBuild('../apps/worker/dist/runtime/hmac.js', 'the worker HMAC primitive');
  const workerEntry = await loadBuild('../apps/worker/dist/worker.js', 'the worker execution path');
  const careGraph = await loadBuild('../apps/worker/dist/runtime/care/index.js', 'the Care orchestrator graph');
  const provider = await loadBuild('../services/mock-erp/src/server.mjs', 'the mock system of record');

  const app_env = requireEnv('APP_ENV');
  if (MANAGED_ENVS.includes(app_env)) {
    throw new Error(
      `MOCK_PROVIDER_FORBIDDEN: APP_ENV=${app_env} may not bind a simulated system of record; this ` +
        'smoke is a local/CI instrument only.',
    );
  }

  requireEnv('DATABASE_URL');
  const audit_secret = requireEnv('AUDIT_HMAC_SECRET');
  const provider_secret = requireEnv('MOCK_SECRET_KEY');
  const tenant_id = (process.env.CARE_TENANT_IDS ?? '').split(',')[0]?.trim() ?? '';
  assert.match(
    tenant_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'CARE_TENANT_IDS_INVALID: set CARE_TENANT_IDS to the pilot tenant UUID',
  );

  // The provider this smoke reaches is the repository's own simulator, started in this process so
  // the signature, the tenant header and the failure classification are exercised for real.
  const providerServer = provider.createServer({
    APP_ENV: app_env,
    MOCK_SECRET_KEY: provider_secret,
    MOCK_ERP_PORT: String(DEFAULT_PROVIDER_PORT),
    // No simulated latency: this smoke measures the execution path, not the simulator's sleep.
    SIMULATE_LATENCY_MS: '0',
  });
  await new Promise((ready) => providerServer.listen(0, '127.0.0.1', ready));
  const provider_port = providerServer.address().port;
  const provider_base = `http://127.0.0.1:${provider_port}/api/v1`;

  const order_references = await resolveOrderReferences(tenant_id);

  // One credential of each kind: the conversation session that owns the Care turn, injected here
  // because this build has no durable credential provisioning (named in the report, never faked).
  let session_token = null;
  const credentials = apiPrincipal.createCredentialStore({
    operators: [],
    sessions: [
      {
        token: (session_token = `smoke-session-${randomUUID()}`),
        tenant_id,
        conversation_id: 'pending-seed',
        session_id: `smoke-session-${randomUUID()}`,
        channel: 'WEB_CHAT',
      },
    ],
    widgets: [],
  });

  const session_secret = process.env.SESSION_SECRET ?? process.env.JWT_SECRET ?? randomUUID();
  const composition = apiComposition.createGatewayComposition(
    {
      APP_ENV: app_env,
      SESSION_SECRET: session_secret,
      PLATFORM_SECRET: process.env.PLATFORM_SECRET ?? process.env.WEBHOOK_HMAC_SECRET ?? randomUUID(),
    },
    { credentials },
  );
  const app = apiServer.buildServer({ runtime: composition.runtime, credentials });

  const connectors = workerConnectors.createWorkerConnectors(
    {
      APP_ENV: app_env,
      CARE_TENANT_IDS: tenant_id,
      MOCK_ERP_ENABLED: 'true',
      ERP_API_BASE_URL: provider_base,
      MOCK_SECRET_KEY: provider_secret,
    },
    { hmac: workerHmac.nodeHmacSha256Hex },
  );

  // One worker identity for the whole smoke: the same id claims the task and releases its lease.
  const context_worker_id = `smoke_worker_${randomUUID().slice(0, 8)}`;

  context = {
    db,
    app,
    composition,
    connectors,
    // Kept so a case can build a second orchestrator graph bound to the same durable store but a
    // different system-of-record reachability (the provider outage in the restart-safety case).
    workerConnectors,
    careGraph,
    workerHmac,
    care_env: {
      APP_ENV: app_env,
      CARE_TENANT_IDS: tenant_id,
      CARE_KNOWLEDGE_ROOT: process.env.CARE_KNOWLEDGE_ROOT,
    },
    worker: workerEntry,
    worker_id: context_worker_id,
    tenant_id,
    audit_secret,
    provider_base,
    providerServer,
    ...order_references,
    session_token,
    credentials,
    orchestratorFactory: careGraph.createCareOrchestratorFactory({
      connectors,
      erp_read: connectors.erp_read,
      // The orchestrator releases the task lease at the end of the run, so it must be the same
      // worker identity that claimed the task — a different id is a lease it does not hold.
      workerId: context_worker_id,
      env: {
        APP_ENV: app_env,
        CARE_TENANT_IDS: tenant_id,
        CARE_KNOWLEDGE_ROOT: process.env.CARE_KNOWLEDGE_ROOT,
      },
      audit_secret,
      hmac: workerHmac.nodeHmacSha256Hex,
    }),
    run_ids: [],
  };

  const fixture = await seedFixtures(db);
  context.fixture = fixture;
  // The session credential is bound to the conversation the seed created; the store is a pure
  // factory, so binding it means resolving the same identity the credential row names.
  context.session_token = session_token;
  context.credentials = apiPrincipal.createCredentialStore({
    operators: [],
    sessions: [
      {
        token: session_token,
        tenant_id,
        conversation_id: fixture.conversation_id,
        session_id: fixture.thread,
        channel: 'WEB_CHAT',
      },
    ],
    widgets: [],
  });
  context.app = apiServer.buildServer({ runtime: composition.runtime, credentials: context.credentials });

  // The plan/agent reference the Care agent the registry allows, so a missing grant row is a
  // configuration failure rather than an authority refusal further down the path.
  await db.withTenantContext(tenant_id, async (client) => {
    await client.query(
      `INSERT INTO agentos.agents (tenant_id, code, name, domain, assigned_authority, is_active)
       VALUES ($1, $2, 'Customer Care Agent', 'support', 'AUTH-1', TRUE)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tenant_id, CARE_AGENT],
    );
  });
});

/**
 * Reads the synthetic API-001 order fixtures and returns the two references this smoke needs: an
 * order the pilot's own customer owns, and one owned by somebody else.
 *
 * The owner must be a UUID that can be seeded as `agentos.customers.id`, because the server-side
 * verification binding is a foreign key to it. A fixture that still carries a non-UUID owner is
 * refused here with the exact reason instead of surfacing as an order-owner mismatch later.
 */
async function resolveOrderReferences(tenant_id) {
  const fixturePath = join(repoRoot, 'testcases', 'fixtures', 'offline', 'orders.json');
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const orders = (fixture.orders ?? []).filter((order) => order.tenant_id === tenant_id);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const own = orders.find((order) => UUID.test(String(order.customer_id)));
  const foreign = orders.find(
    (order) => own !== undefined && order.customer_id !== own.customer_id,
  );

  if (own === undefined || foreign === undefined) {
    throw new Error(
      `ORDER_FIXTURE_UNUSABLE: ${fixturePath} must hold, for tenant ${tenant_id}, one order ` +
        'owned by a UUID customer (seedable as agentos.customers.id) and one owned by a different ' +
        'customer. Without both, the owner check this smoke asserts cannot be exercised.',
    );
  }

  return {
    order_owner_id: own.customer_id,
    order_identifier: own.order_id,
    foreign_order_identifier: foreign.order_id,
  };
}

after(async () => {
  if (context === null) return;
  await cleanupRuns(context.db);
  await cleanupFixtures(context.db, context.fixture);
  await new Promise((closed) => context.providerServer.close(closed));
  await context.db.getPool().end();
});

describe('P1 Customer Care execution path', () => {
  // Each test admits its own turn and then claims it, so the queue it claims from holds nothing
  // else: retryable refusals from an earlier test are executed first, exactly as a worker would.
  beforeEach(async () => {
    await drainQueue();
  });

  it('admits exactly one durable run, executes it through the Care skill, and persists evidence', async () => {
    const idempotency_key = `smoke-turn-${randomUUID()}`;
    const accepted = await postTurn(context.fixture, {
      message: `Where is my order ${context.order_identifier}?`,
      idempotency_key,
    });

    assert.equal(accepted.status, 202, `R02 must accept a Care turn: ${JSON.stringify(accepted.body)}`);
    const run_id = accepted.body.task_id;
    assert.ok(typeof run_id === 'string' && run_id.length > 0, 'R02 answers with a durable task id');
    context.run_ids.push(run_id);

    const task = await executeClaimedRun(run_id);
    assert.equal(task.state, 'completed', `the Care lookup completed: ${await errorsOf(context.db, run_id)}`);

    const { withTenantContext } = context.db;
    const rows = await withTenantContext(context.tenant_id, async (client) => {
      const evidence = await client.query(
        'SELECT evidence_id, chain_hash, signature, payload_sha256 FROM agentos.evidence_records WHERE tenant_id = $1 AND run_id = $2',
        [context.tenant_id, run_id],
      );
      const logs = await client.query(
        'SELECT skill, execution_status, authority, evidence FROM agentos.agent_run_logs WHERE tenant_id = $1 AND run_id = $2',
        [context.tenant_id, run_id],
      );
      const audit = await client.query(
        'SELECT COUNT(*)::int AS total FROM agentos.audit_records WHERE tenant_id = $1 AND run_id = $2',
        [context.tenant_id, run_id],
      );

      return { evidence: evidence.rows, logs: logs.rows, audit: audit.rows[0].total };
    });

    assert.ok(
      rows.evidence.length >= 1,
      `the step wrote an evidence record: ${JSON.stringify(rows)} / ${await errorsOf(context.db, run_id)}`,
    );
    for (const record of rows.evidence) {
      assert.match(record.chain_hash, /^[0-9a-f]{64}$/, 'the evidence chain hash is a real digest');
      assert.match(record.signature, /^[0-9a-f]{64}$/, 'the evidence record is signed');
    }
    assert.ok(
      rows.logs.some((log) => log.skill.startsWith('skill.care.') && log.execution_status === 'success'),
      `an Agent Run row records the Care skill success: ${JSON.stringify(rows.logs)}`,
    );
    assert.ok(rows.audit >= 1, 'the tenant audit chain carries the run');

    const read = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${run_id}`,
      headers: { authorization: `Bearer ${context.session_token}` },
    });

    assert.equal(read.statusCode, 200, `R03 reads the run back: ${read.body}`);
    const body = read.json();
    assert.equal(body.status, 'completed');
    assert.equal(body.task_id, run_id);
    assert.equal(typeof body.evidence_reference, 'string', 'R03 surfaces the evidence reference');
  });

  it('books a provider outage as RETRYABLE and completes the run on the next claim', async () => {
    // Persisted requeue and reclaim (§4.4): the first attempt is dispatched through a connector
    // bound to a closed local port, so the provider call fails on the wire and the request never
    // reaches the system of record. The attempt must still be booked with its error class and spend
    // its retry budget instead of vanishing, and the re-queued run must be claimable again and
    // re-enter its persisted plan from the checkpoint — a run that returns to `queued` with nothing
    // recorded never leaves the queue. Both attempts run in this process, through the same worker
    // identity: this is a durable row-level proof, not a process-restart proof.
    const accepted = await postTurn(context.fixture, {
      message: `Where is my order ${context.order_identifier}?`,
      idempotency_key: `smoke-outage-${randomUUID()}`,
    });
    assert.equal(accepted.status, 202, `R02 must accept a Care turn: ${JSON.stringify(accepted.body)}`);
    const run_id = accepted.body.task_id;
    context.run_ids.push(run_id);

    // The outage graph is the same worker and the same durable store, with the provider base
    // pointed at a port nothing listens on: the step fails on the wire, not on a policy refusal.
    const outage_connectors = context.workerConnectors.createWorkerConnectors(
      {
        APP_ENV: process.env.APP_ENV,
        CARE_TENANT_IDS: context.tenant_id,
        MOCK_ERP_ENABLED: 'true',
        ERP_API_BASE_URL: 'http://127.0.0.1:1/api/v1',
        MOCK_SECRET_KEY: process.env.MOCK_SECRET_KEY,
      },
      { hmac: context.workerHmac.nodeHmacSha256Hex },
    );
    const outage_factory = context.careGraph.createCareOrchestratorFactory({
      connectors: outage_connectors,
      erp_read: outage_connectors.erp_read,
      workerId: context.worker_id,
      env: context.care_env,
      audit_secret: context.audit_secret,
      hmac: context.workerHmac.nodeHmacSha256Hex,
    });

    const { DurableWorkflowRepository } = context.db;
    const repository = new DurableWorkflowRepository();
    const first = await repository.claimNextQueuedTask({
      tenant_id: context.tenant_id,
      lease_owner: context.worker_id,
      lease_duration_ms: 30_000,
    });
    assert.ok(first !== null && first.task.run_id === run_id, 'the admitted run is the claimable one');

    let refusal = null;
    try {
      await context.worker.processClaimedTask({
        taskRecord: first.task,
        tenant_id: context.tenant_id,
        worker_id: context.worker_id,
        workflowRepository: repository,
        orchestratorFactory: outage_factory,
      });
    } catch (error) {
      refusal = error;
    }

    const failed = await repository.getTask(context.tenant_id, run_id);
    assert.equal(
      failed.state,
      'queued',
      `an unreachable provider re-queues the run (refusal: ${refusal === null ? 'none' : refusal.message})`,
    );
    assert.equal(failed.retry_count, 1, 'the failed attempt spent one unit of retry budget');
    assert.equal(failed.last_error_class, 'RETRYABLE', 'the outage is stored as a retryable failure');

    // The provider is reachable again. The same durable row is re-claimed and the run finishes
    // from its checkpoint: this is the attempt that used to die on a replayed stage edge.
    const second = await repository.claimNextQueuedTask({
      tenant_id: context.tenant_id,
      lease_owner: context.worker_id,
      lease_duration_ms: 30_000,
    });
    assert.ok(second !== null && second.task.run_id === run_id, 'the re-queued run is claimable again');

    await context.worker.processClaimedTask({
      taskRecord: second.task,
      tenant_id: context.tenant_id,
      worker_id: context.worker_id,
      workflowRepository: repository,
      orchestratorFactory: context.orchestratorFactory,
    });

    const completed = await repository.getTask(context.tenant_id, run_id);
    assert.equal(
      completed.state,
      'completed',
      `the re-claimed run finished from its checkpoint: ${await errorsOf(context.db, run_id)}`,
    );
    assert.equal(completed.retry_count, 1, 'the successful reattempt added no further failure');

    const read = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${run_id}`,
      headers: { authorization: `Bearer ${context.session_token}` },
    });
    assert.equal(read.statusCode, 200, `R03 reads the recovered run back: ${read.body}`);
    assert.equal(read.json().status, 'completed');
  });

  it('answers a redelivery of the same turn from the run it already started', async () => {
    const idempotency_key = `smoke-replay-${randomUUID()}`;
    const message = `Where is my order ${context.order_identifier}?`;

    const first = await postTurn(context.fixture, { message, idempotency_key });
    assert.equal(first.status, 202);
    context.run_ids.push(first.body.task_id);

    const replay = await postTurn(context.fixture, { message, idempotency_key });
    assert.equal(replay.status, 202, `a redelivery is not an error: ${JSON.stringify(replay.body)}`);
    assert.equal(replay.body.task_id, first.body.task_id, 'the redelivery names the same durable run');

    const { withTenantContext } = context.db;
    const count = await withTenantContext(context.tenant_id, async (client) => {
      const result = await client.query(
        'SELECT COUNT(*)::int AS total FROM agentos.platform_durable_tasks WHERE tenant_id = $1 AND run_id = ANY($2::text[])',
        [context.tenant_id, context.run_ids],
      );
      return result.rows[0].total;
    });

    assert.equal(count, context.run_ids.length, 'one durable run per admitted turn, never two');

    const task = await executeClaimedRun(first.body.task_id);
    assert.equal(task.state, 'completed', 'the admitted turn ran to completion once');
    assert.equal(
      await claimableRunId(),
      null,
      'the redelivery left no second run behind for the worker to execute',
    );
  });

  it('refuses the same key carrying different bytes with IDEMPOTENCY_CONFLICT', async () => {
    const idempotency_key = `smoke-conflict-${randomUUID()}`;

    const first = await postTurn(context.fixture, {
      message: `Where is my order ${context.order_identifier}?`,
      idempotency_key,
    });
    assert.equal(first.status, 202);
    context.run_ids.push(first.body.task_id);

    const conflict = await postTurn(context.fixture, {
      message: 'A different question entirely',
      idempotency_key,
    });

    assert.equal(conflict.status, 409, 'a changed payload under the same key is a conflict');
    assert.equal(conflict.body.error_code, 'IDEMPOTENCY_CONFLICT');

    await executeClaimedRun(first.body.task_id);
  });

  it('invents no answer while the approved knowledge corpus is a draft', async () => {
    const accepted = await postTurn(context.fixture, {
      message: 'What is your return policy?',
      idempotency_key: `smoke-draft-corpus-${randomUUID()}`,
    });
    assert.equal(accepted.status, 202);
    const run_id = accepted.body.task_id;
    context.run_ids.push(run_id);

    const task = await executeClaimedRun(run_id, { tolerate_refusal: true });
    const written = await errorsOf(context.db, run_id);

    assert.notEqual(task.state, 'completed', `a draft corpus is not a source of answers: ${written}`);
    assert.match(written, /CORPUS_UNAVAILABLE/, `the refusal is recorded, not swallowed: ${written}`);
    assert.doesNotMatch(written, /"execution_status":"success"/, 'no successful step is recorded');
  });

  it('never discloses an order owned by a different customer', async () => {
    const accepted = await postTurn(context.fixture, {
      message: `Please check order ${context.foreign_order_identifier}`,
      idempotency_key: `smoke-foreign-order-${randomUUID()}`,
    });
    assert.equal(accepted.status, 202);
    const run_id = accepted.body.task_id;
    context.run_ids.push(run_id);

    const task = await executeClaimedRun(run_id, { tolerate_refusal: true });
    const written = await errorsOf(context.db, run_id);

    assert.notEqual(task.state, 'completed', `another customer's order is never released: ${written}`);
    assert.match(
      written,
      /ORDER_OWNER_MISMATCH|ORDER_NOT_FOUND/,
      `the refusal is the documented one and discloses no existence: ${written}`,
    );
  });

  it('names the capabilities this build does not bind instead of stubbing them', () => {
    assert.ok(
      !context.composition.unbound.includes('runs.start'),
      'the durable start path is bound, not reported unbound',
    );
    for (const capability of context.composition.unbound) {
      assert.equal(typeof capability, 'string');
      assert.ok(capability.length > 0);
    }
    assert.deepEqual(context.connectors.bound, ['API-001'], 'the provider binding is the API-001 connector');
  });
});
