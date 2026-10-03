import { createHash, randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getPlatformPool, getPool } from './client.js';
import { withTenantContext } from './rls.js';
import {
  P5AutonomyRepository,
  P5ProvisioningRepository,
  RunResponseRepository,
  type CommitAutonomyPolicyInput,
  type TenantTransactionRunner,
} from './repositories/index.js';

const SKILL = 'skill.sales.check_stock';
const VERSION = 'v1';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const provisioning = new P5ProvisioningRepository();
const autonomy = new P5AutonomyRepository();
const keyA = digest(`p5-live-a-${randomUUID()}`);
const keyB = digest(`p5-live-b-${randomUUID()}`);
const fingerprintA = digest('P5 live tenant A');
const fingerprintB = digest('P5 live tenant B');
let tenantA: string;
let tenantB: string;
let restartedPool: Pool | undefined;

function policyInput(tenant_id: string): CommitAutonomyPolicyInput {
  return {
    tenant_id,
    skill_id: SKILL,
    policy_version: VERSION,
    policy_id: randomUUID(),
    state: 'MINIMUM',
    previous_approved_state: 'MINIMUM',
    evidence_window_ref: null,
    approver_id: null,
    reason: 'Safe minimum before promotion',
    parameters: { required_authority: 'AUTH-0' },
    provenance: { source: 'SERVER_POLICY' },
    effective_at: new Date().toISOString(),
    rollback_policy_version: VERSION,
    rollback_state: 'MINIMUM',
    audit_ref: null,
    evidence_ref: null,
  };
}

// A new connection pool and repository instance exercises the durable restart boundary.
// Match the production binder's transaction-local role and tenant context on this fresh pool.
function runnerFrom(pool: Pool): TenantTransactionRunner {
  return async <T>(tenant_id: string, work: (client: PoolClient) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE agentos_app');
      await client.query('SET LOCAL search_path TO agentos, public');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant_id]);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  };
}
function restartPool(): Pool {
  if (!restartedPool) throw new Error('P5_RESTART_POOL_REQUIRED: live setup did not complete.');
  return restartedPool;
}

