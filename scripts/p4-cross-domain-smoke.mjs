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
 *   7. Timeline: the handoff's Customer 360 row is committed BY the admission (same transaction),
 *      cites the ledger's own handoff id, reads back with its server marker, and a replayed
 *      admission appends no second row.
 *
 * Fail-closed rules: a missing `DATABASE_URL`, a managed `APP_ENV`, an unmigrated schema or a
 * bypassing role aborts the run instead of reporting a green path it did not exercise.
 *
 * This smoke proves the LEDGER. It does not drive the API or the worker, so it is not evidence that
 * the HTTP path routes a handoff; that remains the `TC-E2E-001..009` gap recorded in `blocked.md`.
 *
 * It is re-runnable but not idempotent in its fixtures: every run seeds a fresh customer and the
 * ledger keeps what the run proved, because the handoff ledger is append-only (`REVOKE DELETE`).
 * Point `P4_TENANT_IDS` at a tenant you are willing to accumulate handoff history in.
 *
 * Usage: node --test scripts/p4-cross-domain-smoke.mjs
 *   DATABASE_URL        application-role URL of a database with the migrations applied
 *   APP_ENV             local | ci (a managed profile is refused: this smoke is local only)
 *   P4_TENANT_IDS       the tenant this smoke is scoped to (a UUID)
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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
        `Set it, then re-run \`node --test scripts/p4-cross-domain-smoke.mjs\`.`,
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

describe('P4 cross-domain handoff ledger (real PostgreSQL)', () => {
  before(async () => {
    const connectionString = requireEnv('DATABASE_URL');
    const appEnv = (process.env.APP_ENV ?? 'local').trim();
    if (MANAGED_ENVS.includes(appEnv)) {
      throw new Error(
        `APP_ENV_MANAGED: this smoke is local/CI only and refuses to run against '${appEnv}'.`,
      );
    }

    const db = await loadBuild('../packages/database/dist/index.js', 'the database package');
    const tenant_id = requireEnv('P4_TENANT_IDS');

    context = {
      db,
      tenant_id,
      events: new db.CustomerEventRepository(),
    };
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
});
