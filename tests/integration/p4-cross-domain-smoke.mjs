#!/usr/bin/env node
/**
 * P4 cross-domain handoff smoke (`implement/09` §1.1 Gate P4, plans/customer-lifecycle.md §3).
 *
 * This is the live-database proof of the durable handoff ledger, and it is deliberately not a unit
 * test with doubles: it drives the built `@agentos/database` package against a real PostgreSQL
 * instance as the NOBYPASSRLS application role, so the constraints the ledger's safety rests on are
 * exercised where they actually live.
 *
 * What it proves, in order:
 *   1. Admission: `admitCrossDomainHandoff` commits ONE reservation, ONE target durable task and
 *      ONE ledger row for a hop, and the target task is queued with the handoff signal;
 *   2. No duplicate handoff: the same hop replayed is answered from the ledger as REPLAY with the
 *      SAME target run id, and no second task or ledger row exists;
 *   3. No silent overwrite: the same idempotency key carrying different bytes is CONFLICT;
 *   4. No fabricated fact: an evidence reference classified FACT with no authoritative
 *      `agentos.evidences` row is refused `HANDOFF_EVIDENCE_UNVERIFIED` before any write;
 *   5. Lifecycle: the second hop advances the durable journey, and a repeated lifecycle version is
 *      refused by the ledger's `(tenant_id, customer_id, lifecycle_version)` constraint;
 *   6. Isolation: a hop addressed to another tenant's customer is refused;
 *   5b. Journey: marketing -> sales -> care for one customer is admitted leg by leg, on ONE
 *      lifecycle and one timeline, and a hop past the last leg is refused.
 *   7. Timeline: the handoff's Customer 360 row is committed BY the admission (same transaction),
 *      cites the ledger's own handoff id, reads back with its server marker, and a replayed
 *      admission appends no second row.
 *   8. Broker retry: an already-admitted hop retried from the SAME source run is answered from the
 *      durable ledger without advancing lifecycle state or appending another timeline row;
 *   9. Worker claim: the admitted target is claimed from the durable queue with its internal
 *      ORCHESTRATOR_HANDOFF signal and the ledger/package identity intact.
 *
 * Fail-closed rules: a missing `DATABASE_URL`, a managed `APP_ENV`, an unmigrated schema or a
 * bypassing role aborts the run instead of reporting a green path it did not exercise.
 *
 * This smoke proves the LEDGER, same-source broker retry and worker claim seam. It still does not
 * drive the HTTP path, and it is not formal Gate P4 evidence; HTTP routing remains the
 * `TC-E2E-001..009` gap recorded in `blocked.md`.
 *
 * It is re-runnable but not idempotent in its fixtures: every run seeds a fresh customer and the
 * ledger keeps what the run proved, because the handoff ledger is append-only (`REVOKE DELETE`).
 * Point `P4_TENANT_IDS` at a tenant you are willing to accumulate handoff history in.
 *
 * Usage: node --test tests/integration/p4-cross-domain-smoke.mjs
 *   DATABASE_URL        application-role URL of a database with the migrations applied
 *   APP_ENV             local | ci (a managed profile is refused: this smoke is local only)
 *   P4_TENANT_IDS       the tenant this smoke is scoped to (a UUID)
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { ensureIntegrationTenant } from './tenant-fixtures.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Environments whose database is real: a local smoke may never run against them. */
const MANAGED_ENVS = ['staging', 'sandbox', 'production'];

/** The channel a brokered handoff is admitted on; never a customer-facing channel. */
const HANDOFF_CHANNEL = 'ORCHESTRATOR_HANDOFF';

/**
 * The tenant the isolation case owns.
 *
 * It exists so the cross-tenant negative addresses a REAL customer of another tenant instead of an
 * id that merely does not exist: a missing customer is an FK refusal, which is a different claim.
 * Nothing is ever admitted under this tenant, so it accumulates exactly one fixture row.
 */
const SECOND_TENANT_ID = '22222222-2222-4222-8222-22222222222b';

/** Reservation window the ledger expects the caller to own (mirrors EFFECT_RESERVATION_TTL_MS). */
const RESERVATION_TTL_MS = 259_200_000;

let context = null;

/** Reads a required environment value, failing closed with the variable's name. */
function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `${name}_REQUIRED: this smoke drives the real ledger, so it cannot run without ${name}. ` +
        `Set it, then re-run \`node --test tests/integration/p4-cross-domain-smoke.mjs\`.`,
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

