#!/usr/bin/env node
/**
 * P2 Sales execution-path smoke (`implement/09` Gate P2, `implement/06` §8.1).
 *
 * This script is the end-to-end proof of the durable Sales execution graph, and it is deliberately
 * not a unit test with doubles: it drives the built gateway (`apps/api/dist`), the built worker
 * (`apps/worker/dist`) and the built packages against a real PostgreSQL instance with the
 * NOBYPASSRLS application role, and it reaches the provider boundary through the mock system of
 * record over real HTTP with the real request signature.
 *
 * What it proves, in order:
 *   1. Admission: with `ENABLED_AGENT_MODULES=support,sales` and the Sales signal contract
 *      configured (`SALES_SIGNAL_SOURCE_CHANNELS`, `SALES_SIGNAL_EVENT_TYPES`), an API admission
 *      carrying `module: 'sales'` and the configured Sales event type creates exactly ONE durable
 *      run, and a redelivery of the same idempotent inbound identity never starts a second run;
 *   2. Worker execution: the worker claims and leases that task itself, resolves the SALES domain
 *      binding (not Care), executes through the real RevenueOrchestrator and the Sales agent
 *      runtime, exercises at least one authoritative read through the real skill runtime and the
 *      real API-001 read boundary (the mock system of record over real HTTP), and persists the
 *      evidence chain and the Agent Run/audit rows;
 *   3. Readback: the run reads back through the gateway (R03) in its stored durable state;
 *   4. Fail-closed refusals stay refusals: the capabilities this build does not bind (cart, order,
 *      communication, consent, frequency cap, replenishment policy, purchase evidence, quote
 *      signing secret) are reported as unbound rather than silently stubbed, and a mutating Sales
 *      action attempting to use one refuses rather than dispatching.
 *
 * Fail-closed rules: a missing `DATABASE_URL`, a managed `APP_ENV`, an unmigrated schema, a
 * bypassing role, a missing build output or an unreachable provider aborts the run instead of
 * reporting a green path it did not exercise. Nothing here touches a hidden fallback, a cached
 * value or a synthesized fact: a refusal is a result, and it is asserted as one.
 *
 * Offline/mock results are local regression evidence only: never present a mock receipt as real
 * system-of-record evidence.
 *
 * Usage: node --test scripts/sales-pilot-smoke.mjs
 *   DATABASE_URL          application-role URL of a database with the migrations already applied
 *   APP_ENV               local | ci (a managed profile is refused: the mock provider is local only)
 *   SALES_TENANT_IDS      the tenant the Sales pilot is scoped to (a UUID)
 *   AUDIT_HMAC_SECRET     evidence-chain signing secret (never logged, never written to a row)
 *   MOCK_SECRET_KEY       shared secret the platform signs API-001 calls with
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, describe, it } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Environments whose provider is real: a simulated system of record may never be bound there. */
const MANAGED_ENVS = ['staging', 'sandbox', 'production'];

/** The conventional local/CI provider port; only used when the script cannot pick a free one. */
const DEFAULT_PROVIDER_PORT = 8081;

/** The Sales agent codes the platform registry binds for Sales skills. */
const SALES_ADVISOR_AGENT = 'SAL-02';
const SALES_LEAD_AGENT = 'SAL-01';

/** The canonical mock-erp catalog SKU available on the local/CI simulated provider. */
const FIXTURE_SKU = 'SKU-LOCAL-1';

let context = null;

/** Reads a required environment value, failing closed with the variable's name. */
function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `${name}_REQUIRED: the Sales pilot smoke drives the real runtime, so it cannot run without ` +
        `${name}. Set it, then re-run \`node --test scripts/sales-pilot-smoke.mjs\`.`,
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
 * Scopes customer, identity, and conversation to the Sales pilot tenant so nothing collides with
 * the Customer Care pilot fixtures.
 */