// DATABASE_URL is the tenant app login; PLATFORM_DATABASE_URL must be the dedicated
// platform login (0052). Provisioning is intentionally not an app-role capability.
// The app role cannot DELETE these append-only fixtures. Use an ephemeral rehearsal DB;
// random idempotency keys isolate repeat/full-suite runs without weakening production grants.
describe('P5 provisioning and autonomy repositories (live PostgreSQL)', () => {
  beforeAll(async () => {
    const url = process.env.DATABASE_URL;
    if (!url || url.trim().length === 0) {
      throw new Error('DATABASE_URL_REQUIRED: P5 live repository smoke requires migrated PostgreSQL.');
    }
    if (!process.env.PLATFORM_DATABASE_URL?.trim()) {
      throw new Error(
        'P5_PLATFORM_DATABASE_URL_REQUIRED: provisionTenantShell uses the dedicated ' +
        'agentos_platform_login connection. Migration 0052 forbids agentos_app from assuming ' +
        'agentos_platform; configure PLATFORM_DATABASE_URL rather than granting app membership.',
      );
    }
    const client = await getPool().connect();
    try {
      const { rows } = await client.query<{
        role_name: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
        tenants: string | null;
        policies: string | null;
        events: string | null;
        controls: string | null;
      }>(`SELECT current_user AS role_name, rolsuper, rolbypassrls,
          to_regclass('agentos.tenants')::text AS tenants,
          to_regclass('agentos.autonomy_policies')::text AS policies,
          to_regclass('agentos.autonomy_policy_events')::text AS events,
          to_regclass('agentos.tenant_autonomy_controls')::text AS controls
        FROM pg_roles WHERE rolname = current_user`);
      const role = rows[0];
      if (!role || role.role_name !== 'agentos_app' || role.rolsuper || role.rolbypassrls) {
        throw new Error('P5_RLS_ROLE_REQUIRED: connect as the NOBYPASSRLS agentos_app role.');
      }
      if (!role.tenants || !role.policies || !role.events || !role.controls) {
        throw new Error('P5_MIGRATIONS_REQUIRED: apply the raw SQL migrations before the live smoke.');
      }
    } finally {
      client.release();
    }
    const platformIdentity = await getPlatformPool().query<{
      role_name: string; rolsuper: boolean; rolbypassrls: boolean; rolinherit: boolean; can_assume: boolean;
    }>(
      `SELECT session_user AS role_name, rolsuper, rolbypassrls, rolinherit,
         pg_catalog.pg_has_role(session_user, 'agentos_platform', 'SET') AS can_assume
       FROM pg_catalog.pg_roles WHERE rolname = session_user`,
    );
    expect(platformIdentity.rows[0]).toEqual({
      role_name: 'agentos_platform_login',
      rolsuper: false,
      rolbypassrls: false,
      rolinherit: false,
      can_assume: true,
    });
    tenantA = await provisioning.provisionTenantShell({
      idempotency_key: keyA, request_fingerprint: fingerprintA, display_name: 'P5 live tenant A',
    });
    tenantB = await provisioning.provisionTenantShell({
      idempotency_key: keyB, request_fingerprint: fingerprintB, display_name: 'P5 live tenant B',
    });
    await autonomy.commitPolicy(policyInput(tenantA));
    restartedPool = new Pool({ connectionString: url });
  }, 30_000);

  afterAll(async () => {
    await restartedPool?.end();
  });

  it('provisions a safe shell idempotently and reads workspace/capabilities after a pool restart', async () => {
    const originalEvents = await provisioning.listProvisioningEvents(tenantA);
    expect(originalEvents).toEqual([
      expect.objectContaining({ event_type: 'TENANT_PROVISIONED', idempotency_key: keyA }),
    ]);
    expect(await provisioning.provisionTenantShell({
      idempotency_key: keyA, request_fingerprint: fingerprintA, display_name: 'P5 live tenant A',
    })).toBe(tenantA);
    await expect(provisioning.provisionTenantShell({
      idempotency_key: keyA, request_fingerprint: digest('different request'), display_name: 'Changed tenant',
    })).rejects.toMatchObject({ code: '23505' });

    const fresh = new P5ProvisioningRepository(runnerFrom(restartPool()));
    expect(await fresh.getTenant(tenantA)).toMatchObject({ tenant_id: tenantA, status: 'PROVISIONED' });
    expect(await fresh.getWorkspace(tenantA)).toMatchObject({ tenant_id: tenantA, status: 'UNCONFIGURED' });
    const capabilities = await fresh.listCapabilities(tenantA);
    expect(capabilities.map((item) => [item.capability_id, item.status])).toEqual([
      ['care', 'UNCONFIGURED'], ['marketing', 'UNCONFIGURED'], ['sales', 'UNCONFIGURED'],
    ]);
    expect(await fresh.listConnectors(tenantA)).toEqual(expect.arrayContaining([
      expect.objectContaining({ connector_id: 'SHOPIFY', status: 'UNBOUND' }),
    ]));
    expect(await fresh.getTenant(tenantB)).toMatchObject({ tenant_id: tenantB, status: 'PROVISIONED' });
    expect(await fresh.getNamespace(tenantA)).toMatchObject({
      tenant_id: tenantA,
      redis_prefix: `tenant:${tenantA}`,
      storage_prefix: `tenant/${tenantA}`,
    });
    expect(await fresh.listOwnerInputs(tenantA)).toEqual(expect.arrayContaining([
      expect.objectContaining({ input_id: 'ASM-003', status: 'UNRESOLVED' }),
      expect.objectContaining({ input_id: 'RESIDENCY_REGION', status: 'UNRESOLVED' }),
    ]));
    expect(await fresh.getResidency(tenantA)).toMatchObject({ status: 'UNRESOLVED', region: null });
    expect(await fresh.listProvisioningEvents(tenantA)).toEqual([
      expect.objectContaining({ event_type: 'TENANT_PROVISIONED', idempotency_key: keyA }),
    ]);
    // Replaying the shell must preserve the original event identity and timestamp,
    // not replace or append a second event of the same type.
    expect(await fresh.listProvisioningEvents(tenantA)).toEqual(originalEvents);
    const agents = await withTenantContext(tenantA, (client) => client.query<{
      code: string; assigned_authority: string; is_active: boolean;
    }>('SELECT code, assigned_authority, is_active FROM agentos.agents WHERE tenant_id = $1', [tenantA]));
    expect(agents.rows).toHaveLength(13);
    expect(agents.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'SAL-01', assigned_authority: 'AUTH-0', is_active: false }),
    ]));
    expect(agents.rows.every((agent) => agent.assigned_authority === 'AUTH-0' && !agent.is_active)).toBe(true);
  });

  it('persists promotion, evidence snapshots, rollback, and pause/kill controls across repository restart', async () => {
    const promoted = await autonomy.commitPolicy({
      ...policyInput(tenantA),
      state: 'PROMOTED',
      evidence_window_ref: 'window-live',
      approver_id: 'operator-live',
      reason: 'Approved low-risk stock read',
      audit_ref: 'audit-live',
      evidence_ref: 'evidence-live',
    });
    await autonomy.appendPolicyEvent({
      tenant_id: tenantA, skill_id: SKILL, policy_version: VERSION,
      trigger: 'PROMOTED', from_state: 'MINIMUM', to_state: 'PROMOTED',
      actor: 'operator-live', reason: promoted.reason, audit_ref: promoted.audit_ref,
      snapshot: { ...promoted }, occurred_at: promoted.effective_at,
    });
    const rolledBack = await autonomy.commitPolicy({
      ...promoted,
      state: 'DEMOTED',
      previous_approved_state: 'PROMOTED',
      reason: 'Evidence drift requires rollback',
      effective_at: new Date().toISOString(),
    });
    await autonomy.appendPolicyEvent({
      tenant_id: tenantA, skill_id: SKILL, policy_version: VERSION,
      trigger: 'EVIDENCE_DRIFT', from_state: 'PROMOTED', to_state: 'DEMOTED',
      actor: 'operator-live', reason: rolledBack.reason, audit_ref: rolledBack.audit_ref,
      snapshot: { ...rolledBack }, occurred_at: rolledBack.effective_at,
    });
    await autonomy.commitControls({
      tenant_id: tenantA, paused: true, kill_switch: true, actor: 'operator-live',
      reason: 'Operator stopped autonomy', effective_at: new Date().toISOString(),
    });
    await autonomy.appendControlEvent({
      tenant_id: tenantA, event_type: 'KILL_SWITCH', actor: 'operator-live',
      reason: 'Operator stopped autonomy', skill_id: SKILL, policy_version: VERSION,
      occurred_at: new Date().toISOString(),
    });

    const fresh = new P5AutonomyRepository(runnerFrom(restartPool()));
    expect(await fresh.get(tenantA, SKILL, VERSION)).toMatchObject({
      state: 'DEMOTED', previous_approved_state: 'PROMOTED',
      rollback_state: 'MINIMUM', evidence_ref: 'evidence-live',
    });
    const snapshots = await fresh.listPolicySnapshots(tenantA);
    expect(snapshots).toHaveLength(2);
    expect(snapshots).toEqual(expect.arrayContaining([
      expect.objectContaining({ state: 'PROMOTED', evidence_window_ref: 'window-live' }),
      expect.objectContaining({ state: 'DEMOTED', reason: 'Evidence drift requires rollback' }),
    ]));
    expect(await fresh.getControls(tenantA)).toMatchObject({ paused: true, kill_switch: true });
    expect(await fresh.listControlEvents(tenantA)).toEqual([
      expect.objectContaining({ event_type: 'KILL_SWITCH', actor: 'operator-live' }),
    ]);
  });

  it('enforces RLS for both tenants and refuses cross-tenant writes from the application role', async () => {
    const fresh = new P5AutonomyRepository(runnerFrom(restartPool()));
    expect(await fresh.get(tenantB, SKILL, VERSION)).toBeNull();
    expect(await fresh.listPolicySnapshots(tenantB)).toEqual([]);
    expect(await provisioning.getTenant(tenantB)).toMatchObject({ tenant_id: tenantB });
    expect(await new P5ProvisioningRepository(runnerFrom(restartPool())).getTenant(tenantA))
      .toMatchObject({ tenant_id: tenantA });

    const unscoped = await restartPool().query<{ visible: number }>(
      'SELECT count(*)::int AS visible FROM agentos.autonomy_policies WHERE policy_version = $1 AND tenant_id = $2',
      [VERSION, tenantA],
    );
    expect(unscoped.rows[0]?.visible).toBe(0);
    await expect(withTenantContext(tenantB, (client) => client.query(
      `INSERT INTO agentos.autonomy_policy_events (
        tenant_id, skill_id, policy_version, trigger, from_state, to_state,
        actor, reason, snapshot, occurred_at
      ) VALUES ($1, $2, $3, 'FORGED', 'MINIMUM', 'PROMOTED', 'operator-live',
        'cross-tenant write', '{}'::jsonb, CURRENT_TIMESTAMP)`,
      [tenantA, SKILL, VERSION],
    ))).rejects.toMatchObject({ code: '42501' });
    expect(await fresh.listPolicySnapshots(tenantA)).toHaveLength(2);
  });

  it('rolls back failed policy commits and every write of a failed tenant transaction', async () => {
    const before = await autonomy.get(tenantA, SKILL, VERSION);
    expect(before?.state).toBe('DEMOTED');
    await expect(autonomy.commitPolicy({
      ...before!, state: 'INVALID_STATE' as CommitAutonomyPolicyInput['state'],
    })).rejects.toMatchObject({ code: '23514' });
    expect(await autonomy.get(tenantA, SKILL, VERSION)).toMatchObject({
      state: 'DEMOTED', reason: 'Evidence drift requires rollback',
    });

    const eventId = randomUUID();
    await expect(withTenantContext(tenantA, async (client) => {
      await client.query(
        `INSERT INTO agentos.autonomy_policy_events (
          event_id, tenant_id, skill_id, policy_version, trigger, from_state, to_state,
          actor, reason, snapshot, occurred_at
        ) VALUES ($1, $2, $3, $4, 'ROLLBACK_PROBE', 'DEMOTED', 'DEMOTED',
          'operator-live', 'transaction rollback probe', '{}'::jsonb, CURRENT_TIMESTAMP)`,
        [eventId, tenantA, SKILL, VERSION],
      );
      await client.query(
        `INSERT INTO agentos.autonomy_control_events (
          tenant_id, event_type, actor, reason, occurred_at
        ) VALUES ($1, 'KILL_SWITCH', NULL, 'invalid operator', CURRENT_TIMESTAMP)`,
        [tenantA],
      );
    })).rejects.toMatchObject({ code: '23502' });
    const events = await autonomy.listPolicyEvents(tenantA);
    expect(events.map((event) => event.event_id)).not.toContain(eventId);
    expect(events).toHaveLength(2);
  });

  it('saves, replays, and rejects conflicting run responses as agentos_app', async () => {
    const pool = restartPool();
    const run_id = `run-response-replay-${randomUUID()}`;
    const conversation_id = randomUUID();
    const runInAppRole = runnerFrom(pool);
    const repository = new RunResponseRepository(runInAppRole);

    await runInAppRole(tenantA, async (client) => {
      const role = await client.query<{
        db_user: string;
        rolsuper: boolean;
        rolbypassrls: boolean;
      }>(
        `SELECT current_user AS db_user, rolsuper, rolbypassrls
          FROM pg_roles WHERE rolname = current_user`,
      );
      expect(role.rows[0]).toEqual({
        db_user: 'agentos_app',
        rolsuper: false,
        rolbypassrls: false,
      });
      await client.query(
        `INSERT INTO agentos.platform_durable_tasks (tenant_id, run_id, correlation_id)
         VALUES ($1, $2, $3)`,
        [tenantA, run_id, run_id],
      );
      await client.query(
        `INSERT INTO agentos.conversations (id, tenant_id, channel, external_thread_id)
         VALUES ($1, $2, $3, $4)`,
        [conversation_id, tenantA, 'web', `run-response-${randomUUID()}`],
      );
    });

    const input = {
      tenant_id: tenantA,
      run_id,
      answer: 'A persisted live response.',
      sources: [{ evidence_id: 'run-response-live' }],
      response_kind: 'ANSWER' as const,
      outcome: 'ANSWERED' as const,
      source: 'ERP.Catalog@live',
      sender_id: 'SAL-01',
      conversation_id,
    };
    const first = await repository.save(input);

    expect(first.message_id).not.toBeNull();
    expect(await repository.save(input)).toEqual(first);
    await expect(
      repository.save({ ...input, answer: 'A conflicting live response.' }),
    ).rejects.toThrow('RUN_RESPONSE_CONFLICT');

    const persisted = await runInAppRole(tenantA, async (client) => {
      const result = await client.query<{
        response_count: number;
        agent_message_count: number;
      }>(
        `SELECT
          (SELECT count(*)::int FROM agentos.run_responses
            WHERE tenant_id = $1 AND run_id = $2) AS response_count,
          (SELECT count(*)::int FROM agentos.conversation_messages
            WHERE tenant_id = $1 AND conversation_id = $3 AND sender_type = 'agent')
            AS agent_message_count`,
        [tenantA, run_id, conversation_id],
      );
      return result.rows[0];
    });
    expect(persisted).toEqual({ response_count: 1, agent_message_count: 1 });
  });

});
