import type { PoolClient } from 'pg';

import { getPool } from './client.js';

/**
 * Single-tenant context: one UUID in 8-4-4-4-12 hex form. A comma-separated list is
 * refused even though the RLS predicate parses one, because a request must never be
 * allowed to select its own multi-tenant scope.
 */
const TENANT_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Application role the tenant transaction runs as; it owns no BYPASSRLS (NFR-006). */
const APPLICATION_ROLE = 'agentos_app';

/** Schema search order inside the tenant transaction. */
const SEARCH_PATH = 'agentos, public';

/** Session setting the RLS predicate reads, as `app.current_tenant_id`. */
const TENANT_CONTEXT_SETTING = 'app.current_tenant_id';

/**
 * Refuses a tenant id that cannot be bound as exactly one RLS context.
 *
 * Exported so a writer can prove its tenant binding before it does any other work,
 * including before `getPool()` is ever called.
 *
 * @param tenantId - Candidate tenant identifier.
 * @returns Nothing when the value is a single tenant UUID.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when the value is blank, padded, comma-separated or not one UUID.
 */
export function assertTenantContext(tenantId: string): void {
  if (!TENANT_UUID_PATTERN.test(tenantId)) {
    throw new Error(
      'TENANT_CONTEXT_REQUIRED: refusing to open an unscoped database transaction; '
        + 'expected exactly one tenant UUID (NFR-006).',
    );
  }
}

/**
 * Executes a callback inside a scoped transaction where the PostgreSQL session
 * setting `app.current_tenant_id` is bound, which is what the row-level security
 * policies isolate tenants by (NFR-006).
 *
 * The binder is the only sanctioned way to touch tenant data. It downgrades the
 * transaction to the `agentos_app` application role, pins `search_path` to the
 * `agentos` schema, and binds the tenant with `set_config(name, value, true)`:
 * the parameterised form of `SET LOCAL`, because the extended query protocol
 * rejects `SET LOCAL ... = $1`. The value is transaction-local, so `COMMIT` or
 * `ROLLBACK` already clears it; the session-level reset before release is a second
 * guard so a pooled connection can never leak the previous tenant's context. The
 * policy DDL itself lives in `migrations/0002_rls_policies.sql`, not in this module.
 *
 * @param tenantId - Authenticated tenant UUID bound to the transaction.
 * @param callback - Work executed against the tenant-scoped client.
 * @returns The callback result once the transaction commits.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank or not a single UUID, before any pool connection is opened.
 * @throws Error The callback error, after the transaction has been rolled back.
 */
export async function withTenantContext<T>(
  tenantId: string,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  assertTenantContext(tenantId);

  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${APPLICATION_ROLE}`);
    await client.query(`SET LOCAL search_path TO ${SEARCH_PATH}`);
    await client.query(`SELECT set_config('${TENANT_CONTEXT_SETTING}', $1, true)`, [tenantId]);

    const result = await callback(client);

    await client.query('COMMIT');

    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Surface the original failure: a broken connection must not mask its cause.
    }

    throw error;
  } finally {
    await clearSessionTenantContext(client);
    client.release();
  }
}

/**
 * Best-effort removal of any session-level tenant context before the connection is
 * released back to the pool.
 */
async function clearSessionTenantContext(client: PoolClient): Promise<void> {
  try {
    await client.query(`SELECT set_config('${TENANT_CONTEXT_SETTING}', '', false)`);
  } catch {
    // Ignore cleanup errors: the transaction-local binding is already gone.
  }
}
