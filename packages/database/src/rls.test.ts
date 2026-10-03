import { randomUUID } from 'node:crypto';

import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getPool } from './client.js';
import { withTenantContext } from './rls.js';
import { withPlatformRole } from './repositories/platform-directory.js';

/**
 * Live row-level security suite (NFR-006).
 *
 * This suite runs against a real PostgreSQL instance because the objects under
 * test only exist there: tenant-scoped tables have FORCEd RLS policies,
 * intentionally global tables use the documented role/function boundaries below,
 * cross-tenant references are refused by composite `(tenant_id, id)` foreign keys,
 * and the tenant context is a transaction-local
 * GUC. `DATABASE_URL` must connect as a role that cannot bypass row security
 * (`agentos_app` locally), otherwise the assertions would be measuring the
 * role's privileges instead of the policies.
 *
 * There is no skip path. A missing `DATABASE_URL`, an unmigrated schema, or a
 * bypassing role fails the suite: a skipped policy suite reports green while
 * proving nothing (implement/03 §10).
 */

/** Fixture tenants: the canonical offline fixture tenants (testcases/fixtures). */
const TENANT_A = '11111111-1111-1111-1111-111111111111';
const TENANT_B = '22222222-2222-2222-2222-222222222222';

/** Fixed fixture customers: the cross-tenant probe needs stable ids across runs. */
const CUSTOMER_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CUSTOMER_B = 'bbbbbbbb-0000-4000-8000-00000000000b';

/** One run id per suite invocation, so cleanup can find exactly this run's rows. */
const RUN_ID = `RUN-RLS-${randomUUID()}`;

/**
 * Global tables intentionally have no tenant_isolation_policy. RLS must still be
 * ENABLEd and FORCEd; these exemptions cover only the tenant-policy name check.
 */
const GLOBAL_TABLE_POLICY_EXEMPTIONS: Record<string, string> = {
  auth_sessions: '0041: global sessions; all app table grants revoked, SECURITY DEFINER auth accessors only.',
  users: '0041: global identities; all app table grants revoked, SECURITY DEFINER auth accessors only.',
  platform_audit_events: '0029: global append-only audit; app table grants revoked, definer writer and platform-only reads.',
  platform_secrets: '0030: global platform credentials; app grants revoked, platform-only RLS policies.',
  platform_llm_providers: '0032: global provider defaults; platform-only RLS policy denies app access even with bootstrap default grants.',
  skill_catalog: '0042: public code-synced global contracts; app SELECT policy only, mutation requires platform policy.',
  worker_heartbeats: '0040: global process presence, not tenant data; app SELECT/INSERT/UPDATE only, platform reads, no app DELETE/TRUNCATE.',
};

/**
 * Actions created by this suite. `agentos.actions` carries no run column, so the
 * ids are tracked here instead of being searched for at cleanup time.
 */
const createdActionIds: string[] = [];

let durableSchemaPresent = false;

/** Returns the single row a statement must return, or fails loudly. */
function firstRow<R extends QueryResultRow>(result: QueryResult<R>): R {
  const [row] = result.rows;

  if (row === undefined) {
    throw new Error(
      'EXPECTED_ONE_ROW: the statement returned no row; the durable P0 schema is not in the state this suite requires.',
    );
  }

  return row;
}

/**
 * Awaits a statement that MUST be refused and returns its PostgreSQL error, so a
 * test can assert on the SQLSTATE (23503 foreign_key_violation, 42501
 * row-level security violation) instead of only on the fact that it threw.
 */
async function expectRefusal(statement: Promise<unknown>): Promise<{ code: string; message: string; where: string }> {
  try {
    await statement;
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      && typeof error.code === 'string' ? error.code : '';
    const message = error instanceof Error ? error.message : '';
    const where = typeof error === 'object' && error !== null && 'where' in error
      && typeof error.where === 'string' ? error.where : '';
    return { code, message, where };
  }

  throw new Error('EXPECTED_REFUSAL: the statement was accepted, but the durable schema must refuse it.');
}

/** The BEFORE INSERT inheritance trigger can fail closed before RLS WITH CHECK. */
function expectTenantWriteRefusal(refusal: { code: string; message: string; where: string }): void {
  expect(['42501', '23503']).toContain(refusal.code);
  if (refusal.code === '23503') {
    expect(refusal.message).toBe('data_class tenant or parent not found');
    expect(refusal.where).toMatch(/inherit_data_class/);
  } else {
    expect(refusal.message).toContain('row-level security policy');
  }
}

/** Opens a transaction with no tenant context bound and always rolls it back. */
async function withUnscopedTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    return await work(client);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function seedCustomer(tenantId: string, customerId: string): Promise<void> {
  await withTenantContext(tenantId, async (client) => {
    await client.query(
      `INSERT INTO agentos.customers (id, tenant_id, display_name, verification_status)
       VALUES ($1, $2, $3, 'verified')
       ON CONFLICT (id) DO NOTHING`,
      [customerId, tenantId, `RLS policy fixture (${tenantId})`],
    );
  });
}

