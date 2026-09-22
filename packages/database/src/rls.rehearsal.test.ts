import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getPool } from './client.js';
import { insertFact } from './repositories/customer-360.js';
import { withTenantContext } from './rls.js';

const originalDatabaseUrl = process.env.DATABASE_URL;
const hasDatabaseUrl =
  typeof originalDatabaseUrl === 'string' && originalDatabaseUrl.trim().length > 0;

/**
 * Synthetic tenant fixtures. The ids below are uuid v7-shaped values dedicated to
 * this suite; no seed or registry row is created, and nothing here is a policy
 * default. Every NOT NULL column without a DDL default is supplied explicitly.
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

const FIXTURE_TENANTS: readonly string[] = [TENANT_A, TENANT_B];

const FIXTURE_INSERTS: readonly { readonly text: string; readonly values: readonly unknown[] }[] = [
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
  'DELETE FROM agentos.evidences WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.service_cases WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.recommendations WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.orders WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.customer_identities WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.conversations WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.products WHERE tenant_id = ANY($1::uuid[])',
  'DELETE FROM agentos.customers WHERE tenant_id = ANY($1::uuid[])',
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

const INSERT_NEW_CUSTOMER =
  'INSERT INTO agentos.customers (id, tenant_id, display_name) VALUES ($1, $2, $3)';

type TenantRow = { tenant_id: string };
type CountRow = { total: number };
type PidRow = { pid: number };
type SettingRow = { tenant: string | null };
type UserRow = { db_user: string };

function sqlStateOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
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

  describe('missing tenant context fails closed', () => {
    it('returns 0 rows and rejects INSERT with no tenant setting at all', async () => {
      const isolated = new Pool({ connectionString, max: 1 });

      try {
        const outcome = await asAppRole(isolated, null, async (client) => {
          const setting = await tenantSettingOf(client);
          const visible = await visibleFixtureTenants(client);
          const rejectedInsert = await captureFailure(() =>
            client.query(INSERT_NEW_CUSTOMER, [randomUUID(), TENANT_A, 'fixture-no-context']),
          );

          return { setting, visible, rejectedInsert };
        });

        expect(outcome.setting === null || outcome.setting.trim() === '').toBe(true);
        expect(outcome.visible).toEqual([]);
        expectSqlState(outcome.rejectedInsert, '42501');
        expect(String(outcome.rejectedInsert)).toMatch(/row-level security/i);
      } finally {
        await isolated.end();
      }
    });

    it('treats an empty tenant setting as deny, never allow-all', async () => {
      const outcome = await asAppRole(fixturePool, null, async (client) => {
        await client.query("SELECT set_config('app.current_tenant_id', '', false)");

        const visible = await visibleFixtureTenants(client);
        const rejectedInsert = await captureFailure(() =>
          client.query(INSERT_NEW_CUSTOMER, [randomUUID(), TENANT_A, 'fixture-empty-context']),
        );

        return { visible, rejectedInsert };
      });

      expect(outcome.visible).toEqual([]);
      expectSqlState(outcome.rejectedInsert, '42501');
    });
  });

  describe('tenant isolation', () => {
    it('hides tenant B from tenant A and refuses tenant-B writes', async () => {
      const outcome = await asAppRole(fixturePool, TENANT_A, async (client) => {
        const visible = await visibleFixtureTenants(client);
        const seesCustomerB = await customerVisible(client, CUSTOMER_B);
        const hijackUpdate = await client.query(
          "UPDATE agentos.customers SET display_name = 'fixture-hijack' WHERE id = $1",
          [CUSTOMER_B],
        );
        const rejectedInsert = await captureFailure(() =>
          client.query(INSERT_NEW_CUSTOMER, [randomUUID(), TENANT_B, 'fixture-cross-insert']),
        );

        return { visible, seesCustomerB, hijackUpdate, rejectedInsert };
      });

      expect(outcome.visible).toEqual([TENANT_A]);
      expect(outcome.seesCustomerB).toBe(false);
      expect(outcome.hijackUpdate.rowCount).toBe(0);
      expectSqlState(outcome.rejectedInsert, '42501');
    });

    it('hides tenant A from tenant B and refuses tenant-A writes', async () => {
      const outcome = await asAppRole(fixturePool, TENANT_B, async (client) => {
        const visible = await visibleFixtureTenants(client);
        const seesCustomerA = await customerVisible(client, CUSTOMER_A);
        const hijackUpdate = await client.query(
          "UPDATE agentos.customers SET display_name = 'fixture-hijack' WHERE id = $1",
          [CUSTOMER_A],
        );
        const rejectedInsert = await captureFailure(() =>
          client.query(INSERT_NEW_CUSTOMER, [randomUUID(), TENANT_A, 'fixture-cross-insert']),
        );

        return { visible, seesCustomerA, hijackUpdate, rejectedInsert };
      });

      expect(outcome.visible).toEqual([TENANT_B]);
      expect(outcome.seesCustomerA).toBe(false);
      expect(outcome.hijackUpdate.rowCount).toBe(0);
      expectSqlState(outcome.rejectedInsert, '42501');
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
  });
});
