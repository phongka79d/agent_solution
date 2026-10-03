import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getPool } from './client.js';
import { AuditRepository } from './repositories/audit-evidence.js';
import { ApprovalRepository } from './repositories/approvals.js';
import { insertFact } from './repositories/customer-360.js';
import { withTenantContext } from './rls.js';

const originalDatabaseUrl = process.env.DATABASE_URL;
const hasDatabaseUrl =
  typeof originalDatabaseUrl === 'string' && originalDatabaseUrl.trim().length > 0;

/**
 * Synthetic tenant fixtures. The ids below are uuid v7-shaped values dedicated to
 * this suite; tenant registry rows are created before their children. Nothing here
 * is a policy default. Every NOT NULL column without a DDL default is supplied explicitly.
 *
 * RLS only applies to non-superusers, so every database case runs as
 * `agentos_app` (NOLOGIN NOBYPASSRLS, created by the migration rehearsal) through
 * `SET LOCAL ROLE agentos_app`. A superuser `DATABASE_URL` therefore cannot fake
 * a pass: the fixtures are written by the connecting role and read by the app role.
 */
const TENANT_A = '01920000-0000-7000-8000-00000000000a';
const TENANT_B = '01920000-0000-7000-8000-00000000000b';

const CUSTOMER_A = '01920000-0000-7000-8000-0000000000a1';
const CUSTOMER_B = '01920000-0000-7000-8000-0000000000b1';
const PRODUCT_A = '01920000-0000-7000-8000-0000000000a2';
const PRODUCT_B = '01920000-0000-7000-8000-0000000000b2';
const CONVERSATION_A = '01920000-0000-7000-8000-0000000000a3';
const CONVERSATION_B = '01920000-0000-7000-8000-0000000000b3';
const IDENTITY_B = '01920000-0000-7000-8000-0000000000b4';
const IDENTITY_USER_A = '01920000-0000-7000-8000-0000000000b5';
const IDENTITY_USER_B = '01920000-0000-7000-8000-0000000000b6';
const IDENTITY_INVITE_HASH = 'c'.repeat(64);

const SWEEP_ACTION_A = '01920000-0000-7000-8000-0000000000c1';
const SWEEP_ACTION_B = '01920000-0000-7000-8000-0000000000c2';
const SWEEP_APPROVAL_A = '01920000-0000-7000-8000-0000000000d1';
const SWEEP_APPROVAL_B = '01920000-0000-7000-8000-0000000000d2';

const FIXTURE_TENANTS: readonly string[] = [TENANT_A, TENANT_B];

const FIXTURE_INSERTS: readonly { readonly text: string; readonly values: readonly unknown[] }[] = [
  {
    text: "INSERT INTO agentos.tenants (tenant_id, status, display_name, idempotency_key, request_fingerprint, data_class) VALUES ($1, $2, $3, $4, $5, 'TEST')",
    values: [
      TENANT_A,
      'PROVISIONED',
      'fixture-tenant-a',
      'fixture-tenant-a'.padEnd(64, 'a'),
      'fixture-tenant-a'.padEnd(64, 'b'),
    ],
  },
  {
    text: "INSERT INTO agentos.tenants (tenant_id, status, display_name, idempotency_key, request_fingerprint, data_class) VALUES ($1, $2, $3, $4, $5, 'TEST')",
    values: [
      TENANT_B,
      'PROVISIONED',
      'fixture-tenant-b',
      'fixture-tenant-b'.padEnd(64, 'a'),
      'fixture-tenant-b'.padEnd(64, 'b'),
    ],
  },
  {
    text: 'INSERT INTO agentos.users (user_id, email, password_hash) VALUES ($1, $2, $3)',
    values: [IDENTITY_USER_A, 'fixture-identity-a@example.com', 'scrypt$fixture-a'],
  },
  {
    text: 'INSERT INTO agentos.users (user_id, email, password_hash) VALUES ($1, $2, $3)',
    values: [IDENTITY_USER_B, 'fixture-identity-b@example.com', 'scrypt$fixture-b'],
  },
  {
    text: 'INSERT INTO agentos.tenant_memberships (tenant_id, user_id, role_bundle, status) VALUES ($1, $2, $3, $4)',
    values: [TENANT_A, IDENTITY_USER_A, 'COMPANY_ADMIN', 'ACTIVE'],
  },
  {
    text: 'INSERT INTO agentos.tenant_memberships (tenant_id, user_id, role_bundle, status) VALUES ($1, $2, $3, $4)',
    values: [TENANT_B, IDENTITY_USER_B, 'VIEWER', 'ACTIVE'],
  },
  {
    text: 'INSERT INTO agentos.invitations (tenant_id, email, token_hash, role_bundle, created_by) VALUES ($1, $2, $3, $4, $5)',
    values: [TENANT_B, 'fixture-identity-a@example.com', IDENTITY_INVITE_HASH, 'OPERATOR', IDENTITY_USER_B],
  },
  {
    text: 'INSERT INTO agentos.tenant_governance_settings (tenant_id, require_distinct_approver) VALUES ($1, $2)',
    values: [TENANT_A, true],
  },
  {
    text: 'INSERT INTO agentos.tenant_governance_settings (tenant_id, require_distinct_approver) VALUES ($1, $2)',
    values: [TENANT_B, false],
  },
  {
    text: 'INSERT INTO agentos.customers (id, tenant_id, display_name, verification_status) VALUES ($1, $2, $3, $4)',
    values: [CUSTOMER_A, TENANT_A, 'fixture-customer-a', 'verified'],
  },
  {
    text: 'INSERT INTO agentos.customers (id, tenant_id, display_name, verification_status) VALUES ($1, $2, $3, $4)',
    values: [CUSTOMER_B, TENANT_B, 'fixture-customer-b', 'verified'],
  },
  {
    text: 'INSERT INTO agentos.products (id, tenant_id, external_product_code, name) VALUES ($1, $2, $3, $4)',
    values: [PRODUCT_A, TENANT_A, 'fixture-product-a', 'Fixture product A'],
  },
  {
    text: 'INSERT INTO agentos.products (id, tenant_id, external_product_code, name) VALUES ($1, $2, $3, $4)',
    values: [PRODUCT_B, TENANT_B, 'fixture-product-b', 'Fixture product B'],
  },
  {
    text: 'INSERT INTO agentos.conversations (id, tenant_id, customer_id, channel, external_thread_id) VALUES ($1, $2, $3, $4, $5)',
    values: [CONVERSATION_A, TENANT_A, CUSTOMER_A, 'line', 'fixture-thread-a'],
  },
  {
    text: 'INSERT INTO agentos.conversations (id, tenant_id, customer_id, channel, external_thread_id) VALUES ($1, $2, $3, $4, $5)',
    values: [CONVERSATION_B, TENANT_B, CUSTOMER_B, 'line', 'fixture-thread-b'],
  },
  {
    text: 'INSERT INTO agentos.customer_identities (id, tenant_id, customer_id, channel_type, channel_identifier, identifier_hash, is_primary) VALUES ($1, $2, $3, $4, $5, $6, FALSE)',
    values: [IDENTITY_B, TENANT_B, CUSTOMER_B, 'line', 'fixture-identity-b', 'fixture-hash-b'],
  },
];