async function seedAction(tenantId: string): Promise<{ actionId: string; effectKey: string }> {
  const actionId = randomUUID();
  const effectKey = `eff_${randomUUID().replaceAll('-', '')}`;

  await withTenantContext(tenantId, async (client) => {
    await client.query(
      `INSERT INTO agentos.actions (id, tenant_id, skill_name, effect_key, target_channel, action_payload)
       VALUES ($1, $2, 'skill.sales.send_message', $3, 'EMAIL', $4::jsonb)`,
      [actionId, tenantId, effectKey, JSON.stringify({ message: 'RLS policy fixture' })],
    );
  });

  createdActionIds.push(actionId);

  return { actionId, effectKey };
}

/** Seeds a fixture action with one PENDING approval bound to it. */
async function seedPendingApproval(
  tenantId: string,
): Promise<{ actionId: string; approvalId: string }> {
  const { actionId, effectKey } = await seedAction(tenantId);

  const approvalId = await withTenantContext(tenantId, async (client) => {
    const result = await client.query<{ id: string }>(
      `INSERT INTO agentos.approvals (tenant_id, run_id, action_id, effect_key, payload, reason)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)
       RETURNING id`,
      [
        tenantId,
        RUN_ID,
        actionId,
        effectKey,
        JSON.stringify({ message: 'RLS policy fixture' }),
        'AUTH-4 gate fixture: verifies the queue view is tenant-scoped',
      ],
    );

    return firstRow(result).id;
  });

  return { actionId, approvalId };
}

async function cleanupFixtures(): Promise<void> {
  if (!durableSchemaPresent) {
    return;
  }

  for (const tenantId of [TENANT_A, TENANT_B]) {
    await withTenantContext(tenantId, async (client) => {
      await client.query('DELETE FROM agentos.approvals WHERE run_id = $1', [RUN_ID]);

      if (createdActionIds.length > 0) {
        await client.query('DELETE FROM agentos.actions WHERE id = ANY($1::uuid[])', [createdActionIds]);
      }

      await client.query('DELETE FROM agentos.customers WHERE id = ANY($1::uuid[])', [
        [CUSTOMER_A, CUSTOMER_B],
      ]);
    });
  }
}

