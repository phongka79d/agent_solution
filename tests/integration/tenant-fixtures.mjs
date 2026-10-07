import { createHash } from 'node:crypto';

/**
 * Ensures a fixed local/CI pilot tenant exists without putting any fixture identity in migrations.
 * The database function enforces the app.current_tenant_id fence and rejects identity drift.
 */
export async function ensureIntegrationTenant(db, tenant_id, label) {
  const digest = createHash('sha256').update(`agentos-integration:${label}:${tenant_id}`).digest('hex');
  await db.withTenantContext(tenant_id, async (client) => {
    await client.query('SET LOCAL ROLE agentos_platform');
    await client.query(
      'SELECT agentos.provision_tenant_shell_for_id($1::uuid,$2::char(64),$3::char(64),$4::varchar(128)) AS tenant_id',
      [tenant_id, digest, digest, `Integration ${label} tenant`],
    );
  });
}