async function seedFixtures(db) {
  const { withTenantContext } = db;
  const tenant_id = context.tenant_id;
  const customer_id = randomUUID();
  const thread = `smoke-sales-thread-${randomUUID()}`;
  const conversation_id = await withTenantContext(tenant_id, async (client) => {
    await client.query(
      `INSERT INTO agentos.customers (id, tenant_id, display_name, verification_status)
       VALUES ($1, $2, 'P2 Sales smoke customer', 'verified')
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
  if (!fixture) return;
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
 * those rows where they are.
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

/** One JSON blob of durable rows, so a refusal or error can be found where it was actually written. */
async function errorsOf(db, run_id) {
  const { withTenantContext } = db;
  return withTenantContext(context.tenant_id, async (client) => {
    const task = await client.query(
      'SELECT state, current_step, last_error_class, error_details, state_payload FROM agentos.platform_durable_tasks WHERE tenant_id = $1 AND run_id = $2',
      [context.tenant_id, run_id],
    );
    const logs = await client.query(
      'SELECT skill, execution_status, error, decision FROM agentos.agent_run_logs WHERE tenant_id = $1 AND run_id = $2',
      [context.tenant_id, run_id],
    );
    const audit = await client.query(
      'SELECT decision, error, context FROM agentos.audit_records WHERE tenant_id = $1 AND run_id = $2',
      [context.tenant_id, run_id],
    );

    return JSON.stringify({ task: task.rows, logs: logs.rows, audit: audit.rows });
  });
}

/** Runs one Sales conversational turn through the gateway and returns the R02 acceptance body. */
async function postTurn(fixture, { message, idempotency_key, module = 'sales', event_type = 'message.received' }) {
  const response = await context.app.inject({
    method: 'POST',
    url: `/api/v1/conversations/${fixture.conversation_id}/messages`,
    headers: { authorization: `Bearer ${context.session_token}` },
    payload: { message, idempotency_key, module, event_type },
  });

  return { status: response.statusCode, body: response.json() };
}

/**
 * Claims and executes the run the gateway admitted, exactly as the polling worker does.
 *
 * @returns The durable task state the worker left behind, read from PostgreSQL.
 */
async function executeClaimedRun(run_id, { tolerate_refusal = false } = {}) {
  const { DurableWorkflowRepository } = context.db;
  const repository = new DurableWorkflowRepository();

  const claimed = await claimNext();
  assert.ok(claimed !== null, 'CLAIM_EXPECTED: the admitted run is claimable by the worker');
  assert.equal(claimed.task.run_id, run_id, 'the gateway admitted exactly the run the worker claims');

  await runClaimed(claimed.task, tolerate_refusal);

  return repository.getTask(context.tenant_id, run_id);
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

/** Runs one claimed task through the worker entry, resolving the Sales domain runtime binding. */
async function runClaimed(taskRecord, tolerate_refusal) {
  const { DurableWorkflowRepository } = context.db;
  const { processClaimedTask } = context.worker;

  try {
    await processClaimedTask({
      taskRecord,
      tenant_id: context.tenant_id,
      worker_id: context.worker_id,
      workflowRepository: new DurableWorkflowRepository(),
      registry: context.registry,
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

/** Executes every run this tenant's queue holds, so a test's own turn is next in line. */
async function drainQueue() {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const claimed = await claimNext();
    if (claimed === null) return;

    await runClaimed(claimed.task, true);
  }

  throw new Error('QUEUE_NOT_DRAINED: 16 execute-and-claim rounds left work holdable in the queue');
}

before(async () => {
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

  const rawTenants = process.env.SALES_TENANT_IDS ?? process.env.CARE_TENANT_IDS;
  if (!rawTenants || rawTenants.trim().length === 0) {
    throw new Error(
      'SALES_TENANT_IDS_REQUIRED: the Sales pilot smoke drives the real runtime, so it cannot run without ' +
        'SALES_TENANT_IDS (or CARE_TENANT_IDS). Set it, then re-run `node --test scripts/sales-pilot-smoke.mjs`.',
    );
  }

  // The simulated ERP provider's catalog and inventory fixtures are bound to one tenant
  // (services/mock-erp/src/fixtures.mjs). The Sales smoke therefore takes the first configured
  // tenant id so it and the Care pilot never corrupt each other's fixtures or order state.
  const tenant_id = rawTenants.split(',')[0]?.trim() ?? '';

  assert.match(
    tenant_id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    'SALES_TENANT_IDS_INVALID: set SALES_TENANT_IDS to the pilot tenant UUID',
  );

  // Configure environment variables for Sales modules and signal contract
  process.env.ENABLED_AGENT_MODULES = 'support,sales';
  process.env.SALES_SIGNAL_SOURCE_CHANNELS = 'WEB_CHAT,STOREFRONT';
  process.env.SALES_SIGNAL_EVENT_TYPES = 'cart.abandoned,message.received';

  const db = await loadBuild('../packages/database/dist/index.js', 'the database package');
  const apiComposition = await loadBuild('../apps/api/dist/runtime/composition.js', 'the gateway composition');
  const apiPrincipal = await loadBuild('../apps/api/dist/gateway/principal.js', 'the gateway credential store');
  const apiServer = await loadBuild('../apps/api/dist/server.js', 'the gateway server');
  const workerConnectors = await loadBuild('../apps/worker/dist/runtime/connectors.js', 'the worker connector binding');
  const workerHmac = await loadBuild('../apps/worker/dist/runtime/hmac.js', 'the worker HMAC primitive');
  const workerEntry = await loadBuild('../apps/worker/dist/worker.js', 'the worker execution path');
  const salesGraph = await loadBuild('../apps/worker/dist/runtime/sales/index.js', 'the Sales orchestrator graph');
  const provider = await loadBuild('../services/mock-erp/src/server.mjs', 'the mock system of record');

  const providerServer = provider.createServer({
    APP_ENV: app_env,
    MOCK_SECRET_KEY: provider_secret,
    MOCK_ERP_PORT: String(DEFAULT_PROVIDER_PORT),
    SIMULATE_LATENCY_MS: '0',
  });
  await new Promise((ready) => providerServer.listen(0, '127.0.0.1', ready));
  const provider_port = providerServer.address().port;
  const provider_base = `http://127.0.0.1:${provider_port}/api/v1`;

  let session_token = null;
  const credentials = apiPrincipal.createCredentialStore({
    operators: [],
    sessions: [
      {
        token: (session_token = `smoke-sales-session-${randomUUID()}`),
        tenant_id,
        conversation_id: 'pending-seed',
        session_id: `smoke-sales-session-${randomUUID()}`,
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
      ENABLED_AGENT_MODULES: 'support,sales',
      SALES_SIGNAL_EVENT_TYPES: 'cart.abandoned,message.received',
    },
    { credentials },
  );

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

  const context_worker_id = `smoke_sales_worker_${randomUUID().slice(0, 8)}`;

  const salesFactory = salesGraph.createSalesOrchestratorFactory
    ? salesGraph.createSalesOrchestratorFactory
    : (await loadBuild('../apps/worker/dist/runtime/sales/factory.js', 'the Sales orchestrator factory')).createSalesOrchestratorFactory;

  const orchestratorFactory = salesFactory({
    workerId: context_worker_id,
    erp_read: connectors.erp_read,
    auditSecret: audit_secret,
  });

  const domainRegistryModule = await loadBuild(
    '../apps/worker/dist/runtime/domain-registry.js',
    'the domain runtime registry',
  );

  const registry = domainRegistryModule.createDomainRuntimeRegistry([
    {
      contract: {
        module: 'sales',
        source_channels: ['WEB_CHAT', 'STOREFRONT'],
        event_types: ['message.received', 'cart.abandoned'],
        signal_invalid_code: 'SALES_SIGNAL_INVALID',
      },
      createOrchestrator: orchestratorFactory,
    },
  ]);

  context = {
    db,
    app: null,
    composition,
    connectors,
    workerConnectors,
    salesGraph,
    salesFactory,
    domainRegistry: domainRegistryModule,
    workerHmac,
    worker: workerEntry,
    worker_id: context_worker_id,
    tenant_id,
    audit_secret,
    provider_base,
    providerServer,
    session_token,
    credentials,
    orchestratorFactory,
    registry,
    run_ids: [],
  };

  const fixture = await seedFixtures(db);
  context.fixture = fixture;
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

  context.app = apiServer.buildServer({
    runtime: composition.runtime,
    credentials: context.credentials,
    enabledModules: ['support', 'sales'],
    salesSignalEventTypes: ['cart.abandoned', 'message.received'],
  });

  // Seed authoritative platform agent grants for the Sales domain
  await db.withTenantContext(tenant_id, async (client) => {
    await client.query(
      `INSERT INTO agentos.agents (tenant_id, code, name, domain, assigned_authority, is_active)
       VALUES ($1, $2, 'AI Sales Advisor Agent', 'sales', 'AUTH-3', TRUE)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tenant_id, SALES_ADVISOR_AGENT],
    );
    await client.query(
      `INSERT INTO agentos.agents (tenant_id, code, name, domain, assigned_authority, is_active)
       VALUES ($1, $2, 'Sales Lead Qualification Agent', 'sales', 'AUTH-0', TRUE)
       ON CONFLICT (tenant_id, code) DO NOTHING`,
      [tenant_id, SALES_LEAD_AGENT],
    );
  });
});

after(async () => {
  if (context === null) return;
  await cleanupRuns(context.db);
  await cleanupFixtures(context.db, context.fixture);
  await new Promise((closed) => context.providerServer.close(closed));
  await context.db.getPool().end();
});

describe('P2 Sales execution path', () => {
  beforeEach(async () => {
    await drainQueue();
  });

  it('1. Admission: admits exactly one durable run for module: sales and reuses it on redelivery', async () => {
    const idempotency_key = `smoke-sales-admission-${randomUUID()}`;
    const message = `Is ${FIXTURE_SKU} in stock?`;

    // First delivery creates exactly one durable run
    const first = await postTurn(context.fixture, {
      message,
      idempotency_key,
      module: 'sales',
      event_type: 'message.received',
    });
    assert.equal(first.status, 202, `R02 must accept a Sales turn: ${JSON.stringify(first.body)}`);
    const run_id = first.body.task_id;
    assert.ok(typeof run_id === 'string' && run_id.length > 0, 'R02 answers with a durable task id');
    context.run_ids.push(run_id);

    // Redelivery of the same idempotent inbound identity must return the same run and not start a second run
    const replay = await postTurn(context.fixture, {
      message,
      idempotency_key,
      module: 'sales',
      event_type: 'message.received',
    });
    assert.equal(replay.status, 202, `a redelivery is accepted: ${JSON.stringify(replay.body)}`);
    assert.equal(replay.body.task_id, run_id, 'the redelivery names the exact same durable run');

    // Prove exactly one durable task row was created in the database
    const { withTenantContext } = context.db;
    const count = await withTenantContext(context.tenant_id, async (client) => {
      const result = await client.query(
        'SELECT COUNT(*)::int AS total FROM agentos.platform_durable_tasks WHERE tenant_id = $1 AND run_id = ANY($2::text[])',
        [context.tenant_id, context.run_ids],
      );
      return result.rows[0].total;
    });
    assert.equal(count, context.run_ids.length, 'exactly one durable run per admitted turn, never two');

    // Run to completion once
    const task = await executeClaimedRun(run_id);
    assert.equal(task.state, 'completed', `the admitted turn ran to completion: ${await errorsOf(context.db, run_id)}`);
    assert.equal(await claimableRunId(), null, 'the redelivery left no second run behind in the worker queue');
  });

  it('1b. Admission: refuses the same idempotency key carrying different bytes with IDEMPOTENCY_CONFLICT', async () => {
    const idempotency_key = `smoke-sales-conflict-${randomUUID()}`;

    const first = await postTurn(context.fixture, {
      message: `Is ${FIXTURE_SKU} in stock?`,
      idempotency_key,
      module: 'sales',
      event_type: 'message.received',
    });
    assert.equal(first.status, 202);
    context.run_ids.push(first.body.task_id);

    const conflict = await postTurn(context.fixture, {
      message: 'Show me other products instead',
      idempotency_key,
      module: 'sales',
      event_type: 'message.received',
    });

    assert.equal(conflict.status, 409, 'a changed payload under the same key is a conflict');
    assert.equal(conflict.body.error_code, 'IDEMPOTENCY_CONFLICT');

    await executeClaimedRun(first.body.task_id);
  });

  it('2. Worker execution: claims, resolves SALES domain binding, executes through RevenueOrchestrator and Sales runtime with authoritative ERP read, and persists evidence', async () => {
    const idempotency_key = `smoke-sales-exec-${randomUUID()}`;
    const accepted = await postTurn(context.fixture, {
      message: `Is ${FIXTURE_SKU} in stock?`,
      idempotency_key,
      module: 'sales',
      event_type: 'message.received',
    });

    assert.equal(accepted.status, 202, `R02 accepts Sales turn: ${JSON.stringify(accepted.body)}`);
    const run_id = accepted.body.task_id;
    context.run_ids.push(run_id);

    // Verify worker claims and leases the task itself, resolving the SALES domain binding
    const claimed = await claimNext();
    assert.ok(claimed !== null, 'the worker claims the queued Sales task');
    assert.equal(claimed.task.run_id, run_id, 'the worker claimed the exact admitted task');
    assert.equal(claimed.task.lease_owner, context.worker_id, 'the worker leased the task itself');

    // Verify domain binding resolution
    const binding = context.registry.resolve('sales');
    assert.ok(binding !== null, 'resolved the SALES domain runtime binding');
    assert.equal(binding.contract.module, 'sales', 'resolved module is sales (not Care)');

    // Run claimed task through processClaimedTask
    await runClaimed(claimed.task, false);

    const { DurableWorkflowRepository } = context.db;
    const repo = new DurableWorkflowRepository();
    const task = await repo.getTask(context.tenant_id, run_id);
    assert.equal(task.state, 'completed', `the Sales stock check completed: ${await errorsOf(context.db, run_id)}`);

    // Verify persisted evidence chain, agent run logs, and audit records
    const { withTenantContext } = context.db;
    const rows = await withTenantContext(context.tenant_id, async (client) => {
      const evidence = await client.query(
        'SELECT evidence_id, chain_hash, signature, payload_sha256 FROM agentos.evidence_records WHERE tenant_id = $1 AND run_id = $2',
        [context.tenant_id, run_id],
      );
      const logs = await client.query(
        'SELECT skill, execution_status, error FROM agentos.agent_run_logs WHERE tenant_id = $1 AND run_id = $2',
        [context.tenant_id, run_id],
      );
      const audit = await client.query(
        'SELECT COUNT(*)::int AS count FROM agentos.audit_records WHERE tenant_id = $1 AND run_id = $2',
        [context.tenant_id, run_id],
      );

      return {
        evidence: evidence.rows,
        logs: logs.rows,
        audit: audit.rows[0]?.count ?? 0,
      };
    });

    // Evidence chain assertions (NFR-002 non-repudiation)
    assert.ok(rows.evidence.length >= 1, 'at least one evidence record is persisted for the Sales execution');
    for (const record of rows.evidence) {
      assert.equal(typeof record.chain_hash, 'string');
      assert.equal(record.chain_hash.length, 64, 'chain_hash is a 64-character SHA-256 hex string');
      assert.equal(typeof record.signature, 'string');
      assert.equal(record.signature.length, 64, 'signature is a 64-character HMAC-SHA-256 hex string');
    }

    // Authoritative read assertion: executed through skill.sales.check_stock and API-001 boundary over HTTP
    assert.ok(
      rows.logs.some((log) => log.skill === 'skill.sales.check_stock' && log.execution_status === 'success'),
      `an Agent Run row records the Sales authoritative read success: ${JSON.stringify(rows.logs)}`,
    );

    // Audit row assertion
    assert.ok(rows.audit >= 1, 'the tenant audit chain carries the run');
  });

  it('3. Readback: the run reads back through the gateway in its stored durable state', async () => {
    const idempotency_key = `smoke-sales-readback-${randomUUID()}`;
    const accepted = await postTurn(context.fixture, {
      message: `Is ${FIXTURE_SKU} in stock?`,
      idempotency_key,
      module: 'sales',
      event_type: 'message.received',
    });
    assert.equal(accepted.status, 202);
    const run_id = accepted.body.task_id;
    context.run_ids.push(run_id);

    const completed = await executeClaimedRun(run_id);
    assert.equal(completed.state, 'completed');

    // Read back through R03 (GET /api/v1/tasks/{task_id})
    const read = await context.app.inject({
      method: 'GET',
      url: `/api/v1/tasks/${run_id}`,
      headers: { authorization: `Bearer ${context.session_token}` },
    });

    assert.equal(read.statusCode, 200, `R03 reads the run back: ${read.body}`);
    const body = read.json();
    assert.equal(body.task_id, run_id, 'R03 returns the requested task_id');
    assert.equal(body.status, 'completed', 'R03 surfaces the stored completed state');
    assert.equal(typeof body.evidence_reference, 'string', 'R03 surfaces the evidence reference');
  });

  it('4. Fail-closed refusals stay refusals: unbound capabilities are reported and mutating Sales actions refuse rather than dispatch', async () => {
    // 1. Assert unbound capabilities are reported rather than silently stubbed
    const getUnbound = context.salesGraph.getSalesUnboundCapabilities;
    const unboundCaps = typeof getUnbound === 'function'
      ? getUnbound({ erp_read: context.connectors.erp_read })
      : [];

    const skillServices = context.salesGraph.createSalesSkillServices({
      erp_read: context.connectors.erp_read,
      context: {
        verifiedCustomerFor: () => null,
        verifiedTimelineFor: () => null,
      },
      resolve_correlation_id: async () => 'corr-refusal-test',
      resolve_grant: async () => 'AUTH-3',
    });

    const allUnbound = [
      ...unboundCaps,
      ...(skillServices.unbound ?? []),
    ];
    const unboundText = allUnbound.join('\n');

    // All named unbound capabilities must be reported:
    assert.match(unboundText, /cart/i, 'cart capability is reported as unbound');
    assert.match(unboundText, /order/i, 'order capability is reported as unbound');
    assert.match(unboundText, /communication/i, 'communication capability is reported as unbound');
    assert.match(unboundText, /consent/i, 'consent capability is reported as unbound');
    assert.match(unboundText, /frequency cap/i, 'frequency cap capability is reported as unbound');
    assert.match(unboundText, /replenishment policy/i, 'replenishment policy capability is reported as unbound');
    assert.match(unboundText, /purchase evidence/i, 'purchase evidence capability is reported as unbound');
    assert.match(unboundText, /quote signing secret/i, 'quote signing secret capability is reported as unbound');

    // 2. Assert mutating Sales action attempting to use unbound cart refuses rather than dispatches
    const cartDraft = {
      action_id: randomUUID(),
      action_revision: 0,
      run_id: `run-refusal-cart-${randomUUID()}`,
      tenant_id: context.tenant_id,
      agent_id: SALES_ADVISOR_AGENT,
      skill_id: 'skill.sales.create_cart',
      adapter_target: 'API-002.CommerceCartAPI',
      step_index: 1,
      mutating: true,
      price_bearing: false,
      request_id: `req-cart-${randomUUID()}`,
      effect_key: `ek-cart-${randomUUID()}`,
      required_authority: 'AUTH-3',
      payload: {
        tenant_id: context.tenant_id,
        items: [{ sku_id: FIXTURE_SKU, quantity: 1 }],
      },
    };
    await assert.rejects(
      () => skillServices.dispatcher.dispatch(cartDraft),
      (err) => {
        assert.equal(err?.code, 'SKILL_DISABLED', 'skill.sales.create_cart refuses with SKILL_DISABLED');
        return true;
      },
      'mutating Sales action skill.sales.create_cart must refuse rather than dispatch',
    );

    // 3. Assert mutating Sales action attempting to use unbound order refuses rather than dispatches
    const orderDraft = {
      action_id: randomUUID(),
      action_revision: 0,
      run_id: `run-refusal-order-${randomUUID()}`,
      tenant_id: context.tenant_id,
      agent_id: SALES_ADVISOR_AGENT,
      skill_id: 'skill.sales.create_order',
      adapter_target: 'API-001.OrderConnector',
      step_index: 1,
      mutating: true,
      price_bearing: false,
      request_id: `req-order-${randomUUID()}`,
      effect_key: `ek-order-${randomUUID()}`,
      required_authority: 'AUTH-3',
      payload: {
        tenant_id: context.tenant_id,
        cart_id: 'cart-mock-123',
      },
    };
    await assert.rejects(
      () => skillServices.dispatcher.dispatch(orderDraft),
      (err) => {
        assert.equal(err?.code, 'SKILL_DISABLED', 'skill.sales.create_order refuses with SKILL_DISABLED');
        return true;
      },
      'mutating Sales action skill.sales.create_order must refuse rather than dispatch',
    );

    // 4. Assert mutating Sales action attempting to use unbound communication refuses rather than dispatches
    const messageDraft = {
      action_id: randomUUID(),
      action_revision: 0,
      run_id: `run-refusal-msg-${randomUUID()}`,
      tenant_id: context.tenant_id,
      agent_id: SALES_ADVISOR_AGENT,
      skill_id: 'skill.sales.send_message',
      adapter_target: 'API-003.CommunicationConnector',
      step_index: 1,
      mutating: true,
      price_bearing: false,
      request_id: `req-msg-${randomUUID()}`,
      effect_key: `ek-msg-${randomUUID()}`,
      required_authority: 'AUTH-3',
      payload: {
        tenant_id: context.tenant_id,
        recipient_id: 'cust-local-1',
        message: 'Cart abandonment reminder',
      },
    };
    await assert.rejects(
      () => skillServices.dispatcher.dispatch(messageDraft),
      (err) => {
        assert.equal(err?.code, 'SKILL_DISABLED', 'skill.sales.send_message refuses with SKILL_DISABLED');
        return true;
      },
      'mutating Sales action skill.sales.send_message must refuse rather than dispatch',
    );
  });
});