/** Children before parents so composite ON DELETE RESTRICT edges never block cleanup. */
const FIXTURE_DELETES: readonly string[] = [
  'DELETE FROM agentos.invitations WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.tenant_memberships WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.approvals WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.actions WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.tenant_governance_settings WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.evidences WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.service_cases WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.recommendations WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.orders WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.customer_identities WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.conversations WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.products WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.customers WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.tenants WHERE tenant_id = ANY($1::uuid[])',
  "DELETE FROM agentos.users WHERE email LIKE 'fixture-identity-%@example.com' AND cardinality($1::uuid[]) > 0",
];

const INSERT_ORDER =
  'INSERT INTO agentos.orders (id, tenant_id, customer_id, order_number, subtotal_amount, total_amount, items, status) ' +
  "VALUES ($1, $2, $3, $4, '100.00', '100.00', '[]'::jsonb, 'draft')";

const INSERT_RECOMMENDATION =
  'INSERT INTO agentos.recommendations (id, tenant_id, customer_id, product_id, recommendation_type, reason, evidence, eligibility, confidence, expected_outcome, expires_at) ' +
  "VALUES ($1, $2, $3, $4, 'cross_sell', 'fixture reason', '{}'::jsonb, '{}'::jsonb, '0.500', '{}'::jsonb, CURRENT_TIMESTAMP + INTERVAL '1 day')";

const INSERT_SERVICE_CASE =
  'INSERT INTO agentos.service_cases (id, tenant_id, customer_id, conversation_id, case_number, category, subject) ' +
  "VALUES ($1, $2, $3, $4, $5, 'general', 'fixture subject')";
const INSERT_SERVICE_CASE_EVENT =
  'INSERT INTO agentos.service_case_events (tenant_id, case_id, effect_key, request_fingerprint, action_type, actor_id, case_version, next_state, action_details, result_payload) ' +
  "VALUES ($1, $2, $3, $4, 'CREATE', 'rls-fixture', 1, 'NEW', '{}'::jsonb, '{}'::jsonb)";

const INSERT_NEW_CUSTOMER =
  'INSERT INTO agentos.customers (id, tenant_id, display_name) VALUES ($1, $2, $3)';

type TenantRow = { tenant_id: string };
type CountRow = { total: number };
type PidRow = { pid: number };
type SettingRow = { tenant: string | null };
type UserRow = { db_user: string };

type SweepStateRow = {
  readonly decision: string;
  readonly action_status: string;
};

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return undefined;
  }

  return typeof error.code === 'string' ? error.code : undefined;
}

async function captureFailure(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }

  return undefined;
}

function expectSqlState(failure: unknown, code: string): void {
  expect(failure, 'expected the statement to be rejected').toBeDefined();
  expect(sqlStateOf(failure)).toBe(code);
}

/** 0039's invoker trigger runs before RLS WITH CHECK and cannot see hidden parents. */
function expectTenantWriteRefusal(failure: unknown): void {
  expect(failure, 'expected the statement to be rejected').toBeDefined();
  expect(['42501', '23503']).toContain(sqlStateOf(failure));
  if (sqlStateOf(failure) === '23503') {
    expect(String(failure)).toContain('data_class tenant or parent not found');
    expect(typeof failure === 'object' && failure !== null && 'where' in failure
      ? failure.where : undefined).toMatch(/inherit_data_class/);
  } else {
    expect(String(failure)).toMatch(/row-level security/i);
  }
}

/** Check persistence as the fixture owner so RLS cannot conceal an unauthorized write. */
async function expectCustomerAbsent(pool: Pool, customerId: string): Promise<void> {
  const result = await pool.query<CountRow>(
    'SELECT count(*)::int AS total FROM agentos.customers WHERE id = $1', [customerId],
  );
  expect(result.rows[0]?.total).toBe(0);
}

/** Opens a transaction that mirrors the binder's scoping, minus the pool lookup. */
async function beginAppRole(client: PoolClient, tenantId: string | null): Promise<void> {
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE agentos_app');
  await client.query('SET LOCAL search_path TO agentos, public');

  if (tenantId !== null) {
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);
  }
}

async function asAppRole<T>(
  pool: Pool,
  tenantId: string | null,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await beginAppRole(client, tenantId);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The connection may already be unusable; the original failure is what matters.
    }

    throw error;
  } finally {
    client.release();
  }
}
/** Enters the capability role through the rehearsal's dedicated platform connection when configured. */
async function asPlatformRole<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE agentos_platform');
    await client.query('SET LOCAL search_path TO agentos, public');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // The client may already be unusable; preserve the original failure.
    }
    throw error;
  } finally {
    client.release();
  }
}
/** Opens the dedicated non-inheriting identity role for its narrow SECURITY DEFINER function surface. */
async function asAuthRole<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE agentos_app');
    await client.query('SET LOCAL ROLE agentos_auth');
    await client.query('SET LOCAL search_path TO agentos, public');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original identity assertion failure.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Tenant ids of fixture rows visible in the current transaction. */
async function visibleFixtureTenants(client: PoolClient): Promise<string[]> {
  const result = await client.query<TenantRow>(
    'SELECT DISTINCT tenant_id::text AS tenant_id FROM agentos.customers WHERE tenant_id = ANY($1::uuid[]) ORDER BY tenant_id',
    [FIXTURE_TENANTS],
  );

  return result.rows.map((row) => row.tenant_id);
}

async function customerVisible(client: PoolClient, customerId: string): Promise<boolean> {
  const result = await client.query<CountRow>(
    'SELECT count(*)::int AS total FROM agentos.customers WHERE id = $1',
    [customerId],
  );

  return (result.rows[0]?.total ?? -1) > 0;
}

