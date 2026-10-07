-- Tenant-scoped governance settings. Application traffic may read this table only;
-- changes are applied by seed or migration SQL under the migrator role.

CREATE TABLE agentos.tenant_governance_settings (
  tenant_id UUID PRIMARY KEY REFERENCES agentos.tenants (tenant_id) ON DELETE RESTRICT,
  require_distinct_approver BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE agentos.tenant_governance_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.tenant_governance_settings FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON agentos.tenant_governance_settings
  AS PERMISSIVE
  FOR ALL
  USING (
    tenant_id = ANY (
      string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]
    )
  )
  WITH CHECK (
    tenant_id = ANY (
      string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]
    )
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app') THEN
    GRANT SELECT ON agentos.tenant_governance_settings TO agentos_app;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON agentos.tenant_governance_settings FROM agentos_app;
  END IF;
END
$$;