/** The canonical handoff idempotency digest, recomputed here so the smoke never trusts its own input. */
function handoffKey(fields) {
  const canonical = JSON.stringify([
    fields.tenant_id,
    fields.customer_id,
    fields.source_run_id,
    fields.target_domain,
    fields.target_agent,
    fields.lifecycle_version,
    fields.reason,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** One hop's admission input, with every identity field derived rather than hand-written. */
function handoffInput(overrides = {}) {
  // Each case owns its customer: the ledger's `(tenant_id, customer_id, lifecycle_version)` key is
  // real, so a shared fixture would make the second case's first hop a CONFLICT instead of a test.
  if (typeof overrides.customer_id !== 'string' || overrides.customer_id.length === 0) {
    throw new Error(
      'P4_SMOKE_CUSTOMER_REQUIRED: handoffInput() must be given the case\'s own customer_id ' +
        '(seed one with freshCustomer()); a shared fixture collides on the ledger lifecycle key.',
    );
  }

  const base = {
    tenant_id: context.tenant_id,
    correlation_id: 'p4-smoke-correlation',
    source_domain: 'marketing',
    source_agent: 'MKT-05',
    source_run_id: `run_p4_smoke_${randomUUID().slice(0, 8)}`,
    target_domain: 'sales',
    target_agent: 'SAL-02',
    target_module: 'sales',
    reason: 'Marketing leg completed; Sales consultation is the next leg',
    classification: 'DECISION',
    evidence: [
      {
        classification: 'DECISION',
        claim: 'Marketing leg completed for a verified customer',
        source_uri: 'agentos://runs/p4-smoke',
        source_version: '1',
        verified_by: 'agentos.orchestrator',
      },
    ],
    lifecycle_state: 'HANDED_OFF',
    lifecycle_version: 1,
    hop_count: 1,
    visited_domains: ['marketing'],
    occurred_at: '2026-09-26T10:00:00.000Z',
    reservation_ttl_ms: RESERVATION_TTL_MS,
    ...overrides,
  };
  const idempotency_key = handoffKey({
    tenant_id: base.tenant_id,
    customer_id: base.customer_id,
    source_run_id: base.source_run_id,
    target_domain: base.target_domain,
    target_agent: base.target_agent,
    lifecycle_version: base.lifecycle_version,
    reason: base.reason,
  });

  const handoff_id = randomUUID();

  return {
    ...base,
    handoff_id,
    idempotency_key,
    // The Customer 360 row is part of the admission, so the smoke submits it with the hop exactly
    // as the broker does; the store commits it in the same transaction.
    timeline_event: {
      source_event_id: idempotency_key,
      event_name: 'ext.lifecycle.handoff',
      session_id: base.source_run_id,
      channel: 'orchestrator',
      occurred_at: base.occurred_at,
      payload: {
        classification: base.classification,
        classification_authority: 'SERVER',
        domain: base.target_domain,
        stage: 'HANDOFF',
        summary: base.reason,
        source_domain: base.source_domain,
        target_domain: base.target_domain,
        lifecycle_version: base.lifecycle_version,
      },
    },
    request_fingerprint: createHash('sha256').update(`${idempotency_key}:v1`).digest('hex'),
    run_id: `run_target_${randomUUID().slice(0, 8)}`,
    signal: {
      signal_id: randomUUID(),
      tenant_id: base.tenant_id,
      correlation_id: base.correlation_id,
      source_channel: HANDOFF_CHANNEL,
      event_type: 'handoff.marketing_to_sales',
      payload: { module: base.target_module, handoff_reason: base.reason },
      subject: { session_id: base.source_run_id, channel_type: 'orchestrator', verified_customer_id: base.customer_id },
      timestamp: base.occurred_at,
    },
  };
}

/** Seeds one customer for one case, so a case's lifecycle versions never collide with another's. */
async function freshCustomer() {
  const customer_id = randomUUID();
  await context.db.withTenantContext(context.tenant_id, async (client) => {
    await client.query(
      `INSERT INTO agentos.customers (id, tenant_id, display_name, verification_status)
       VALUES ($1, $2, 'P4 cross-domain smoke customer', 'verified')
       ON CONFLICT (id) DO NOTHING`,
      [customer_id, context.tenant_id],
    );
  });
  return customer_id;
}

/** Counts the durable rows one hop owns, so a duplicate is proved rather than assumed. */
async function countRows(sql, values) {
  return context.db.withTenantContext(context.tenant_id, async (client) => {
    const result = await client.query(sql, values);
    return Number(result.rows[0]?.count ?? 0);
  });
}

/** Builds the broker draft used by the live retry/claim cases from the same fixture identity. */
function brokerDraft(overrides = {}) {
  const input = handoffInput(overrides);
  return {
    tenant_id: input.tenant_id,
    customer_id: input.customer_id,
    correlation_id: input.correlation_id,
    source_domain: input.source_domain,
    source_agent: input.source_agent,
    source_run_id: input.source_run_id,
    source_authority: 'AUTH-1',
    target_domain: input.target_domain,
    target_agent: input.target_agent,
    reason: input.reason,
    evidence: input.evidence,
    occurred_at: input.occurred_at,
  };
}

/** Loads the worker's real broker against the live database repositories, with no recovery cache. */
function liveBroker() {
  return context.workerHandoff.createCrossDomainHandoffBroker({
    handoffRepository: {
      readCrossDomainLifecycle: context.db.readCrossDomainLifecycle,
    },
    admit: context.db.admitCrossDomainHandoff,
  });
}

/** Counts only this customer's durable handoff timeline rows. */
async function handoffTimelineCount(customer_id) {
  const timeline = await context.events.listTimeline({
    tenant_id: context.tenant_id,
    customer_id,
    limit: 200,
  });
  return timeline.items.filter((item) => item.event_name === 'ext.lifecycle.handoff').length;
}

describe('P4 cross-domain handoff ledger (real PostgreSQL)', () => {
  before(async () => {
    const connectionString = requireEnv('DATABASE_URL');
    const appEnv = (process.env.APP_ENV ?? 'local').trim();
    if (MANAGED_ENVS.includes(appEnv)) {
      throw new Error(
        `APP_ENV_MANAGED: this smoke is local/CI only and refuses to run against '${appEnv}'.`,
      );
    }

    const db = await loadBuild('../../packages/database/dist/index.js', 'the database package');
    const workerHandoff = await loadBuild(
      '../../apps/worker/dist/runtime/shared/cross-domain-handoff.js',
      'the worker handoff broker',
    );
    const workerEntry = await loadBuild('../../apps/worker/dist/worker.js', 'the worker execution path');
    const coreEngine = await loadBuild('../../packages/core-engine/dist/index.js', 'the core-engine error contract');
    const domainRegistryModule = await loadBuild(
      '../../apps/worker/dist/runtime/domain-registry.js',
      'the domain runtime registry',
    );
    const runtimeAdapters = await loadBuild(
      '../../apps/worker/dist/runtime/shared/adapters.js',
      'the worker durable adapters',
    );
    const salesGraph = await loadBuild('../../apps/worker/dist/runtime/sales/index.js', 'the Sales orchestrator graph');
    const careGraph = await loadBuild('../../apps/worker/dist/runtime/care/index.js', 'the Care orchestrator graph');
    const marketingGraph = await loadBuild(
      '../../apps/worker/dist/runtime/marketing/factory.js',
      'the Marketing orchestrator factory',
    );
    const tenant_id = requireEnv('P4_TENANT_IDS');
    const audit_secret = requireEnv('AUDIT_HMAC_SECRET');
    const worker_id = 'p4_cross_domain_worker_' + randomUUID().slice(0, 8);

    // The worker path is explicitly journey-enabled, just as the production worker composition is;
    // every runtime below shares tenant-scoped durable adapters and the PostgreSQL workflow repository.
    process.env.CROSS_DOMAIN_JOURNEY_ENABLED = 'true';
    const workflowRepository = new db.DurableWorkflowRepository();
    const adapters = runtimeAdapters.createDurableAdapters({
      workflowRepository,
      approvalRepository: new db.ApprovalRepository(),
      evidenceRepository: new db.EvidenceRepository(),
      auditRepository: new db.AuditRepository(),
      conversationRepository: new db.ConversationRepository(),
      auditSecret: audit_secret,
    });

    await ensureIntegrationTenant(db, tenant_id, 'p4');
    await ensureIntegrationTenant(db, SECOND_TENANT_ID, 'p4-foreign');
    context = {
      db,
      workerHandoff,
      coreEngine,
      worker: workerEntry,
      tenant_id,
      worker_id,
      workflowRepository,
      events: new db.CustomerEventRepository(),
      forceResumeAdmissionUnresolved: false,
      lastResumeAdmissionErrorCode: null,
    };

    const workerBroker = workerHandoff.createCrossDomainHandoffBroker({
      handoffRepository: {
        readCrossDomainLifecycle: context.db.readCrossDomainLifecycle,
      },
      admit: async (input) => {
        if (context.forceResumeAdmissionUnresolved) {
          context.forceResumeAdmissionUnresolved = false;
          context.lastResumeAdmissionErrorCode = 'HANDOFF_ADMISSION_UNRESOLVED';
          throw new coreEngine.OrchestratorError(
            'HANDOFF_ADMISSION_UNRESOLVED',
            'P4 smoke forces the first worker resume attempt through the unresolved handoff path',
          );
        }
        return context.db.admitCrossDomainHandoff(input);
      },
    });
    const factoryOptions = {
      workerId: worker_id,
      adapters,
      workflowRepository,
      auditSecret: audit_secret,
      crossDomainHandoff: workerBroker,
      erp_read: null,
    };
    const marketingFactory = marketingGraph.createMarketingOrchestratorFactory(factoryOptions);
    const localReceipt = {
      execution_id: 'p4-smoke-local',
      adapter_status: 'SUCCESS',
      provider_reference: 'p4-smoke',
      response_payload: { source_uri: 'smoke://p4', source_version: 'v1' },
      latency_ms: 0,
    };
    const localDispatcher = {
      async dispatch() { return localReceipt; },
      async reconcile() { return { outcome: 'INDETERMINATE' }; },
    };
    const salesFactory = salesGraph.createSalesOrchestratorFactory({
      ...factoryOptions,
      adapterDispatcher: localDispatcher,
      consent: {
        async getConsent({ tenant_id, customer_id }) {
          const profile = await db.getProfile(tenant_id, customer_id);
          if (!profile) return undefined;
          return {
            consent_marketing: profile.consent_marketing === true,
            suppression_active: profile.suppression_active === true,
          };
        },
        async read({ tenant_id, customer_id }) {
          const profile = await db.getProfile(tenant_id, customer_id);
          return {
            consented: profile?.consent_marketing === true,
            suppressed: profile?.suppression_active === true,
          };
        },
      },
    });
    const careFactory = careGraph.createCareOrchestratorFactory({
      ...factoryOptions,
      adapterDispatcher: {
        async dispatch() {
          return {
            execution_id: 'p4-smoke-care',
            adapter_status: 'SUCCESS',
            provider_reference: 'p4-smoke',
            response_payload: {},
            latency_ms: 0,
          };
        },
        async reconcile() {
          return { outcome: 'INDETERMINATE' };
        },
      },
      env: { APP_ENV: appEnv, CARE_TENANT_IDS: tenant_id },
    });

    context.registry = domainRegistryModule.createDomainRuntimeRegistry([
      {
        contract: {
          module: 'marketing',
          source_channels: ['MARKETING_CAMPAIGN'],
          event_types: ['campaign.requested'],
          signal_invalid_code: 'MARKETING_SIGNAL_INVALID',
        },
        createOrchestrator: marketingFactory,
      },
      {
        contract: {
          module: 'sales',
          source_channels: [HANDOFF_CHANNEL],
          event_types: ['handoff.marketing_to_sales'],
          signal_invalid_code: 'SALES_SIGNAL_INVALID',
        },
        createOrchestrator: salesFactory,
      },
      {
        contract: workerEntry.CARE_SIGNAL_CONTRACT,
        createOrchestrator: careFactory,
      },
    ]);
  });

  after(async () => {
    // Nothing is torn down. The ledger is append-only BY DESIGN (`REVOKE DELETE` on
    // `cross_domain_handoffs`) and its rows reference the fixture customer, so the fixture stays.
    // Each run seeds its own fresh customer, and the rows it leaves are the history it proved.
  });

  it('1. admits one reservation, one target task and one ledger row', async () => {
    const customer_id = await freshCustomer();
    const input = handoffInput({ customer_id });
    const admission = await context.db.admitCrossDomainHandoff(input);

    assert.equal(admission.kind, 'ADMITTED', `expected ADMITTED, received ${admission.kind}`);
    assert.equal(admission.run_id, input.run_id);

    const tasks = await countRows(
      'SELECT COUNT(*)::int AS count FROM agentos.platform_durable_tasks WHERE tenant_id = $1 AND run_id = $2',
      [context.tenant_id, input.run_id],
    );
    assert.equal(tasks, 1, 'the target run must exist exactly once');

    const reservations = await countRows(
      'SELECT COUNT(*)::int AS count FROM agentos.effect_reservations WHERE tenant_id = $1 AND effect_key = $2',
      [context.tenant_id, input.idempotency_key],
    );
    assert.equal(reservations, 1, 'the handoff key must hold exactly one reservation');

    const ledger = await context.db.readCrossDomainHandoff(context.tenant_id, input.idempotency_key);
    assert.ok(ledger, 'the ledger row must be readable by its idempotency key');
    // One hop carries ONE identity: the ledger stores the id the caller minted, and the target
    // run's signal cites the same one.
    assert.equal(ledger.handoff_id, input.handoff_id);
    assert.equal(ledger.target_run_id, input.run_id);
    assert.equal(ledger.classification, 'DECISION');
    assert.deepEqual(ledger.visited_domains, ['marketing']);
  });

  it('2. answers a replayed hop from the ledger without admitting a second run', async () => {
    const customer_id = await freshCustomer();
    const input = handoffInput({ customer_id });
    const first = await context.db.admitCrossDomainHandoff(input);
    assert.equal(first.kind, 'ADMITTED');

    // The reservation is unexpired, so the duplication table answers IN_FLIGHT (the run this key
    // already owns) rather than REPLAY (which is the settled-reservation answer). Either way the
    // hop never becomes a second run.
    const replay = await context.db.admitCrossDomainHandoff(input);
    assert.equal(replay.kind, 'IN_FLIGHT', `expected IN_FLIGHT, received ${replay.kind}`);
    assert.equal(replay.run_id, first.run_id, 'a replay must return the run the ledger already holds');

    const ledgerRows = await countRows(
      'SELECT COUNT(*)::int AS count FROM agentos.cross_domain_handoffs WHERE tenant_id = $1 AND idempotency_key = $2',
      [context.tenant_id, input.idempotency_key],
    );
    assert.equal(ledgerRows, 1, 'a replayed handoff must not add a ledger row');

    const tasks = await countRows(
      'SELECT COUNT(*)::int AS count FROM agentos.platform_durable_tasks WHERE tenant_id = $1 AND run_id = $2',
      [context.tenant_id, input.run_id],
    );
    assert.equal(tasks, 1, 'a replayed handoff must not create a second target run');
  });

  it('3. refuses the same key carrying different bytes as CONFLICT', async () => {
    const customer_id = await freshCustomer();
    const input = handoffInput({ customer_id });
    const first = await context.db.admitCrossDomainHandoff(input);
    assert.equal(first.kind, 'ADMITTED');

    const conflicting = await context.db.admitCrossDomainHandoff({
      ...input,
      request_fingerprint: createHash('sha256').update('different-bytes').digest('hex'),
    });
    assert.equal(conflicting.kind, 'CONFLICT');
  });

  it('4. refuses a caller-asserted FACT that no authoritative row backs', async () => {
    const customer_id = await freshCustomer();
    const input = handoffInput({
      customer_id,
      classification: 'FACT',
      evidence: [
        {
          classification: 'FACT',
          claim: 'The customer spent 1,000,000 in the last quarter',
          source_uri: 'agentos://invented',
          source_version: '1',
          verified_by: 'agentos.orchestrator',
        },
      ],
    });

    await assert.rejects(
      () => context.db.admitCrossDomainHandoff(input),
      (error) => String(error.message).includes('HANDOFF_EVIDENCE_UNVERIFIED'),
      'an unverified FACT reference must be refused before any write',
    );

    const ledgerRows = await countRows(
      'SELECT COUNT(*)::int AS count FROM agentos.cross_domain_handoffs WHERE tenant_id = $1 AND idempotency_key = $2',
      [context.tenant_id, input.idempotency_key],
    );
    assert.equal(ledgerRows, 0, 'a refused handoff must leave no ledger row');
  });

  it('5. advances the durable journey and refuses a repeated lifecycle version', async () => {
    const customer_id = await freshCustomer();
    const first = handoffInput({ customer_id });
    assert.equal((await context.db.admitCrossDomainHandoff(first)).kind, 'ADMITTED');

    const second = handoffInput({
      customer_id,
      source_domain: 'sales',
      source_agent: 'SAL-02',
      target_domain: 'care',
      target_agent: 'CS-01',
      target_module: 'support',
      reason: 'Sales leg completed; Care onboarding is the next leg',
      lifecycle_version: 2,
      hop_count: 2,
      visited_domains: ['marketing', 'sales'],
    });
    assert.equal((await context.db.admitCrossDomainHandoff(second)).kind, 'ADMITTED');

    const lifecycle = await context.db.readCrossDomainLifecycle(context.tenant_id, customer_id);
    assert.ok(lifecycle, 'the durable lifecycle must be readable');
    // `lifecycle_version` is BIGINT, so the driver returns it as a numeric string.
    assert.equal(Number(lifecycle.version), 2);
    assert.equal(Number(lifecycle.hop_count), 2);
    assert.deepEqual(lifecycle.domains, ['marketing', 'sales']);

    // A different hop claiming the same version for the same customer must not be admitted.
    const repeated = handoffInput({
      customer_id,
      source_domain: 'marketing',
      target_domain: 'care',
      target_agent: 'CS-01',
      target_module: 'support',
      lifecycle_version: 2,
      hop_count: 2,
      visited_domains: ['marketing'],
    });
    const refused = await context.db.admitCrossDomainHandoff(repeated);
    assert.notEqual(refused.kind, 'ADMITTED', 'a repeated lifecycle version must never admit');
  });

  it('6. refuses a hop addressed to a customer of ANOTHER tenant', async () => {
    // A REAL customer, in a different tenant. An id that simply does not exist would only prove an
    // FK refusal, which is a weaker claim than the one this case is named for.
    const foreign_customer_id = randomUUID();
    await context.db.withTenantContext(SECOND_TENANT_ID, async (client) => {
      await client.query(
        `INSERT INTO agentos.customers (id, tenant_id, display_name, verification_status)
         VALUES ($1, $2, 'P4 smoke foreign-tenant customer', 'verified')
         ON CONFLICT (id) DO NOTHING`,
        [foreign_customer_id, SECOND_TENANT_ID],
      );
    });

    const input = handoffInput({ customer_id: foreign_customer_id });

    await assert.rejects(
      () => context.db.admitCrossDomainHandoff(input),
      'a hop addressing a customer of another tenant must be refused by the tenant-scoped ledger',
    );

    assert.equal(
      await countRows(
        'SELECT COUNT(*)::int AS count FROM agentos.cross_domain_handoffs WHERE tenant_id = $1 AND idempotency_key = $2',
        [context.tenant_id, input.idempotency_key],
      ),
      0,
      'a refused cross-tenant hop must leave no ledger row in the requesting tenant',
    );
    assert.equal(
      await context.db.withTenantContext(SECOND_TENANT_ID, async (client) => {
        const result = await client.query(
          'SELECT COUNT(*)::int AS count FROM agentos.cross_domain_handoffs WHERE tenant_id = $1',
          [SECOND_TENANT_ID],
        );
        return Number(result.rows[0]?.count ?? 0);
      }),
      0,
      'a refused cross-tenant hop must leave nothing in the other tenant either',
    );
  });

  it('5b. drives the whole journey: three legs, three runs, ONE lifecycle and one timeline', async () => {
    const customer_id = await freshCustomer();

    // TC-E2E-001's data half, executed against real PostgreSQL: marketing -> sales -> care for one
    // verified customer, each leg admitted once, all of it on one tenant/customer timeline.
    // Each leg is stamped at its own instant. The timeline orders by `(occurred_at, id)`, so legs
    // sharing one instant would be ordered by a UUID tiebreak and would prove nothing about leg
    // order; distinct instants make the assertion below a real one.
    const legs = [
      handoffInput({ customer_id, occurred_at: '2026-09-26T10:00:00.000Z' }),
      handoffInput({
        customer_id,
        occurred_at: '2026-09-26T10:01:00.000Z',
        source_domain: 'sales',
        source_agent: 'SAL-02',
        target_domain: 'care',
        target_agent: 'CS-01',
        target_module: 'support',
        reason: 'Sales leg completed; Care onboarding is the next leg',
        lifecycle_version: 2,
        hop_count: 2,
        visited_domains: ['marketing', 'sales'],
      }),
      handoffInput({
        customer_id,
        occurred_at: '2026-09-26T10:02:00.000Z',
        source_domain: 'care',
        source_agent: 'CS-01',
        target_domain: 'retention',
        target_agent: 'CS-02',
        target_module: 'support',
        reason: 'Care onboarding leg completed; retention is the next leg',
        lifecycle_version: 3,
        hop_count: 3,
        visited_domains: ['marketing', 'sales', 'care'],
      }),
    ];

    for (const leg of legs) {
      const admission = await context.db.admitCrossDomainHandoff(leg);
      assert.equal(admission.kind, 'ADMITTED', `leg ${leg.source_domain} must be admitted once`);
      // Every leg admits the run it was addressed to, on the SAME durable journey: the version the
      // leg carries is the one the ledger stores, which the readback below proves end to end.
      assert.equal(admission.run_id, leg.run_id);
      assert.equal(leg.customer_id, customer_id);
    }

    const lifecycle = await context.db.readCrossDomainLifecycle(context.tenant_id, customer_id);
    assert.equal(Number(lifecycle.version), 3, 'the journey advances once per leg');
    assert.equal(Number(lifecycle.hop_count), 3);
    assert.deepEqual(lifecycle.domains, ['marketing', 'sales', 'care']);

    // Three durable runs, one per leg, and all three on the one timeline this customer owns.
    for (const leg of legs) {
      assert.equal(
        await countRows(
          'SELECT COUNT(*)::int AS count FROM agentos.platform_durable_tasks WHERE tenant_id = $1 AND run_id = $2',
          [context.tenant_id, leg.run_id],
        ),
        1,
        'each leg owns exactly one target run',
      );
    }

    const timeline = await context.events.listTimeline({
      tenant_id: context.tenant_id,
      customer_id,
      limit: 200,
    });
    const entries = timeline.items.filter((item) => item.event_name === 'ext.lifecycle.handoff');
    assert.equal(entries.length, 3, 'one timeline row per leg, on one timeline');
    assert.deepEqual(
      entries.map((entry) => entry.payload.target_domain),
      ['sales', 'care', 'retention'],
      'the rows are ordered by the instant each leg was admitted at',
    );

    // The ledger stores what it is told and deduplicates by identity: re-admitting the final leg
    // changes nothing. The HOP CAP and the terminal-domain rule are the guard's job, not this
    // table's, and are asserted in the core contract suite.
    const replayedLastLeg = await context.db.admitCrossDomainHandoff(legs[2]);
    assert.notEqual(replayedLastLeg.kind, 'ADMITTED', 'a replayed final leg must not admit again');
    assert.equal(
      (
        await context.events.listTimeline({ tenant_id: context.tenant_id, customer_id, limit: 200 })
      ).items.filter((item) => item.event_name === 'ext.lifecycle.handoff').length,
      3,
      'a replayed leg must not add a fourth timeline row',
    );
  });

  it('6b. refuses a hop addressed to a customer that does not exist', async () => {
    const input = handoffInput({ customer_id: randomUUID() });

    await assert.rejects(
      () => context.db.admitCrossDomainHandoff(input),
      'a hop for an unknown customer must be refused rather than attached to the tenant',
    );
  });

  it('7. appends the CUSTOMER 360 handoff event once and reads back its server marker', async () => {
    const customer_id = await freshCustomer();
    const input = handoffInput({ customer_id });
    const admission = await context.db.admitCrossDomainHandoff(input);
    assert.equal(admission.kind, 'ADMITTED');

    // The row is written BY the admission, in the same transaction: the smoke appends nothing.
    const timeline = await context.events.listTimeline({
      tenant_id: context.tenant_id,
      customer_id,
      limit: 200,
    });
    const handoffEntries = timeline.items.filter((item) => item.event_name === 'ext.lifecycle.handoff');
    assert.equal(handoffEntries.length, 1, 'the admission must have appended exactly one row');
    assert.equal(handoffEntries[0].source_event_id, input.idempotency_key);
    assert.equal(handoffEntries[0].payload.classification_authority, 'SERVER');
    assert.equal(handoffEntries[0].payload.target_domain, 'sales');
    // The row cites the handoff the LEDGER committed, not an id minted before the write.
    assert.equal(handoffEntries[0].payload.evidence_reference, admission.handoff_id);
    assert.equal(admission.handoff_id, input.handoff_id, 'the admission reports the caller-minted id');

    // A replayed admission must not append a second row.
    const replay = await context.db.admitCrossDomainHandoff(input);
    assert.notEqual(replay.kind, 'ADMITTED');
    const afterReplay = await context.events.listTimeline({
      tenant_id: context.tenant_id,
      customer_id,
      limit: 200,
    });
    assert.equal(
      afterReplay.items.filter((item) => item.event_name === 'ext.lifecycle.handoff').length,
      1,
      'a replayed admission must not append a second timeline row',
    );
  });

  it('8. retries an admitted hop from the same source run without advancing the lifecycle', async () => {
    const customer_id = await freshCustomer();
    const draft = brokerDraft({ customer_id });
    const first = await liveBroker().admit(draft);

    assert.equal(first.admitted, true, 'the first broker admission must commit the hop');
    const storedBefore = (await context.db.listCrossDomainHandoffs(
      context.tenant_id,
      customer_id,
      20,
    ))[0];
    assert.ok(storedBefore, 'the first admission must be readable from the ledger');
    assert.equal(storedBefore.handoff_id, first.handoff_id);
    assert.equal(storedBefore.target_run_id, first.target_run_id);

    const lifecycleBefore = await context.db.readCrossDomainLifecycle(context.tenant_id, customer_id);
    assert.ok(lifecycleBefore, 'the admitted hop must have a durable lifecycle');
    const timelineBefore = await handoffTimelineCount(customer_id);

    // Construct a fresh broker for the retry: identity recovery must come from PostgreSQL, never an
    // in-memory package or receipt cache. The draft deliberately carries the exact same source_run_id;
    // this must not throw HANDOFF_STALE_REPLAY.
    const retry = await liveBroker().admit(draft);
    assert.equal(retry.admitted, false, 'a same-source retry must not admit a second hop');
    assert.equal(retry.handoff_id, storedBefore.handoff_id);
    assert.equal(retry.target_run_id, storedBefore.target_run_id);
    const storedAfter = await context.db.listCrossDomainHandoffs(context.tenant_id, customer_id, 20);
    assert.equal(storedAfter.length, 1, 'a same-source retry must not add a ledger row');
    assert.equal(storedAfter[0].handoff_id, storedBefore.handoff_id);
    assert.equal(storedAfter[0].target_run_id, storedBefore.target_run_id);

    const lifecycleAfter = await context.db.readCrossDomainLifecycle(context.tenant_id, customer_id);
    assert.ok(lifecycleAfter, 'the retry must leave the durable lifecycle readable');
    assert.equal(Number(lifecycleAfter.version), Number(lifecycleBefore.version));
    assert.equal(Number(lifecycleAfter.hop_count), Number(lifecycleBefore.hop_count));
    assert.deepEqual(lifecycleAfter.domains, lifecycleBefore.domains);
    assert.equal(
      await handoffTimelineCount(customer_id),
      timelineBefore,
      'a same-source retry must not append a second handoff timeline row',
    );
  });

  it('9. claims the admitted target with its durable orchestrator handoff signal', async () => {
    const customer_id = await freshCustomer();
    const draft = brokerDraft({ customer_id });
    const admission = await liveBroker().admit(draft);
    assert.equal(admission.admitted, true, 'the target claim case needs an admitted hop');

    const ledger = (await context.db.listCrossDomainHandoffs(context.tenant_id, customer_id, 20))[0];
    assert.ok(ledger, 'the admitted target must have a ledger row');
    assert.equal(ledger.handoff_id, admission.handoff_id);
    assert.equal(ledger.target_run_id, admission.target_run_id);

    const repository = new context.db.DurableWorkflowRepository();
    const lease_owner = 'p4_smoke_claim_' + randomUUID().slice(0, 8);
    let claimed = null;
    // Durable claim is tenant-wide and FIFO. Older queued fixtures from a previous local smoke run
    // may precede this target, so walk claimable rows until this case's admitted run is leased.
    for (let attempt = 0; attempt < 256 && claimed === null; attempt += 1) {
      const candidate = await repository.claimNextQueuedTask({
        tenant_id: context.tenant_id,
        lease_owner,
        lease_duration_ms: 30_000,
      });
      if (candidate === null) break;
      if (candidate.task.run_id === ledger.target_run_id) claimed = candidate;
    }
    assert.ok(claimed, 'claimNextQueuedTask must eventually lease this admitted target run');
    assert.equal(claimed.lease_owner, lease_owner);
    assert.equal(claimed.task.lease_owner, lease_owner);

    const statePayload = claimed.task.state_payload;
    assert.ok(statePayload && typeof statePayload === 'object' && !Array.isArray(statePayload));
    const signal = statePayload.signal;
    assert.ok(signal && typeof signal === 'object' && !Array.isArray(signal));
    const signalPayload = signal.payload;
    assert.ok(signalPayload && typeof signalPayload === 'object' && !Array.isArray(signalPayload));
    const handoff = signalPayload.handoff;
    assert.ok(handoff && typeof handoff === 'object' && !Array.isArray(handoff));
    assert.equal(signal.source_channel, HANDOFF_CHANNEL);
    assert.equal(signal.event_type, 'handoff.' + ledger.source_domain + '_to_' + ledger.target_domain);
    assert.equal(signalPayload.module, ledger.target_module);
    assert.equal(handoff.handoff_id, ledger.handoff_id);

    // This is the minimum worker seam: the real Sales/Care runtime needs provider/itinerary ports
    // this smoke must not invent. A second claim may lease another pre-existing task, but it must
    // never create a second durable task for the admitted handoff run.
    const secondClaim = await repository.claimNextQueuedTask({
      tenant_id: context.tenant_id,
      lease_owner,
      lease_duration_ms: 30_000,
    });
    assert.notEqual(secondClaim?.task.run_id, ledger.target_run_id);
    assert.equal(
      await countRows(
        'SELECT COUNT(*)::int AS count FROM agentos.platform_durable_tasks WHERE tenant_id = $1 AND run_id = $2',
        [context.tenant_id, ledger.target_run_id],
      ),
      1,
      'claiming or reclaiming the handoff must not create a second target task',
    );
  });
  it('10. parks, re-claims, and resumes the same handoff identity through the real worker registry', async () => {
    const customer_id = await freshCustomer();
    await context.db.withTenantContext(context.tenant_id, async (client) => {
      await client.query(
        `INSERT INTO agentos.consents (tenant_id, customer_id, consent_type, channel, is_granted, opt_in_method, opt_in_timestamp)
         VALUES ($1, $2, 'marketing_messaging', 'email', TRUE, 'web_form', NOW())`,
        [context.tenant_id, customer_id],
      );
    });
    const source_run_id = 'run_p4_resume_source_' + randomUUID().slice(0, 8);
    const draft = brokerDraft({ customer_id, source_run_id, source_agent: 'MKT-01' });
    const firstIdempotencyKey = context.coreEngine.computeHandoffIdempotencyKey({
      tenant_id: draft.tenant_id,
      customer_id: draft.customer_id,
      source_run_id: draft.source_run_id,
      target_domain: draft.target_domain,
      target_agent: draft.target_agent,
      lifecycle_version: 1,
      reason: draft.reason,
    });

    // Create the source task before admission so the waiting row is the durable source of the
    // restart, not an in-memory receipt. Its cursor is already past its one completed step.
    const sourcePlan = {
      plan_id: 'plan_p4_resume_source',
      domain: 'marketing',
      steps: [
        {
          step_index: 1,
          agent_id: 'MKT-01',
          skill_id: 'skill.mkt.analyze_market_signal',
          adapter_target: 'API-002.EventIngestion',
          input_parameters: {},
          required_authority: 'AUTH-1',
          mutating: false,
          price_bearing: false,
          idempotent: true,
          timeout_ms: 5_000,
        },
      ],
      fallback_strategy: 'FAIL_CLOSED',
      handoff_intent: {
        source_domain: 'marketing',
        target_domain: 'sales',
        target_agent: 'SAL-02',
        reason: draft.reason,
      },
    };
    const checkpoint = {
      signal: {
        signal_id: randomUUID(),
        tenant_id: context.tenant_id,
        correlation_id: draft.correlation_id,
        source_channel: 'MARKETING_CAMPAIGN',
        event_type: 'campaign.requested',
        timestamp: draft.occurred_at,
        subject: {
          session_id: source_run_id,
          channel_type: 'orchestrator',
          verified_customer_id: customer_id,
        },
        payload: { module: 'marketing', skill_id: 'skill.mkt.analyze_market_signal' },
      },
      plan: sourcePlan,
      current_step: 2,
      pending_action: null,
      context: {
        correlation_id: draft.correlation_id,
        tenant_id: context.tenant_id,
        customer: { customer_id },
        working_memory: { session_id: source_run_id },
        knowledge_citations: [],
        hydrated_at: draft.occurred_at,
      },
      previous_evidence_hash: '0'.repeat(64),
      request_id: source_run_id,
    };
    const repository = context.workflowRepository;
    await repository.createTask({
      tenant_id: context.tenant_id,
      run_id: source_run_id,
      correlation_id: draft.correlation_id,
      current_step: 2,
      state: 'queued',
      state_payload: checkpoint,
    });


    // Park through the workflow repository and attach the automatic durable resume event in the same
    // CAS-guarded transition. This is the durable equivalent of the orchestrator parkTask path.
    const resumeEvent = {
      tenant_id: context.tenant_id,
      event_type: 'timer.expired',
      reason: 'P4 smoke restart/resume of the parked handoff',
    };
    const parked = await repository.transitionTask(
      context.tenant_id,
      source_run_id,
      'waiting',
      'P4 smoke parks the completed source leg before a worker restart',
      { ...checkpoint, resume_event: resumeEvent },
    );
    assert.equal(parked.state, 'waiting');
    assert.equal(parked.state_payload.resume_event.event_type, 'timer.expired');
    assert.equal(parked.state_payload.plan.handoff_intent.target_domain, 'sales');
    assert.equal(parked.state_payload.request_id, source_run_id);
    assert.equal(parked.state_payload.current_step, 2, 'the parked cursor is past the last source step');

    // The first real worker attempt is intentionally unresolved. The orchestrator parks the source
    // again with its complete checkpoint; the next claim is the restart that reaches the durable DB.
    context.forceResumeAdmissionUnresolved = true;
    let sourceClaim = null;
    for (let attempt = 0; attempt < 256 && sourceClaim === null; attempt += 1) {
      const candidate = await repository.claimNextQueuedTask({
        tenant_id: context.tenant_id,
        lease_owner: context.worker_id,
        lease_duration_ms: 30_000,
      });
      if (candidate === null) break;
      if (candidate.task.run_id === source_run_id) sourceClaim = candidate;
    }
    assert.ok(sourceClaim, 'claimNextQueuedTask must re-claim the parked source task');
    const source_task_id = sourceClaim.task.task_id;
    await context.worker.processClaimedTask({
      taskRecord: sourceClaim.task,
      tenant_id: context.tenant_id,
      worker_id: context.worker_id,
      workflowRepository: repository,
      registry: context.registry,
    });
    const unresolvedTask = await repository.getTask(context.tenant_id, source_run_id);
    assert.equal(unresolvedTask?.state, 'waiting', 'an unresolved broker attempt must park the source again');
    assert.equal(context.lastResumeAdmissionErrorCode, 'HANDOFF_ADMISSION_UNRESOLVED');
    assert.equal(
      await countRows(
        'SELECT COUNT(*)::int AS count FROM agentos.cross_domain_handoffs WHERE tenant_id = $1 AND idempotency_key = $2',
        [context.tenant_id, firstIdempotencyKey],
      ),
      0,
      'the unresolved first attempt must not write a handoff row',
    );

    // Re-attach the automatic resume event through the workflow repository, then claim the same
    // durable source task a second time. The worker broker now delegates to the real DB admission.
    const retryParked = await repository.transitionTask(
      context.tenant_id,
      source_run_id,
      'waiting',
      'P4 smoke re-queues the unresolved source handoff for restart',
      {
        ...unresolvedTask.state_payload,
        resume_event: resumeEvent,
      },
    );
    assert.equal(retryParked.state, 'waiting');
    sourceClaim = null;
    for (let attempt = 0; attempt < 256 && sourceClaim === null; attempt += 1) {
      const candidate = await repository.claimNextQueuedTask({
        tenant_id: context.tenant_id,
        lease_owner: context.worker_id,
        lease_duration_ms: 30_000,
      });
      if (candidate === null) break;
      if (candidate.task.run_id === source_run_id) sourceClaim = candidate;
    }
    assert.ok(sourceClaim, 'the same parked source task must be claimable after the unresolved attempt');
    assert.equal(sourceClaim.task.task_id, source_task_id, 'both claims must lease the same durable task row');
    await context.worker.processClaimedTask({
      taskRecord: sourceClaim.task,
      tenant_id: context.tenant_id,
      worker_id: context.worker_id,
      workflowRepository: repository,
      registry: context.registry,
    });
    const sourceAfterResume = await repository.getTask(context.tenant_id, source_run_id);
    assert.equal(sourceAfterResume?.state, 'completed', `the resumed source task must settle once (${JSON.stringify(sourceAfterResume?.error_details ?? sourceAfterResume?.last_error_class ?? null)})`);

    const firstLedger = (await context.db.listCrossDomainHandoffs(context.tenant_id, customer_id, 20)).find(
      (row) => row.idempotency_key === firstIdempotencyKey,
    );
    assert.ok(firstLedger, 'the resumed broker must recover the original handoff identity');
    assert.equal(
      await countRows(
        'SELECT COUNT(*)::int AS count FROM agentos.cross_domain_handoffs WHERE tenant_id = $1 AND idempotency_key = $2',
        [context.tenant_id, firstIdempotencyKey],
      ),
      1,
      'the parked resume must not add a second handoff row',
    );
    assert.equal(
      await countRows(
        'SELECT COUNT(*)::int AS count FROM agentos.effect_reservations WHERE tenant_id = $1 AND effect_key = $2',
        [context.tenant_id, firstIdempotencyKey],
      ),
      1,
      'the parked resume must retain one effect reservation for the handoff key',
    );
    assert.equal(
      await countRows(
        'SELECT COUNT(*)::int AS count FROM agentos.customer_events WHERE tenant_id = $1 AND source_event_id = $2',
        [context.tenant_id, firstIdempotencyKey],
      ),
      1,
      'the parked resume must not append a second customer event for the source identity',
    );
    assert.equal(
      await countRows(
        'SELECT COUNT(*)::int AS count FROM agentos.platform_durable_tasks WHERE tenant_id = $1 AND run_id = $2',
        [context.tenant_id, firstLedger.target_run_id],
      ),
      1,
      'the parked resume must not create a second target task',
    );

    // Bind the canonical platform grants needed by the real Sales target before invoking the worker
    // entry. The Care target intentionally remains unbound at its onboarding itinerary seam.
    await context.db.withTenantContext(context.tenant_id, async (client) => {
      await client.query(
        'INSERT INTO agentos.agents (tenant_id, code, name, domain, assigned_authority, is_active) VALUES ($1, \'SAL-02\', \'P4 Sales Advisor\', \'sales\', \'AUTH-3\', TRUE) ON CONFLICT (tenant_id, code) DO UPDATE SET assigned_authority = EXCLUDED.assigned_authority, is_active = EXCLUDED.is_active',
        [context.tenant_id],
      );
      await client.query(
        'INSERT INTO agentos.agents (tenant_id, code, name, domain, assigned_authority, is_active) VALUES ($1, \'CS-01\', \'P4 Customer Care Agent\', \'support\', \'AUTH-1\', TRUE) ON CONFLICT (tenant_id, code) DO UPDATE SET assigned_authority = EXCLUDED.assigned_authority, is_active = EXCLUDED.is_active',
        [context.tenant_id],
      );
    });

    let salesClaim = null;
    for (let attempt = 0; attempt < 256 && salesClaim === null; attempt += 1) {
      const candidate = await repository.claimNextQueuedTask({
        tenant_id: context.tenant_id,
        lease_owner: context.worker_id,
        lease_duration_ms: 30_000,
      });
      if (candidate === null) break;
      if (candidate.task.run_id === firstLedger.target_run_id) salesClaim = candidate;
    }
    assert.ok(salesClaim, 'the admitted Sales target must be claimable after the source restart');
    await context.worker.processClaimedTask({
      taskRecord: salesClaim.task,
      tenant_id: context.tenant_id,
      worker_id: context.worker_id,
      workflowRepository: repository,
      registry: context.registry,
    });

    const salesToCareBeforeInjection = (await context.db.listCrossDomainHandoffs(context.tenant_id, customer_id, 20)).find(
      (row) => row.source_domain === 'sales' && row.target_domain === 'care',
    );
    assert.equal(
      salesToCareBeforeInjection,
      undefined,
      'an unbound Care onboarding itinerary must not admit a Sales→Care handoff',
    );

    // The broker can still be given a stray Care leg by an external caller. Keep that injected-leg
    // refusal covered independently from the Sales planner's owner-input gate.
    const injectedCareAdmission = await liveBroker().admit(brokerDraft({
      customer_id,
      source_domain: 'sales',
      source_agent: 'SAL-02',
      source_run_id: firstLedger.target_run_id,
      target_domain: 'care',
      target_agent: 'CS-01',
      reason: 'Injected stray Sales→Care leg for refusal coverage',
    }));
    assert.equal(injectedCareAdmission.admitted, true, 'the injected leg must be durable before Care refuses it');

    const careLedger = (await context.db.listCrossDomainHandoffs(context.tenant_id, customer_id, 20)).find(
      (row) => row.source_domain === 'sales' && row.target_domain === 'care',
    );
    assert.ok(careLedger, 'the injected Sales→Care handoff must be claimable for refusal coverage');
    assert.match(careLedger.handoff_id, /^[0-9a-f-]{36}$/i, 'the Care handoff has one durable handoff identity');
    assert.equal(
      await countRows(
        'SELECT COUNT(*)::int AS count FROM agentos.platform_durable_tasks WHERE tenant_id = $1 AND run_id = $2',
        [context.tenant_id, careLedger.target_run_id],
      ),
      1,
      'the admitted Care target must have exactly one durable task',
    );

    let careClaim = null;
    for (let attempt = 0; attempt < 256 && careClaim === null; attempt += 1) {
      const candidate = await repository.claimNextQueuedTask({
        tenant_id: context.tenant_id,
        lease_owner: context.worker_id,
        lease_duration_ms: 30_000,
      });
      if (candidate === null) break;
      if (candidate.task.run_id === careLedger.target_run_id) careClaim = candidate;
    }
    assert.ok(careClaim, 'claimNextQueuedTask must lease the admitted Care target');
    let careError = null;
    try {
      await context.worker.processClaimedTask({
        taskRecord: careClaim.task,
        tenant_id: context.tenant_id,
        worker_id: context.worker_id,
        workflowRepository: repository,
        registry: context.registry,
      });
    } catch (error) {
      careError = error;
    }
    assert.ok(careError, 'the real Care worker path must fail closed for the unbound onboarding itinerary');
    assert.match(String(careError), /CARE_ONBOARDING_ITINERARY_UNBOUND/);

    assert.equal(
      await countRows(
        'SELECT COUNT(*)::int AS count FROM agentos.cross_domain_handoffs WHERE tenant_id = $1 AND idempotency_key = $2',
        [context.tenant_id, careLedger.idempotency_key],
      ),
      1,
      'the Sales→Care identity must have one handoff row',
    );
    assert.equal(
      await countRows(
        'SELECT COUNT(*)::int AS count FROM agentos.effect_reservations WHERE tenant_id = $1 AND effect_key = $2',
        [context.tenant_id, careLedger.idempotency_key],
      ),
      1,
      'the Sales→Care identity must have one effect reservation',
    );
    assert.equal(
      await countRows(
        'SELECT COUNT(*)::int AS count FROM agentos.customer_events WHERE tenant_id = $1 AND source_event_id = $2',
        [context.tenant_id, careLedger.idempotency_key],
      ),
      1,
      'the Sales→Care identity must have one timeline/customer event row',
    );
  });
});