async function tenantSettingOf(client: PoolClient): Promise<string | null> {
  const result = await client.query<SettingRow>(
    "SELECT current_setting('app.current_tenant_id', true) AS tenant",
  );

  return result.rows[0]?.tenant ?? null;
}

async function backendPidOf(client: PoolClient): Promise<number> {
  const result = await client.query<PidRow>('SELECT pg_backend_pid() AS pid');

  return result.rows[0]?.pid ?? -1;
}

describe('getPool rehearsal (no PostgreSQL required)', () => {
  afterEach(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it('fails closed when DATABASE_URL is missing', () => {
    delete process.env.DATABASE_URL;

    expect(() => getPool()).toThrow('DATABASE_URL_REQUIRED');
  });
});

describe('epistemic write boundary (no PostgreSQL required)', () => {
  it('refuses a HYPOTHESIS-shaped customer fact through insertFact', async () => {
    const failure = await captureFailure(() =>
      insertFact(TENANT_A, {
        display_name: 'fixture-hypothesis',
        rfm_segment_hypothesis: 'champion',
      }),
    );

    expect(failure, 'insertFact must refuse an rfm_segment_hypothesis write').toBeDefined();
    expect(String(failure)).toContain('HYPOTHESIS_PROMOTION_REFUSED');
  });
});

describe.skipIf(!hasDatabaseUrl)('agentos_app RLS rehearsal (real PostgreSQL)', () => {
  let fixturePool: Pool;
  let platformPool: Pool | undefined;
  let connectionString: string;

  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? originalDatabaseUrl;

    if (!url) {
      throw new Error('DATABASE_URL_REQUIRED: this suite runs only with a database configured.');
    }

    connectionString = url;
    process.env.DATABASE_URL = url;
    // Fixtures are written by the connecting (RLS-exempt) role the rehearsal uses.
    // No assertion below relies on that privilege: every check runs as agentos_app.
    fixturePool = new Pool({ connectionString: url, max: 4 });
    const platformUrl = process.env.PLATFORM_DATABASE_URL?.trim() || url;
    platformPool = new Pool({ connectionString: platformUrl, max: 4 });

    for (const statement of FIXTURE_DELETES) {
      await fixturePool.query(statement, [FIXTURE_TENANTS]);
    }

    for (const fixture of FIXTURE_INSERTS) {
      await fixturePool.query(fixture.text, [...fixture.values]);
    }
  });

  afterAll(async () => {
    if (fixturePool) {
      for (const statement of FIXTURE_DELETES) {
        await fixturePool.query(statement, [FIXTURE_TENANTS]);
      }

      await fixturePool.end();
    }
    await platformPool?.end();
  });

  describe('application role hardening', () => {
    it('runs as a non-superuser that cannot bypass RLS', async () => {
      const result = await fixturePool.query<{ rolname: string; rolsuper: boolean; rolbypassrls: boolean }>(
        'SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1',
        ['agentos_app'],
      );
      const role = result.rows[0];

      expect(role, 'agentos_app must exist after the migration rehearsal').toBeDefined();
      expect(role?.rolsuper).toBe(false);
      expect(role?.rolbypassrls).toBe(false);
    });
 
    it('cannot execute tenant-shell provisioning without the platform role', async () => {
      const digest = 'a'.repeat(64);
      const shellFailure = await captureFailure(() =>
        asAppRole(fixturePool, TENANT_A, (client) =>
          client.query(
            'SELECT agentos.provision_tenant_shell($1::char(64), $2::char(64), $3::varchar(128))',
            [digest, digest, 'RLS rehearsal shell'],
          ),
        ),
      );
      expectSqlState(shellFailure, '42501');

      const fixedIdFailure = await captureFailure(() =>
        asAppRole(fixturePool, TENANT_A, (client) =>
          client.query(
            'SELECT agentos.provision_tenant_shell_for_id($1::uuid, $2::char(64), $3::char(64), $4::varchar(128))',
            [TENANT_A, digest, digest, 'RLS rehearsal fixed shell'],
          ),
        ),
      );
      expectSqlState(fixedIdFailure, '42501');
    });


    it('cannot disable row level security on a tenant table', async () => {
      const failure = await captureFailure(() =>
        asAppRole(fixturePool, TENANT_A, (client) =>
          client.query('ALTER TABLE agentos.customers DISABLE ROW LEVEL SECURITY'),
        ),
      );

      expectSqlState(failure, '42501');
      expect(String(failure)).toMatch(/permission denied|must be owner/i);
    });

    it('reads a tenant table as agentos_app inside the binder role switch', async () => {
      const observed = await withTenantContext(TENANT_A, async (client) => {
        const result = await client.query<UserRow>('SELECT current_user AS db_user');

        return result.rows[0]?.db_user ?? '';
      });

      expect(observed).toBe('agentos_app');
    });
  });
  describe('identity role boundary', () => {
    it('denies direct global identity reads and exposes email lookup only through agentos_auth', async () => {
      for (const table of ['users', 'auth_sessions', 'invitations']) {
        const failure = await captureFailure(() =>
          asAppRole(fixturePool, null, (client) => client.query(`SELECT * FROM agentos.${table}`)),
        );
        expectSqlState(failure, '42501');
      }

      const directFunctionFailure = await captureFailure(() =>
        asAppRole(fixturePool, null, (client) =>
          client.query('SELECT * FROM agentos.auth_find_user_by_email($1)', ['fixture-identity-a@example.com']),
        ),
      );
      expectSqlState(directFunctionFailure, '42501');

      // A refused statement aborts its transaction; keep the successful accessor
      // in a separate transaction rather than masking it with SQLSTATE 25P02.
      const directTableFailure = await captureFailure(() =>
        asAuthRole(fixturePool, (client) => client.query('SELECT * FROM agentos.users')),
      );
      expectSqlState(directTableFailure, '42501');
      const result = await asAuthRole(fixturePool, (client) =>
        client.query('SELECT * FROM agentos.auth_find_user_by_email($1)', ['fixture-identity-a@example.com']),
      );
      expect(result.rows.map((row: { email: string }) => row.email)).toEqual(['fixture-identity-a@example.com']);
    });

    it('isolates tenant membership rows and consumes a matching invitation only once', async () => {
      const visible = await asAppRole(fixturePool, TENANT_A, (client) =>
        client.query<{ tenant_id: string; user_id: string; role_bundle: string; status: string }>(
          'SELECT tenant_id::text AS tenant_id, user_id::text AS user_id, role_bundle, status FROM agentos.tenant_memberships ORDER BY user_id',
        ),
      );
      expect(visible.rows).toEqual([{
        tenant_id: TENANT_A,
        user_id: IDENTITY_USER_A,
        role_bundle: 'COMPANY_ADMIN',
        status: 'ACTIVE',
      }]);

      const accepted = await asAuthRole(fixturePool, async (client) => {
        const first = await client.query(
          'SELECT * FROM agentos.auth_consume_invitation($1, $2::uuid)',
          [IDENTITY_INVITE_HASH, IDENTITY_USER_A],
        );
        const second = await client.query(
          'SELECT * FROM agentos.auth_consume_invitation($1, $2::uuid)',
          [IDENTITY_INVITE_HASH, IDENTITY_USER_A],
        );
        return { first: first.rows, second: second.rows };
      });
      expect(accepted.first).toEqual([{ tenant_id: TENANT_B, role_bundle: 'OPERATOR' }]);
      expect(accepted.second).toEqual([]);
    });
  });

  describe('missing tenant context fails closed', () => {
    it('returns 0 rows and rejects INSERT with no tenant setting at all', async () => {
      const isolated = new Pool({ connectionString, max: 1 });
      const customerId = randomUUID();

      try {
        const outcome = await asAppRole(isolated, null, async (client) => {
          const setting = await tenantSettingOf(client);
          const visible = await visibleFixtureTenants(client);
          const rejectedInsert = await captureFailure(() =>
            client.query(INSERT_NEW_CUSTOMER, [customerId, TENANT_A, 'fixture-no-context']),
          );

          return { setting, visible, rejectedInsert };
        });

        expect(outcome.setting === null || outcome.setting.trim() === '').toBe(true);
        expect(outcome.visible).toEqual([]);
        expectTenantWriteRefusal(outcome.rejectedInsert);
        await expectCustomerAbsent(fixturePool, customerId);
      } finally {
        await isolated.end();
      }
    });

    it('treats an empty tenant setting as deny, never allow-all', async () => {
      const customerId = randomUUID();
      const outcome = await asAppRole(fixturePool, null, async (client) => {
        await client.query("SELECT set_config('app.current_tenant_id', '', false)");

        const visible = await visibleFixtureTenants(client);
        const rejectedInsert = await captureFailure(() =>
          client.query(INSERT_NEW_CUSTOMER, [customerId, TENANT_A, 'fixture-empty-context']),
        );

        return { visible, rejectedInsert };
      });

      expect(outcome.visible).toEqual([]);
      expectTenantWriteRefusal(outcome.rejectedInsert);
      await expectCustomerAbsent(fixturePool, customerId);
    });
  });

  describe('tenant isolation', () => {
    it('hides tenant B from tenant A and refuses tenant-B writes', async () => {
      const customerId = randomUUID();
      const outcome = await asAppRole(fixturePool, TENANT_A, async (client) => {
        const visible = await visibleFixtureTenants(client);
        const seesCustomerB = await customerVisible(client, CUSTOMER_B);
        const hijackUpdate = await client.query(
          "UPDATE agentos.customers SET display_name = 'fixture-hijack' WHERE id = $1",
          [CUSTOMER_B],
        );
        const rejectedInsert = await captureFailure(() =>
          client.query(INSERT_NEW_CUSTOMER, [customerId, TENANT_B, 'fixture-cross-insert']),
        );

        return { visible, seesCustomerB, hijackUpdate, rejectedInsert };
      });

      expect(outcome.visible).toEqual([TENANT_A]);
      expect(outcome.seesCustomerB).toBe(false);
      expect(outcome.hijackUpdate.rowCount).toBe(0);
      expectTenantWriteRefusal(outcome.rejectedInsert);
      await expectCustomerAbsent(fixturePool, customerId);
    });

    it('hides tenant A from tenant B and refuses tenant-A writes', async () => {
      const customerId = randomUUID();
      const outcome = await asAppRole(fixturePool, TENANT_B, async (client) => {
        const visible = await visibleFixtureTenants(client);
        const seesCustomerA = await customerVisible(client, CUSTOMER_A);
        const hijackUpdate = await client.query(
          "UPDATE agentos.customers SET display_name = 'fixture-hijack' WHERE id = $1",
          [CUSTOMER_A],
        );
        const rejectedInsert = await captureFailure(() =>
          client.query(INSERT_NEW_CUSTOMER, [customerId, TENANT_A, 'fixture-cross-insert']),
        );

        return { visible, seesCustomerA, hijackUpdate, rejectedInsert };
      });

      expect(outcome.visible).toEqual([TENANT_B]);
      expect(outcome.seesCustomerA).toBe(false);
      expect(outcome.hijackUpdate.rowCount).toBe(0);
      expectTenantWriteRefusal(outcome.rejectedInsert);
      await expectCustomerAbsent(fixturePool, customerId);
    });
  });
  describe('customer 360 consent aggregation', () => {
    it('lets any opt-out suppress marketing consent instead of allowing an opt-in to win', async () => {
      const client = await fixturePool.connect();

      try {
        await beginAppRole(client, TENANT_A);
        await client.query(
          `INSERT INTO agentos.consents (
             tenant_id, customer_id, consent_type, channel, is_granted, opt_in_method, opt_in_timestamp
           ) VALUES ($1, $2, 'marketing_messaging', 'line', TRUE, 'web_form', CURRENT_TIMESTAMP),
                    ($1, $2, 'marketing_messaging', 'email', FALSE, 'web_form', CURRENT_TIMESTAMP)`,
          [TENANT_A, CUSTOMER_A],
        );

        const result = await client.query<{
          consent_marketing: boolean;
          suppression_active: boolean;
        }>(
          `SELECT consent_marketing, suppression_active
             FROM agentos.customer_360_profiles
            WHERE tenant_id = $1 AND customer_id = $2`,
          [TENANT_A, CUSTOMER_A],
        );

        expect(result.rows).toEqual([{ consent_marketing: false, suppression_active: true }]);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });
  });

  describe('tenant governance settings', () => {
    it('allows tenant-scoped updates only to the governance policy columns', async () => {
      const visibleA = await asAppRole(fixturePool, TENANT_A, (client) =>
        client.query<{ tenant_id: string; require_distinct_approver: boolean }>(
          'SELECT tenant_id::text AS tenant_id, require_distinct_approver FROM agentos.tenant_governance_settings WHERE tenant_id = ANY($1::uuid[]) ORDER BY tenant_id',
          [[TENANT_A, TENANT_B]],
        ),
      );
      const visibleB = await asAppRole(fixturePool, TENANT_B, (client) =>
        client.query<{ tenant_id: string; require_distinct_approver: boolean }>(
          'SELECT tenant_id::text AS tenant_id, require_distinct_approver FROM agentos.tenant_governance_settings WHERE tenant_id = ANY($1::uuid[]) ORDER BY tenant_id',
          [[TENANT_A, TENANT_B]],
        ),
      );
      const updated = await asAppRole(fixturePool, TENANT_A, (client) =>
        client.query(
          `UPDATE agentos.tenant_governance_settings
              SET require_distinct_approver = false,
                  approval_expiry_hours = 48,
                  takeover_lease_seconds = 180,
                  version = version + 1,
                  updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id = $1
            RETURNING require_distinct_approver, approval_expiry_hours, takeover_lease_seconds, version`,
          [TENANT_A],
        ),
      );
      const rejectedInsert = await captureFailure(() =>
        asAppRole(fixturePool, TENANT_A, (client) =>
          client.query(
            'INSERT INTO agentos.tenant_governance_settings (tenant_id, require_distinct_approver) VALUES ($1, $2)',
            [TENANT_A, false],
          ),
        ),
      );
      const rejectedTenantIdUpdate = await captureFailure(() =>
        asAppRole(fixturePool, TENANT_A, (client) =>
          client.query(
            'UPDATE agentos.tenant_governance_settings SET tenant_id = $1 WHERE tenant_id = $2',
            [TENANT_B, TENANT_A],
          ),
        ),
      );
      const rejectedDelete = await captureFailure(() =>
        asAppRole(fixturePool, TENANT_A, (client) =>
          client.query('DELETE FROM agentos.tenant_governance_settings WHERE tenant_id = $1', [TENANT_A]),
        ),
      );

      expect(visibleA.rows).toEqual([
        { tenant_id: TENANT_A, require_distinct_approver: true },
      ]);
      expect(visibleB.rows).toEqual([
        { tenant_id: TENANT_B, require_distinct_approver: false },
      ]);
      expect(updated.rows).toEqual([{
        require_distinct_approver: false,
        approval_expiry_hours: 48,
        takeover_lease_seconds: 180,
        version: 2,
      }]);
      expectSqlState(rejectedInsert, '42501');
      expectSqlState(rejectedTenantIdUpdate, '42501');
      expectSqlState(rejectedDelete, '42501');
    });
  });

  describe('audit chain sequence migration', () => {
    it('assigns tenant-local chain_seq in insert order and ignores caller timestamps', async () => {
      const client = await fixturePool.connect();

      try {
        await beginAppRole(client, TENANT_A);
        const audit = new AuditRepository(async (_tenantId, work) => work(client));
        const common = {
          tenant_id: TENANT_A,
          agent_id: 'rls-audit-agent',
          customer_or_entity_id: CUSTOMER_A,
          trigger: 'rls.rehearsal',
          context: { fixture: true },
          skill: 'rls.audit.sequence',
          tool: 'fixture',
          decision: { verdict: 'ALLOW' },
          authority: 'AUTH-3' as const,
          approval: null,
          action: { type: 'fixture' },
          execution_status: 'success' as const,
          evidence: { source: 'rls-rehearsal' },
          outcome: { accepted: true },
          latency_ms: 1,
          cost: { tokens: 1 },
          error: null,
        };

        await audit.append({
          ...common,
          run_id: 'RLS-AUDIT-SEQ-1',
          timestamp: '2099-01-01T00:00:00.000Z',
        });
        await audit.append({
          ...common,
          run_id: 'RLS-AUDIT-SEQ-2',
          timestamp: '1970-01-01T00:00:00.000Z',
        });

        const result = await client.query<{ chain_seq: string; timestamp: Date }>(
          'SELECT chain_seq::text AS chain_seq, "timestamp" FROM agentos.audit_records WHERE tenant_id = $1 ORDER BY chain_seq',
          [TENANT_A],
        );

        expect(result.rows.map((row) => row.chain_seq)).toEqual(['1', '2']);
        expect(new Set(result.rows.map((row) => row.chain_seq)).size).toBe(result.rows.length);
        expect(result.rows.every((row) => row.timestamp.getUTCFullYear() !== 2099 && row.timestamp.getUTCFullYear() !== 1970)).toBe(true);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });
  });

  describe('transaction-scoped tenant context on a reused connection', () => {
    it('does not carry a committed tenant into the next transaction or the session (max-1 pool)', async () => {
      const single = new Pool({ connectionString, max: 1 });

      try {
        const client = await single.connect();

        try {
          await beginAppRole(client, TENANT_A);
          const visibleToA = await visibleFixtureTenants(client);
          await client.query('COMMIT');

          const pid = await backendPidOf(client);
          const afterCommit = await tenantSettingOf(client);

          // Second transaction on the SAME backend, with no new set_config.
          await beginAppRole(client, null);
          const withoutContext = await visibleFixtureTenants(client);
          const settingWithoutContext = await tenantSettingOf(client);
          await client.query('COMMIT');

          const pidAfterSecond = await backendPidOf(client);

          // Third transaction: tenant B only.
          await beginAppRole(client, TENANT_B);
          const visibleToB = await visibleFixtureTenants(client);
          const seesCustomerA = await customerVisible(client, CUSTOMER_A);
          await client.query('COMMIT');

          expect(visibleToA).toEqual([TENANT_A]);
          expect(pid).toBeGreaterThan(0);
          expect(pidAfterSecond).toBe(pid);
          expect(afterCommit === null || afterCommit.trim() === '').toBe(true);
          expect(settingWithoutContext === null || settingWithoutContext.trim() === '').toBe(true);
          expect(withoutContext).toEqual([]);
          expect(visibleToB).toEqual([TENANT_B]);
          expect(seesCustomerA).toBe(false);
        } finally {
          client.release();
        }
      } finally {
        await single.end();
      }
    });

    it('scopes each withTenantContext call and never observes the previous tenant', async () => {
      const pool = getPool();

      const scopeOf = async (tenantId: string): Promise<{
        backendPid: number;
        dbUser: string;
        setting: string | null;
        visible: string[];
        seesCustomerA: boolean;
        seesCustomerB: boolean;
      }> =>
        withTenantContext(tenantId, async (client) => ({
          backendPid: await backendPidOf(client),
          dbUser: (await client.query<UserRow>('SELECT current_user AS db_user')).rows[0]?.db_user ?? '',
          setting: await tenantSettingOf(client),
          visible: await visibleFixtureTenants(client),
          seesCustomerA: await customerVisible(client, CUSTOMER_A),
          seesCustomerB: await customerVisible(client, CUSTOMER_B),
        }));

      const first = await scopeOf(TENANT_A);
      const second = await scopeOf(TENANT_B);

      expect(first.dbUser).toBe('agentos_app');
      expect(second.dbUser).toBe('agentos_app');
      expect(first.setting).toBe(TENANT_A);
      expect(first.visible).toEqual([TENANT_A]);
      expect(first.seesCustomerB).toBe(false);

      // The pool served both sequential calls from one backend, so the second call
      // landed on the connection the first call had returned.
      expect(pool.totalCount).toBe(1);
      expect(second.backendPid).toBe(first.backendPid);
      expect(second.setting).toBe(TENANT_B);
      expect(second.visible).toEqual([TENANT_B]);
      expect(second.seesCustomerA).toBe(false);
      expect(second.seesCustomerB).toBe(true);
    });

    it('clears the session tenant setting before the connection returns to the pool', async () => {
      const pool = getPool();
      const pidInsideBinder = await withTenantContext(TENANT_A, (client) => backendPidOf(client));

      const client = await pool.connect();

      try {
        expect(await backendPidOf(client)).toBe(pidInsideBinder);
        const setting = await tenantSettingOf(client);

        expect(setting === null || setting.trim() === '').toBe(true);
      } finally {
        client.release();
      }
    });
    it('expires only the approvals in the tenant context', async () => {
      const actionInsert =
        'INSERT INTO agentos.actions (id, tenant_id, skill_name, effect_key, target_channel, action_payload) ' +
        "VALUES ($1, $2, 'rls-sweep', $3, 'test', '{}'::jsonb)";
      const approvalInsert =
        'INSERT INTO agentos.approvals (id, tenant_id, run_id, action_id, effect_key, payload, reason, expires_at) ' +
        "VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 'RLS sweep fixture', CURRENT_TIMESTAMP - INTERVAL '1 minute')";

      await fixturePool.query(actionInsert, [SWEEP_ACTION_A, TENANT_A, 'rls-sweep-a']);
      await fixturePool.query(actionInsert, [SWEEP_ACTION_B, TENANT_B, 'rls-sweep-b']);
      await fixturePool.query(approvalInsert, [
        SWEEP_APPROVAL_A,
        TENANT_A,
        'rls-sweep-run-a',
        SWEEP_ACTION_A,
        'rls-sweep-a',
      ]);
      await fixturePool.query(approvalInsert, [
        SWEEP_APPROVAL_B,
        TENANT_B,
        'rls-sweep-run-b',
        SWEEP_ACTION_B,
        'rls-sweep-b',
      ]);

      try {
        await expect(new ApprovalRepository().expireOverdueApprovals(TENANT_A, 500)).resolves.toEqual([
          SWEEP_APPROVAL_A,
        ]);

        const stateA = await asAppRole(fixturePool, TENANT_A, (client) =>
          client.query<SweepStateRow>(
            'SELECT p.decision, a.status AS action_status FROM agentos.approvals p JOIN agentos.actions a ON a.tenant_id = p.tenant_id AND a.id = p.action_id WHERE p.id = ANY($1::uuid[]) ORDER BY p.id',
            [[SWEEP_APPROVAL_A, SWEEP_APPROVAL_B]],
          ),
        );
        expect(stateA.rows).toEqual([{ decision: 'EXPIRED', action_status: 'failed' }]);

        const stateB = await asAppRole(fixturePool, TENANT_B, (client) =>
          client.query<SweepStateRow>(
            'SELECT p.decision, a.status AS action_status FROM agentos.approvals p JOIN agentos.actions a ON a.tenant_id = p.tenant_id AND a.id = p.action_id WHERE p.id = $1',
            [SWEEP_APPROVAL_B],
          ),
        );
        expect(stateB.rows).toEqual([{ decision: 'PENDING', action_status: 'pending' }]);
      } finally {
        await fixturePool.query('DELETE FROM agentos.approvals WHERE id = ANY($1::uuid[])', [
          [SWEEP_APPROVAL_A, SWEEP_APPROVAL_B],
        ]);
        await fixturePool.query('DELETE FROM agentos.actions WHERE id = ANY($1::uuid[])', [
          [SWEEP_ACTION_A, SWEEP_ACTION_B],
        ]);
      }
    });
  });

  describe('composite tenant-scoped foreign keys', () => {
    it('rejects orders whose customer belongs to another tenant and accepts a same-tenant insert', async () => {
      const failure = await captureFailure(() =>
        asAppRole(fixturePool, TENANT_B, (client) =>
          client.query(INSERT_ORDER, [randomUUID(), TENANT_B, CUSTOMER_A, 'FIXTURE-ORDER-XTENANT']),
        ),
      );

      expectSqlState(failure, '23503');

      const accepted = await asAppRole(fixturePool, TENANT_B, (client) =>
        client.query(INSERT_ORDER, [randomUUID(), TENANT_B, CUSTOMER_B, 'FIXTURE-ORDER-SAME']),
      );

      expect(accepted.rowCount).toBe(1);
    });

    it('rejects re-pointing a customer identity at another tenant and accepts a same-tenant update', async () => {
      const failure = await captureFailure(() =>
        asAppRole(fixturePool, TENANT_B, (client) =>
          client.query('UPDATE agentos.customer_identities SET customer_id = $1 WHERE id = $2', [
            CUSTOMER_A,
            IDENTITY_B,
          ]),
        ),
      );

      expectSqlState(failure, '23503');

      const accepted = await asAppRole(fixturePool, TENANT_B, (client) =>
        client.query('UPDATE agentos.customer_identities SET customer_id = $1 WHERE id = $2', [
          CUSTOMER_B,
          IDENTITY_B,
        ]),
      );

      expect(accepted.rowCount).toBe(1);
    });

    it('rejects recommendations referencing another tenant product and accepts a same-tenant insert', async () => {
      const failure = await captureFailure(() =>
        asAppRole(fixturePool, TENANT_B, (client) =>
          client.query(INSERT_RECOMMENDATION, [
            randomUUID(),
            TENANT_B,
            CUSTOMER_B,
            PRODUCT_A,
          ]),
        ),
      );

      expectSqlState(failure, '23503');

      const accepted = await asAppRole(fixturePool, TENANT_B, (client) =>
        client.query(INSERT_RECOMMENDATION, [
          randomUUID(),
          TENANT_B,
          CUSTOMER_B,
          PRODUCT_B,
        ]),
      );

      expect(accepted.rowCount).toBe(1);
    });

    it('rejects service cases referencing another tenant conversation and accepts a same-tenant insert', async () => {
      const failure = await captureFailure(() =>
        asAppRole(fixturePool, TENANT_B, (client) =>
          client.query(INSERT_SERVICE_CASE, [
            randomUUID(),
            TENANT_B,
            CUSTOMER_B,
            CONVERSATION_A,
            'FIXTURE-CASE-XTENANT',
          ]),
        ),
      );

      expectSqlState(failure, '23503');

      const accepted = await asAppRole(fixturePool, TENANT_B, (client) =>
        client.query(INSERT_SERVICE_CASE, [
          randomUUID(),
          TENANT_B,
          CUSTOMER_B,
          CONVERSATION_B,
          'FIXTURE-CASE-SAME',
        ]),
      );

      expect(accepted.rowCount).toBe(1);
    });
    it('isolates durable case receipts to their tenant and parent case', async () => {
      const caseIdA = randomUUID();
      const caseIdB = randomUUID();
      const receiptKey = () => randomUUID().replaceAll('-', '').repeat(2);

      await asAppRole(fixturePool, TENANT_A, (client) =>
        client.query(INSERT_SERVICE_CASE, [
          caseIdA,
          TENANT_A,
          CUSTOMER_A,
          CONVERSATION_A,
          `RLS-CASE-${caseIdA}`,
        ]),
      );
      await asAppRole(fixturePool, TENANT_B, (client) =>
        client.query(INSERT_SERVICE_CASE, [
          caseIdB,
          TENANT_B,
          CUSTOMER_B,
          CONVERSATION_B,
          `RLS-CASE-${caseIdB}`,
        ]),
      );

      await asAppRole(fixturePool, TENANT_A, (client) =>
        client.query(INSERT_SERVICE_CASE_EVENT, [TENANT_A, caseIdA, receiptKey(), receiptKey()]),
      );
      await asAppRole(fixturePool, TENANT_B, (client) =>
        client.query(INSERT_SERVICE_CASE_EVENT, [TENANT_B, caseIdB, receiptKey(), receiptKey()]),
      );

      const visible = await asAppRole(fixturePool, TENANT_A, (client) =>
        client.query<{ case_id: string }>('SELECT case_id::text AS case_id FROM agentos.service_case_events WHERE case_id = ANY($1::uuid[]) ORDER BY case_id', [[caseIdA, caseIdB]]),
      );
      expect(visible.rows.map((row) => row.case_id)).toEqual([caseIdA]);

      const updateReceipt = await captureFailure(() =>
        asAppRole(fixturePool, TENANT_A, (client) =>
          client.query("UPDATE agentos.service_case_events SET actor_id = 'tampered' WHERE case_id = $1", [caseIdA]),
        ),
      );
      expectSqlState(updateReceipt, '42501');
      const deleteReceipt = await captureFailure(() =>
        asAppRole(fixturePool, TENANT_A, (client) =>
          client.query('DELETE FROM agentos.service_case_events WHERE case_id = $1', [caseIdA]),
        ),
      );
      expectSqlState(deleteReceipt, '42501');
      const mismatchedCase = await captureFailure(() =>
        asAppRole(fixturePool, TENANT_A, (client) =>
          client.query(INSERT_SERVICE_CASE_EVENT, [TENANT_A, caseIdB, receiptKey(), receiptKey()]),
        ),
      );
      expectSqlState(mismatchedCase, '23503');
    });
  });
  describe('platform directory role boundary', () => {
    const platformCalls: readonly { readonly sql: string; readonly values: unknown[] }[] = [
      { sql: 'SELECT * FROM agentos.platform_list_tenants()', values: [] },
      { sql: 'SELECT * FROM agentos.platform_get_tenant($1::uuid)', values: [TENANT_A] },
      { sql: 'SELECT * FROM agentos.platform_tenant_readiness($1::uuid)', values: [TENANT_A] },
      {
        sql: 'SELECT * FROM agentos.platform_usage($1::timestamptz, $2::timestamptz)',
        values: ['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'],
      },
    ];

    it('denies every platform projection to agentos_app without SET ROLE', async () => {
      for (const call of platformCalls) {
        const failure = await captureFailure(() =>
          asAppRole(fixturePool, null, (client) => client.query(call.sql, call.values)),
        );
        expectSqlState(failure, '42501');
      }
    });
    it('does not allow the application role to assume the platform capability role', async () => {
      const memberships = await fixturePool.query(
        `SELECT membership.*
           FROM pg_catalog.pg_auth_members AS membership
           JOIN pg_catalog.pg_roles AS capability ON capability.oid = membership.roleid
           JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
          WHERE capability.rolname = 'agentos_platform' AND member.rolname = 'agentos_app'`,
      );
      expect(memberships.rows).toEqual([]);
      const canAssume = await fixturePool.query<{ can_assume: boolean }>(
        "SELECT pg_catalog.pg_has_role('agentos_app', 'agentos_platform', 'SET') AS can_assume",
      );
      expect(canAssume.rows[0]?.can_assume).toBe(false);

      const client = await fixturePool.connect();
      try {
        await client.query('BEGIN');
        // SET ROLE authorization checks session_user, not current_user. Merely
        // switching a superuser fixture session to app would still allow platform.
        await client.query('SET LOCAL SESSION AUTHORIZATION agentos_app');
        const identity = await client.query<{ session_user: string; current_user: string }>(
          'SELECT session_user, current_user',
        );
        expect(identity.rows[0]).toEqual({ session_user: 'agentos_app', current_user: 'agentos_app' });
        const failure = await captureFailure(() => client.query('SET LOCAL ROLE agentos_platform'));
        expectSqlState(failure, '42501');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });


    it('allows the explicit platform role and publishes no customer columns', async () => {
      const dedicatedPlatformPool = platformPool;
      if (dedicatedPlatformPool === undefined) throw new Error('PLATFORM_POOL_NOT_INITIALIZED');
      const columns = await asPlatformRole(dedicatedPlatformPool, async (client) => {
        const list = await client.query('SELECT * FROM agentos.platform_list_tenants()');
        const tenant = await client.query('SELECT * FROM agentos.platform_get_tenant($1::uuid)', [TENANT_A]);
        const readiness = await client.query('SELECT * FROM agentos.platform_tenant_readiness($1::uuid)', [TENANT_A]);
        const usage = await client.query(
          'SELECT * FROM agentos.platform_usage($1::timestamptz, $2::timestamptz)',
          ['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z'],
        );
        return [list, tenant, readiness, usage].map((result) => result.fields.map((field) => field.name));
      });

      for (const resultColumns of columns) {
        expect(resultColumns).not.toContain('customer_id');
        expect(resultColumns).not.toContain('primary_email');
        expect(resultColumns).not.toContain('primary_phone');
        expect(resultColumns).not.toContain('display_name_customer');
      }
    });

    it('restricts lifecycle writes to the platform command and its exact tenant context', async () => {
      const denied = await captureFailure(() => asAppRole(fixturePool, TENANT_A, (client) =>
        client.query('SELECT * FROM agentos.platform_set_tenant_status($1::uuid, $2::text)', [TENANT_A, 'SUSPENDED']),
      ));
      expectSqlState(denied, '42501');
      const dedicatedPlatformPool = platformPool;
      if (dedicatedPlatformPool === undefined) throw new Error('PLATFORM_POOL_NOT_INITIALIZED');
      const mismatch = await captureFailure(() => asPlatformRole(dedicatedPlatformPool, async (client) => {
        await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_A]);
        return client.query('SELECT * FROM agentos.platform_set_tenant_status($1::uuid, $2::text)', [TENANT_B, 'SUSPENDED']);
      }));
      expectSqlState(mismatch, '42501');
      try {
        await asPlatformRole(dedicatedPlatformPool, async (client) => {
          await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_B]);
          const result = await client.query('SELECT * FROM agentos.platform_set_tenant_status($1::uuid, $2::text)', [TENANT_B, 'SUSPENDED']);
          expect(result.rows).toEqual([{ tenant_id: TENANT_B, status: 'SUSPENDED' }]);
          const privileges = await client.query(
            "SELECT has_table_privilege('agentos_app', 'agentos.tenants', 'UPDATE') AS app_update, has_table_privilege('agentos_platform', 'agentos.tenants', 'UPDATE') AS platform_update",
          );
          expect(privileges.rows).toEqual([{ app_update: false, platform_update: false }]);
        });
      } finally {
        await asPlatformRole(dedicatedPlatformPool, async (client) => {
          await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [TENANT_B]);
          await client.query('SELECT * FROM agentos.platform_set_tenant_status($1::uuid, $2::text)', [TENANT_B, 'ACTIVE']);
        });
      }
    });

    it('seeds contract-derived read and draft clearances only for new agents, without assigning AUTH-4', async () => {
      const client = await fixturePool.connect();
      try {
        await client.query('BEGIN');
        // Isolate this SQL unit from whichever code-synced catalog the rehearsal started with.
        // Every catalog, tenant, and grant write in this test is rolled back together.
        await client.query('UPDATE agentos.skill_catalog SET retired = true');
        const contracts = [
          { skill: 'skill.sales.baseline_stock', effect: 'READ', authority: 'AUTH-0', agent: 'SAL-02' },
          { skill: 'skill.sales.baseline_price', effect: 'READ', authority: 'AUTH-3', agent: 'SAL-02' },
          { skill: 'skill.marketing.baseline_segment', effect: 'INTERNAL', authority: 'AUTH-1', agent: 'MKT-02' },
          { skill: 'skill.marketing.baseline_content', effect: 'INTERNAL', authority: 'AUTH-2', agent: 'MKT-03' },
          { skill: 'skill.marketing.baseline_external', effect: 'EFFECT', authority: 'AUTH-3', agent: 'MKT-03' },
          { skill: 'skill.marketing.baseline_approval', effect: 'APPROVAL', authority: 'AUTH-4', agent: 'MKT-03' },
          { skill: 'skill.marketing.baseline_read_approval', effect: 'READ', authority: 'AUTH-4', agent: 'MKT-03' },
        ];
        for (const contract of contracts) {
          await client.query(
            `INSERT INTO agentos.skill_catalog
              (skill_id, display_key, domain, effect_class, required_authority, autonomy_class,
               completion, receipt_ref, tool_binding, allowed_agents, contract_version, contract_digest)
             VALUES ($1, $1, $2, $3, $4, 'PROMOTABLE', 'SYNC', $1, $1, ARRAY[$5]::text[], 1, $6)`,
            [contract.skill, contract.skill.startsWith('skill.sales.') ? 'sales' : 'marketing',
              contract.effect, contract.authority, contract.agent, 'a'.repeat(64)],
          );
        }
        const key = randomUUID().replaceAll('-', '').padEnd(64, '0');
        const provisionSql = "SELECT agentos.provision_tenant_shell($1::char(64), $1::char(64), 'baseline SQL regression', 'TEST'::agentos.data_class) AS tenant_id";
        const tenant_id = (await client.query<{ tenant_id: string }>(provisionSql, [key])).rows[0]?.tenant_id;
        if (tenant_id === undefined) throw new Error('PROVISIONING_TENANT_REQUIRED');
        const grantsSql = 'SELECT code, assigned_authority, is_active FROM agentos.agents WHERE tenant_id = $1 ORDER BY code';
        const grants = (await client.query<{ code: string; assigned_authority: string; is_active: boolean }>(grantsSql, [tenant_id])).rows;
        expect(grants.find((agent) => agent.code === 'SAL-02')?.assigned_authority).toBe('AUTH-3');
        expect(grants.find((agent) => agent.code === 'MKT-02')?.assigned_authority).toBe('AUTH-1');
        expect(grants.find((agent) => agent.code === 'MKT-03')?.assigned_authority).toBe('AUTH-2');
        expect(grants.find((agent) => agent.code === 'SAL-01')?.assigned_authority).toBe('AUTH-0');
        expect(grants.every((agent) => ['AUTH-0', 'AUTH-1', 'AUTH-2', 'AUTH-3'].includes(agent.assigned_authority))).toBe(true);
        expect(grants.every((agent) => !agent.is_active)).toBe(true);
        await client.query("UPDATE agentos.agents SET assigned_authority = 'AUTH-0' WHERE tenant_id = $1 AND code = 'SAL-02'", [tenant_id]);
        await client.query(provisionSql, [key]);
        const replayed = await client.query<{ code: string; assigned_authority: string }>(grantsSql, [tenant_id]);
        expect(replayed.rows.find((agent) => agent.code === 'SAL-02')?.assigned_authority).toBe('AUTH-0');
        const events = await client.query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM agentos.provisioning_events
            WHERE tenant_id = $1 AND idempotency_key = $2 AND event_type = 'TENANT_PROVISIONED'`,
          [tenant_id, key],
        );
        expect(events.rows[0]?.count).toBe(1);
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    });
  });
});
