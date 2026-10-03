/**
 * Ensures a fixed local/CI pilot tenant exists without putting any fixture identity in migrations.
 * Reuses shells from earlier suites; new shells use the same stable identity as the RLS policy suite.
 */
export async function ensureIntegrationTenant(db, tenant_id, label) {
  const existing = await db.withTenantContext(tenant_id, (client) => client.query(
    'SELECT tenant_id FROM agentos.tenants WHERE tenant_id = $1', [tenant_id],
  ));
  if (existing.rows.length > 0) return;

  const digest = tenant_id.replaceAll('-', '').padEnd(64, '0');
  await db.withPlatformRole(async (client) => {
    await client.query("SELECT set_config('app.current_tenant_id', $1, true)", [tenant_id]);
    await client.query(
      'SELECT agentos.provision_tenant_shell_for_id($1::uuid,$2::char(64),$3::char(64),$4::varchar(128)) AS tenant_id',
      [tenant_id, digest, digest, `Integration ${label} tenant`],
    );
  });
}
