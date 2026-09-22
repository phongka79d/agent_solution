import type { PoolClient } from 'pg';

import { getPool } from './client.js';

/**
 * Executes a callback inside a scoped transaction where the PostgreSQL session
 * variable `app.current_tenant_id` is bound, which is how row-level security
 * policies isolate tenants (NFR-006).
 *
 * The binder is the only sanctioned way to touch tenant data: `set_config(name,
 * value, true)` is transaction-local, so a connection returned to the pool never
 * carries the previous tenant's context. This package creates no tables and owns
 * no policy DDL.
 *
 * @param tenantId - Authenticated tenant identifier bound to the transaction.
 * @param callback - Work executed against the tenant-scoped client.
 * @returns The callback result once the transaction commits.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is empty or whitespace only.
 * @throws Error The callback error, after the transaction is rolled back.
 */
export async function withTenantContext<T>(
  tenantId: string,
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (tenantId.trim().length === 0) {
    throw new Error(
      'TENANT_CONTEXT_REQUIRED: refusing to open an unscoped database transaction (NFR-006).',
    );
  }

  const client = await getPool().connect();

  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenantId]);

    const result = await callback(client);

    await client.query('COMMIT');

    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