describe('agentos row-level security (live PostgreSQL)', () => {
  beforeAll(async () => {
    if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL.trim().length === 0) {
      throw new Error(
        'DATABASE_URL_REQUIRED: this suite exercises real PostgreSQL policies, so it cannot run ' +
          'without a database. Set DATABASE_URL, run `pnpm db:migrate:rehearse`, then run ' +
          '`pnpm test:rls-policies`.',
      );
    }

    const client = await getPool().connect();

    try {
      const role = firstRow(
        await client.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
          'SELECT current_user AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
        ),
      );

      if (role.rolsuper || role.rolbypassrls) {
        throw new Error(
          `RLS_NOT_ENFORCED: DATABASE_URL connects as "${role.role_name}", which bypasses ` +
            'row-level security, so these policies cannot be exercised. Connect as a ' +
            'NOBYPASSRLS role such as agentos_app (docker/postgres/init-roles.sh).',
        );
      }

      const objects = firstRow(
        await client.query<Record<string, string | null>>(
          `SELECT to_regclass('agentos.customers')::text          AS customers,
                  to_regclass('agentos.evidences')::text          AS evidences,
                  to_regclass('agentos.actions')::text            AS actions,
                  to_regclass('agentos.approvals')::text          AS approvals,
                  to_regclass('agentos.approval_queue')::text     AS approval_queue,
                  to_regclass('agentos.effect_reservations')::text AS effect_reservations,
                  to_regclass('agentos.platform_durable_tasks')::text AS platform_durable_tasks,
                  to_regclass('agentos.care_handoffs')::text        AS care_handoffs,
                  to_regclass('agentos.cross_domain_handoffs')::text AS cross_domain_handoffs,
                  to_regclass('agentos.evidence_records')::text   AS evidence_records,
                  to_regclass('agentos.audit_records')::text      AS audit_records,
                  to_regclass('agentos.agent_run_logs')::text     AS agent_run_logs,
                  to_regclass('agentos.service_cases')::text      AS service_cases,
                  to_regclass('agentos.service_case_events')::text AS service_case_events`,
        ),
      );

      const missing = Object.entries(objects)
        .filter(([, oid]) => oid === null)
        .map(([name]) => name);

      if (missing.length > 0) {
        throw new Error(
          `MIGRATIONS_NOT_APPLIED: agentos is missing ${missing.join(', ')}. Run ` +
            '`pnpm db:migrate:rehearse` against DATABASE_URL before this suite.',
        );
      }

      durableSchemaPresent = true;

      // 0039 inherits child classification from a visible tenant/parent. Tenant
      // registry writes remain platform-only; never grant app INSERT for fixtures.
      if (!process.env.PLATFORM_DATABASE_URL?.trim()) {
        throw new Error(
          'RLS_PLATFORM_DATABASE_URL_REQUIRED: configure the dedicated platform login ' +
          'to provision fixture tenant shells; agentos_app must not insert tenant registry rows.',
        );
      }
      for (const tenantId of [TENANT_A, TENANT_B]) {
        const existing = await withTenantContext(tenantId, (tenantClient) => tenantClient.query(
          'SELECT tenant_id FROM agentos.tenants WHERE tenant_id = $1', [tenantId],
        ));
        if (existing.rows.length > 0) continue;

        await withPlatformRole(async (platformClient) => {
          await platformClient.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
          await platformClient.query(
            `SELECT agentos.provision_tenant_shell_for_id(
               $1::uuid, $2::char(64), $2::char(64), $3::varchar(128), 'TEST'::agentos.data_class)`,
            [tenantId, tenantId.replaceAll('-', '').padEnd(64, '0'), `RLS policy fixture (${tenantId})`],
          );
        });
      }
    } finally {
      client.release();
    }
  });

  afterAll(async () => {
    await cleanupFixtures();
  });

  it('forces RLS on every agentos table and tenant policies on tenant-scoped tables', async () => {
    const client = await getPool().connect();

    try {
      const { rows } = await client.query<{
        relname: string;
        rls_not_forced: boolean;
        policy_missing: boolean;
      }>(
        `SELECT c.relname,
                (NOT c.relrowsecurity OR NOT c.relforcerowsecurity) AS rls_not_forced,
                NOT EXISTS (
                    SELECT 1
                    FROM pg_policy p
                    WHERE p.polrelid = c.oid
                      AND p.polname = CASE WHEN c.relname = 'llm_probe_results'
                        THEN 'llm_probe_tenant_isolation' ELSE 'tenant_isolation_policy' END
                ) AS policy_missing
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'agentos'
            AND c.relkind IN ('r', 'p')
          ORDER BY c.relname`,
      );

      // A schema with no table would satisfy the filter below vacuously.
      expect(rows.length).toBeGreaterThan(0);
      // 0032 mixes global/platform and tenant probes; its explicitly named
      // llm_probe_tenant_isolation policy still fences agentos_app by tenant_id.
      expect(rows.filter((row) => row.rls_not_forced
        || (row.policy_missing && !Object.hasOwn(GLOBAL_TABLE_POLICY_EXEMPTIONS, row.relname)))).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('returns only the rows of the bound tenant', async () => {
    await seedCustomer(TENANT_A, CUSTOMER_A);
    await seedCustomer(TENANT_B, CUSTOMER_B);

    const seenByA = await withTenantContext(TENANT_A, async (client) => {
      const own = await client.query<{ id: string }>(
        'SELECT id FROM agentos.customers WHERE id = ANY($1::uuid[])',
        [[CUSTOMER_A, CUSTOMER_B]],
      );
      const foreign = await client.query<{ leaked: number }>(
        'SELECT count(*)::int AS leaked FROM agentos.customers WHERE tenant_id <> $1',
        [TENANT_A],
      );

      return { ids: own.rows.map((row) => row.id), leaked: firstRow(foreign).leaked };
    });

    expect(seenByA.ids).toEqual([CUSTOMER_A]);
    expect(seenByA.leaked).toBe(0);

    const seenByB = await withTenantContext(TENANT_B, async (client) => {
      const own = await client.query<{ id: string }>(
        'SELECT id FROM agentos.customers WHERE id = ANY($1::uuid[])',
        [[CUSTOMER_A, CUSTOMER_B]],
      );
      const foreign = await client.query<{ leaked: number }>(
        'SELECT count(*)::int AS leaked FROM agentos.customers WHERE tenant_id <> $1',
        [TENANT_B],
      );

      return { ids: own.rows.map((row) => row.id), leaked: firstRow(foreign).leaked };
    });

    expect(seenByB.ids).toEqual([CUSTOMER_B]);
    expect(seenByB.leaked).toBe(0);
  });

  it('denies reads and writes while no tenant context is bound', async () => {
    const customerId = randomUUID();
    await withUnscopedTransaction(async (client) => {
      const visible = await client.query<{ visible: number }>(
        'SELECT count(*)::int AS visible FROM agentos.customers',
      );
      expect(firstRow(visible).visible).toBe(0);

      const refusal = await expectRefusal(
        client.query('INSERT INTO agentos.customers (id, tenant_id, display_name) VALUES ($1, $2, $3)', [
          customerId,
          TENANT_A,
          'unscoped insert must be refused',
        ]),
      );

      expectTenantWriteRefusal(refusal);
    });

    // Observe from the owning tenant after the refused transaction, not through
    // an unscoped read that would hide even an incorrectly persisted row.
    const persisted = await withTenantContext(TENANT_A, (client) => client.query(
      'SELECT id FROM agentos.customers WHERE id = $1', [customerId],
    ));
    expect(persisted.rows).toEqual([]);
  });

  it('rejects cross-tenant foreign keys and accepts the same-tenant reference', async () => {
    await seedCustomer(TENANT_A, CUSTOMER_A);

    // (1) evidences -> customers: a tenant B row may not reference tenant A's customer.
    const crossTenantCustomer = await expectRefusal(
      withTenantContext(TENANT_B, (client) =>
        client.query(
          `INSERT INTO agentos.evidences
                 (tenant_id, customer_id, run_id, taxonomy_type, claim, source_uri, source_version, verified_by)
           VALUES ($1, $2, $3, 'HYPOTHESIS', $4, $5, $6, $7)`,
          [
            TENANT_B,
            CUSTOMER_A,
            RUN_ID,
            'cross-tenant customer reference must be refused',
            'second_brain:/sales/qualification.md',
            '1.0.0',
            'CS-01',
          ],
        ),
      ),
    );

    expect(crossTenantCustomer.code).toBe('23503');
    expect(crossTenantCustomer.message).toContain('foreign key constraint');

    // (2) approvals -> actions: a tenant B approval may not bind tenant A's action.
    const { actionId: actionOfA } = await seedAction(TENANT_A);

    const crossTenantAction = await expectRefusal(
      withTenantContext(TENANT_B, (client) =>
        client.query(
          `INSERT INTO agentos.approvals (tenant_id, run_id, action_id, effect_key, payload, reason)
           VALUES ($1, $2, $3, $4, '{}'::jsonb, $5)`,
          [
            TENANT_B,
            RUN_ID,
            actionOfA,
            `eff_${randomUUID().replaceAll('-', '')}`,
            'cross-tenant action binding must be refused',
          ],
        ),
      ),
    );

    expect(crossTenantAction.code).toBe('23503');
    expect(crossTenantAction.message).toContain('foreign key constraint');

    // (3) Same-tenant control: the identical insert must be accepted, which proves
    // the constraint does not over-block a legal reference.
    const sameTenant = await seedPendingApproval(TENANT_B);

    const persisted = await withTenantContext(TENANT_B, async (client) => {
      const { rows } = await client.query<{ action_id: string }>(
        'SELECT action_id FROM agentos.approvals WHERE id = $1',
        [sameTenant.approvalId],
      );

      return rows;
    });

    expect(persisted).toEqual([{ action_id: sameTenant.actionId }]);
  });

  it('keeps the tenant context inside its transaction', async () => {
    await seedCustomer(TENANT_A, CUSTOMER_A);

    const client = await getPool().connect();

    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_A]);

      const bound = await client.query<{ context: string | null }>(
        "SELECT current_setting('app.current_tenant_id', true) AS context",
      );
      expect(firstRow(bound).context).toBe(TENANT_A);

      const scoped = await client.query<{ visible: number }>(
        'SELECT count(*)::int AS visible FROM agentos.customers WHERE id = $1',
        [CUSTOMER_A],
      );
      expect(firstRow(scoped).visible).toBe(1);

      await client.query('COMMIT');

      // COMMIT restores the pre-transaction value: the setting is cleared (NULL
      // or '') and this very backend can no longer read tenant A.
      const cleared = await client.query<{ context: string | null }>(
        "SELECT current_setting('app.current_tenant_id', true) AS context",
      );
      expect(firstRow(cleared).context ?? '').toBe('');

      const unscoped = await client.query<{ visible: number }>(
        'SELECT count(*)::int AS visible FROM agentos.customers',
      );
      expect(firstRow(unscoped).visible).toBe(0);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('evaluates the security-invoker approval queue against the calling tenant', async () => {
    const fixture = await seedPendingApproval(TENANT_A);

    const visibleToA = await withTenantContext(TENANT_A, async (client) => {
      const { rows } = await client.query<{ approval_id: string; status: string }>(
        'SELECT approval_id, status FROM agentos.approval_queue WHERE approval_id = $1',
        [fixture.approvalId],
      );

      return rows;
    });

    expect(visibleToA).toEqual([{ approval_id: fixture.approvalId, status: 'PENDING' }]);

    const visibleToB = await withTenantContext(TENANT_B, async (client) => {
      const { rowCount } = await client.query(
        'SELECT approval_id FROM agentos.approval_queue WHERE approval_id = $1',
        [fixture.approvalId],
      );

      return rowCount;
    });

    expect(visibleToB).toBe(0);
  });
});
