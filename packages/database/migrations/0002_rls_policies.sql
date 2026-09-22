-- ============================================================================
-- ROW-LEVEL SECURITY, ROLES, AND GRANTS (NFR-006 - zero data bleeding)
-- Schema: agentos
-- Requires: 0000_agentos_schema.sql and 0001_tenant_scoped_fks.sql, already applied.
-- ============================================================================
--
-- 0000 creates the schema and the tables, 0001 makes every intra-tenant reference
-- tenant-scoped. This file makes the schema unusable without a tenant context:
--
--   1. `agentos.current_tenant_id()` mirrors implement/01 section 1 (and docker/postgres/init.sql)
--      so a session can read back its bound tenant. 0000 ships no such helper.
--   2. The RLS block below is the spec block verbatim: ENABLE + FORCE + a PERMISSIVE
--      `tenant_isolation_policy` on every table of the `agentos` schema, with the tenant list
--      parsed as `string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]`.
--      An unset or empty setting yields NULL/{} - default deny, never allow. FORCE is what
--      makes the policy bind the table owner too; `agentos_migrator` holds BYPASSRLS, which is
--      why DDL and the rehearsal ledger stay possible while application roles cannot escape.
--   3. Roles are created only if missing, always NOLOGIN, and NEVER with a password: credentials
--      are provisioned out of band by the deployment bootstrap. `agentos_app` is asserted
--      NOBYPASSRLS on every run, so no other actor can widen it and still pass this migration.
--   4. `agentos_app` receives exactly what serving tenant traffic needs: schema USAGE, DML on
--      the tables, sequence USAGE, and EXECUTE on the functions. It is NOT granted
--      `agentos_migrator` (DDL and BYPASSRLS stay out of the request path), and it gets no
--      access to `agentos_meta` (the migration ledger is operator state, not tenant data).
--
-- The two views (`customer_360_profiles`, `approval_queue`) are not tables: they carry no
-- policy of their own and are declared `WITH (security_invoker = true)` in 0000, so they
-- evaluate the base tables' policies against the calling role.


-- ----------------------------------------------------------------------------
-- TENANT CONTEXT HELPER
-- ----------------------------------------------------------------------------
-- Helper function to retrieve active tenant from session variable
CREATE OR REPLACE FUNCTION agentos.current_tenant_id()
RETURNS UUID AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_tenant_id', true), '')::UUID;
END;
$$ LANGUAGE plpgsql STABLE;

-- ============================================================================
-- ROW-LEVEL SECURITY CONFIGURATION (NFR-006)
-- ============================================================================

-- Function to apply RLS policies automatically to all tables in schema
DO $$
DECLARE
    tbl text;
BEGIN
    FOR tbl IN
        SELECT tablename
        FROM pg_tables
        WHERE schemaname = 'agentos'
    LOOP
        -- Enable and force RLS on table
        EXECUTE format('ALTER TABLE agentos.%I ENABLE ROW LEVEL SECURITY;', tbl);
        EXECUTE format('ALTER TABLE agentos.%I FORCE ROW LEVEL SECURITY;', tbl);

        -- Drop existing policy if present
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation_policy ON agentos.%I;', tbl);

        -- Create strictly scoped tenant policy for SELECT, INSERT, UPDATE, DELETE (PERMISSIVE model).
        -- `string_to_array(...)::uuid[]` keeps the comparison uuid = uuid (never uuid = text),
        -- and an unset/empty setting resolves to NULL/{} = default deny.
        EXECUTE format('
            CREATE POLICY tenant_isolation_policy ON agentos.%I
            AS PERMISSIVE
            FOR ALL
            USING (tenant_id = ANY (string_to_array(current_setting(''app.current_tenant_id'', true), '','')::uuid[]))
            WITH CHECK (tenant_id = ANY (string_to_array(current_setting(''app.current_tenant_id'', true), '','')::uuid[]));
        ', tbl);
    END LOOP;
END $$;

-- ----------------------------------------------------------------------------
-- ROLES
-- ----------------------------------------------------------------------------
-- Create-if-missing, then assert the security attribute unconditionally. CREATE ROLE takes no
-- password here on purpose: the migration owns privileges, the deployment owns credentials.
DO $$
DECLARE
    role_present boolean;
BEGIN
    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app')
      INTO role_present;
    IF NOT role_present THEN
        CREATE ROLE agentos_app NOLOGIN NOBYPASSRLS;
    END IF;

    SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_migrator')
      INTO role_present;
    IF NOT role_present THEN
        CREATE ROLE agentos_migrator NOLOGIN BYPASSRLS;
    END IF;
END $$;

-- Every run re-asserts the invariant, so a role widened elsewhere cannot survive a migration.
ALTER ROLE agentos_app NOBYPASSRLS;
ALTER ROLE agentos_migrator BYPASSRLS;

-- ----------------------------------------------------------------------------
-- GRANTS FOR THE APPLICATION ROLE
-- ----------------------------------------------------------------------------
-- Privileges are broad on purpose - authorization is RLS, which no grant here can bypass.
GRANT USAGE ON SCHEMA agentos TO agentos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA agentos TO agentos_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA agentos TO agentos_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA agentos TO agentos_app;
