-- Tenant configuration states and the tenant data-class boundary.

CREATE TYPE agentos.data_class AS ENUM ('PRODUCTION', 'DEMO', 'TEST');

ALTER TABLE agentos.tenants
  ADD COLUMN data_class agentos.data_class NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE agentos.tenants DROP CONSTRAINT IF EXISTS tenants_status_check;
ALTER TABLE agentos.tenants ADD CONSTRAINT tenants_status_check
  CHECK (status IN ('PROVISIONED', 'CONFIGURING', 'ACTIVE', 'SUSPENDED', 'ARCHIVED'));

ALTER TABLE agentos.tenant_workspaces DROP CONSTRAINT IF EXISTS tenant_workspaces_status_check;
ALTER TABLE agentos.tenant_workspaces ADD CONSTRAINT tenant_workspaces_status_check
  CHECK (status IN ('UNCONFIGURED', 'CONFIGURING', 'ACTIVE'));
ALTER TABLE agentos.tenant_capabilities DROP CONSTRAINT IF EXISTS tenant_capabilities_status_check;
ALTER TABLE agentos.tenant_capabilities ADD CONSTRAINT tenant_capabilities_status_check
  CHECK (status IN ('UNCONFIGURED', 'ENABLED', 'DISABLED'));

ALTER TABLE agentos.connector_configurations DROP CONSTRAINT IF EXISTS connector_configurations_status_check;
ALTER TABLE agentos.connector_configurations ADD CONSTRAINT connector_configurations_status_check
  CHECK (status IN ('UNBOUND', 'BOUND', 'DEGRADED', 'DISABLED'));
ALTER TABLE agentos.connector_configurations
  ADD COLUMN mode TEXT NOT NULL DEFAULT 'MOCK' CHECK (mode IN ('MOCK', 'LIVE')),
  ADD COLUMN config JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN secret_id UUID,
  ADD COLUMN bound_at TIMESTAMPTZ,
  ADD COLUMN probe_outcome TEXT,
  ADD COLUMN probe_latency_ms INTEGER CHECK (probe_latency_ms IS NULL OR probe_latency_ms >= 0),
  ADD COLUMN probe_http_status SMALLINT CHECK (probe_http_status IS NULL OR probe_http_status BETWEEN 100 AND 599),
  ADD COLUMN probe_error_class TEXT,
  ADD COLUMN probed_at TIMESTAMPTZ,
  ADD COLUMN version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0);

ALTER TABLE agentos.unresolved_owner_inputs DROP CONSTRAINT IF EXISTS unresolved_owner_inputs_status_check;
ALTER TABLE agentos.unresolved_owner_inputs ADD CONSTRAINT unresolved_owner_inputs_status_check
  CHECK (status IN ('UNRESOLVED', 'RESOLVED'));
ALTER TABLE agentos.unresolved_owner_inputs
  ADD COLUMN resolved_value JSONB,
  ADD COLUMN resolved_value_ref TEXT,
  ADD COLUMN resolved_by TEXT,
  ADD COLUMN resolved_at TIMESTAMPTZ,
  ADD CONSTRAINT unresolved_owner_inputs_resolution_check CHECK (
    (status = 'UNRESOLVED' AND resolved_value IS NULL AND resolved_value_ref IS NULL
      AND resolved_by IS NULL AND resolved_at IS NULL)
    OR
    (status = 'RESOLVED' AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL
      AND (resolved_value IS NOT NULL OR resolved_value_ref IS NOT NULL))
  );

-- The initial company profile row is created with each tenant; T2.3 adds the
-- validated editing workflow on top of this tenant-fenced source of truth.
CREATE TABLE agentos.tenant_profiles (
  tenant_id UUID PRIMARY KEY REFERENCES agentos.tenants (tenant_id) ON DELETE RESTRICT,
  company_name VARCHAR(128) NOT NULL,
  industry TEXT,
  locale TEXT NOT NULL DEFAULT 'vi-VN',
  timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
  currency CHAR(3) NOT NULL DEFAULT 'VND',
  brand_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO agentos.tenant_profiles (tenant_id, company_name)
SELECT tenant_id, display_name FROM agentos.tenants
ON CONFLICT (tenant_id) DO NOTHING;
INSERT INTO agentos.tenant_governance_settings (tenant_id)
SELECT tenant_id FROM agentos.tenants
ON CONFLICT (tenant_id) DO NOTHING;

CREATE FUNCTION agentos.prevent_tenant_data_class_change()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, agentos, pg_temp
AS $$
BEGIN
  IF NEW.data_class IS DISTINCT FROM OLD.data_class THEN
    RAISE EXCEPTION 'tenant data_class is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION agentos.prevent_tenant_data_class_change() FROM PUBLIC;
CREATE TRIGGER tenants_data_class_immutable
  BEFORE UPDATE OF data_class ON agentos.tenants
  FOR EACH ROW EXECUTE FUNCTION agentos.prevent_tenant_data_class_change();


CREATE OR REPLACE FUNCTION agentos.apply_tenant_rls(p_table regclass)
RETURNS void
LANGUAGE plpgsql
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_schema TEXT;
  v_table TEXT;
  v_relation TEXT;
BEGIN
  SELECT n.nspname, c.relname
    INTO v_schema, v_table
    FROM pg_catalog.pg_class AS c
    JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
   WHERE c.oid = p_table::oid
     AND c.relkind IN ('r', 'p');
  IF NOT FOUND OR v_schema <> 'agentos' THEN
    RAISE EXCEPTION 'tenant RLS requires an agentos table' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_attribute AS a
     WHERE a.attrelid = p_table::oid AND a.attname = 'tenant_id'
       AND a.attnum > 0 AND NOT a.attisdropped
  ) THEN
    RAISE EXCEPTION 'tenant RLS table must have tenant_id' USING ERRCODE = '22023';
  END IF;

  v_relation := pg_catalog.format('%I.%I', v_schema, v_table);
  EXECUTE pg_catalog.format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', v_relation);
  EXECUTE pg_catalog.format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', v_relation);
  EXECUTE pg_catalog.format('DROP POLICY IF EXISTS tenant_isolation_policy ON %s', v_relation);
  EXECUTE pg_catalog.format(
    'CREATE POLICY tenant_isolation_policy ON %s AS PERMISSIVE FOR ALL USING '
    || '(tenant_id = ANY (pg_catalog.string_to_array(pg_catalog.current_setting(''app.current_tenant_id'', true), '','')::pg_catalog.uuid[])) '
    || 'WITH CHECK (tenant_id = ANY (pg_catalog.string_to_array(pg_catalog.current_setting(''app.current_tenant_id'', true), '','')::pg_catalog.uuid[]))',
    v_relation
  );
END
$$;
REVOKE ALL ON FUNCTION agentos.apply_tenant_rls(regclass) FROM PUBLIC, agentos_app, agentos_platform;

SELECT agentos.apply_tenant_rls('agentos.tenants');
SELECT agentos.apply_tenant_rls('agentos.tenant_workspaces');
SELECT agentos.apply_tenant_rls('agentos.tenant_capabilities');
SELECT agentos.apply_tenant_rls('agentos.connector_configurations');
SELECT agentos.apply_tenant_rls('agentos.unresolved_owner_inputs');
SELECT agentos.apply_tenant_rls('agentos.tenant_governance_settings');
SELECT agentos.apply_tenant_rls('agentos.tenant_profiles');

GRANT SELECT, INSERT, UPDATE ON agentos.connector_configurations TO agentos_app;
REVOKE DELETE, TRUNCATE ON agentos.connector_configurations FROM agentos_app;
GRANT SELECT, INSERT ON agentos.unresolved_owner_inputs TO agentos_app;
GRANT UPDATE (status, resolved_value, resolved_value_ref, resolved_by, resolved_at)
  ON agentos.unresolved_owner_inputs TO agentos_app;
REVOKE DELETE, TRUNCATE ON agentos.unresolved_owner_inputs FROM agentos_app;
GRANT SELECT, INSERT, UPDATE ON agentos.tenant_profiles TO agentos_app;
REVOKE DELETE, TRUNCATE ON agentos.tenant_profiles FROM agentos_app;
GRANT SELECT ON agentos.tenant_governance_settings TO agentos_app;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON agentos.tenant_governance_settings FROM agentos_app;

-- One shared implementation keeps the fixed-id demo bootstrap and platform
-- provisioning paths in lockstep while the public overloads preserve old calls.
CREATE FUNCTION agentos.provision_tenant_shell_impl(
  p_tenant_id UUID,
  p_fixed_id BOOLEAN,
  p_idempotency_key CHAR(64),
  p_request_fingerprint CHAR(64),
  p_display_name VARCHAR(128),
  p_data_class agentos.data_class
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_tenant_id UUID;
  v_existing_fingerprint CHAR(64);
  v_existing_class agentos.data_class;
  v_existing_name VARCHAR(128);
  v_agent_code TEXT;
  v_capability_id TEXT;
  v_connector_id TEXT;
  v_owner_input TEXT;
  v_skill_id TEXT;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'idempotency_key must be a lowercase SHA-256 digest' USING ERRCODE = '22023';
  END IF;
  IF p_request_fingerprint IS NULL OR p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'request_fingerprint must be a lowercase SHA-256 digest' USING ERRCODE = '22023';
  END IF;
  IF p_display_name IS NULL OR pg_catalog.btrim(p_display_name) = '' THEN
    RAISE EXCEPTION 'display_name is required' USING ERRCODE = '22023';
  END IF;
  IF p_data_class IS NULL THEN
    RAISE EXCEPTION 'data_class is required' USING ERRCODE = '22023';
  END IF;
  IF p_fixed_id AND p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id is required' USING ERRCODE = '22023';
  END IF;
  IF p_fixed_id AND pg_catalog.current_setting('app.current_tenant_id', true) IS DISTINCT FROM p_tenant_id::TEXT THEN
    RAISE EXCEPTION 'tenant context must match the requested tenant' USING ERRCODE = '42501';
  END IF;

  IF p_fixed_id THEN
    SELECT t.tenant_id, t.request_fingerprint, t.data_class, t.display_name
      INTO v_tenant_id, v_existing_fingerprint, v_existing_class, v_existing_name
      FROM agentos.tenants AS t WHERE t.tenant_id = p_tenant_id FOR UPDATE;
    IF FOUND THEN
      IF v_existing_fingerprint <> p_request_fingerprint
         OR v_existing_name <> p_display_name OR v_existing_class <> p_data_class THEN
        RAISE EXCEPTION 'fixed tenant identity is already bound to another request'
          USING ERRCODE = '23505', CONSTRAINT = 'tenants_pkey';
      END IF;
      IF EXISTS (SELECT 1 FROM agentos.tenants AS t WHERE t.idempotency_key = p_idempotency_key AND t.tenant_id <> p_tenant_id) THEN
        RAISE EXCEPTION 'idempotency key is already bound to another tenant'
          USING ERRCODE = '23505', CONSTRAINT = 'tenants_idempotency_key_key';
      END IF;
    ELSE
      IF EXISTS (SELECT 1 FROM agentos.tenants AS t WHERE t.idempotency_key = p_idempotency_key) THEN
        RAISE EXCEPTION 'idempotency key is already bound to another tenant'
          USING ERRCODE = '23505', CONSTRAINT = 'tenants_idempotency_key_key';
      END IF;
      INSERT INTO agentos.tenants (tenant_id, status, display_name, idempotency_key, request_fingerprint, data_class)
      VALUES (p_tenant_id, 'PROVISIONED', p_display_name, p_idempotency_key, p_request_fingerprint, p_data_class)
      RETURNING tenant_id INTO v_tenant_id;
    END IF;
  ELSE
    SELECT t.tenant_id, t.request_fingerprint, t.data_class
      INTO v_tenant_id, v_existing_fingerprint, v_existing_class
      FROM agentos.tenants AS t WHERE t.idempotency_key = p_idempotency_key FOR UPDATE;
    IF FOUND THEN
      IF v_existing_fingerprint <> p_request_fingerprint OR v_existing_class <> p_data_class THEN
        RAISE EXCEPTION 'idempotency key is already bound to another request'
          USING ERRCODE = '23505', CONSTRAINT = 'tenants_idempotency_key_key';
      END IF;
    ELSE
      INSERT INTO agentos.tenants (status, display_name, idempotency_key, request_fingerprint, data_class)
      VALUES ('PROVISIONED', p_display_name, p_idempotency_key, p_request_fingerprint, p_data_class)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING tenant_id INTO v_tenant_id;
      IF v_tenant_id IS NULL THEN
        SELECT t.tenant_id, t.request_fingerprint, t.data_class
          INTO v_tenant_id, v_existing_fingerprint, v_existing_class
          FROM agentos.tenants AS t WHERE t.idempotency_key = p_idempotency_key FOR UPDATE;
        IF v_existing_fingerprint <> p_request_fingerprint OR v_existing_class <> p_data_class THEN
          RAISE EXCEPTION 'idempotency key is already bound to another request'
            USING ERRCODE = '23505', CONSTRAINT = 'tenants_idempotency_key_key';
        END IF;
      END IF;
    END IF;
  END IF;

  INSERT INTO agentos.tenant_workspaces (tenant_id, admin_binding_ref, status)
  VALUES (v_tenant_id, 'tenant:' || v_tenant_id::TEXT, 'UNCONFIGURED')
  ON CONFLICT (tenant_id) DO NOTHING;
  INSERT INTO agentos.tenant_profiles (tenant_id, company_name)
  VALUES (v_tenant_id, p_display_name)
  ON CONFLICT (tenant_id) DO NOTHING;
  INSERT INTO agentos.tenant_governance_settings (tenant_id)
  VALUES (v_tenant_id)
  ON CONFLICT (tenant_id) DO NOTHING;

  FOREACH v_agent_code IN ARRAY ARRAY[
    'MKT-01', 'MKT-02', 'MKT-03', 'MKT-04', 'MKT-05', 'MKT-06',
    'SAL-01', 'SAL-02', 'SAL-03', 'SAL-04', 'SAL-05', 'CS-01', 'CS-02'
  ] LOOP
    INSERT INTO agentos.agents (tenant_id, code, name, domain, assigned_authority, is_active)
    VALUES (v_tenant_id, v_agent_code, v_agent_code,
      CASE WHEN v_agent_code LIKE 'MKT-%' THEN 'marketing'
           WHEN v_agent_code LIKE 'SAL-%' THEN 'sales' ELSE 'support' END,
      'AUTH-0', FALSE)
    ON CONFLICT (tenant_id, code) DO NOTHING;
  END LOOP;

  FOREACH v_capability_id IN ARRAY ARRAY['care', 'sales', 'marketing'] LOOP
    INSERT INTO agentos.tenant_capabilities (tenant_id, capability_id, status)
    VALUES (v_tenant_id, v_capability_id, 'UNCONFIGURED')
    ON CONFLICT (tenant_id, capability_id) DO NOTHING;
  END LOOP;
  FOREACH v_connector_id IN ARRAY ARRAY['API-001', 'API-002', 'API-003', 'ADPT-GL-001', 'ADPT-GL-002', 'ADPT-GL-003', 'SHOPIFY'] LOOP
    INSERT INTO agentos.connector_configurations (tenant_id, connector_id, status)
    VALUES (v_tenant_id, v_connector_id, 'UNBOUND')
    ON CONFLICT (tenant_id, connector_id) DO NOTHING;
  END LOOP;
  FOREACH v_owner_input IN ARRAY ARRAY[
    'ASM-001', 'ASM-002', 'ASM-003', 'ASM-004', 'FLOOR_POLICY', 'REFUND_POLICY',
    'RETENTION_POLICY', 'KPI_BASELINE', 'PROVIDER_CREDENTIALS', 'RESIDENCY_REGION',
    'PROMOTION_LIMITS', 'careOnboardingItinerary'
  ] LOOP
    INSERT INTO agentos.unresolved_owner_inputs (tenant_id, input_id, status)
    VALUES (v_tenant_id, v_owner_input, 'UNRESOLVED')
    ON CONFLICT (tenant_id, input_id) DO NOTHING;
  END LOOP;

  INSERT INTO agentos.namespace_bindings (tenant_id, redis_prefix, vector_filter, storage_prefix)
  VALUES (v_tenant_id, 'tenant:' || v_tenant_id::TEXT,
    'tenant_id=' || v_tenant_id::TEXT, 'tenant/' || v_tenant_id::TEXT)
  ON CONFLICT (tenant_id) DO NOTHING;
  INSERT INTO agentos.residency_configurations (tenant_id, status)
  VALUES (v_tenant_id, 'UNRESOLVED')
  ON CONFLICT (tenant_id) DO NOTHING;
  INSERT INTO agentos.tenant_autonomy_controls (tenant_id, paused, kill_switch)
  VALUES (v_tenant_id, FALSE, FALSE)
  ON CONFLICT (tenant_id) DO NOTHING;

  FOREACH v_skill_id IN ARRAY ARRAY[
    'skill.sales.check_stock', 'skill.sales.search_product', 'skill.sales.retrieve_customer',
    'skill.care.search_faq', 'skill.mkt.segment_audience', 'skill.mkt.generate_content'
  ] LOOP
    INSERT INTO agentos.autonomy_policies (
      tenant_id, skill_id, policy_version, policy_id, state, previous_approved_state,
      reason, parameters, provenance, effective_at, rollback_policy_version, rollback_state
    ) VALUES (
      v_tenant_id, v_skill_id, 'MINIMUM', agentos.uuid_generate_v7(), 'MINIMUM', 'MINIMUM',
      'SAFE_MINIMUM', '{}'::jsonb, '{"source":"SERVER_POLICY","decision":"SAFE_MINIMUM"}'::jsonb,
      CURRENT_TIMESTAMP, 'MINIMUM', 'MINIMUM'
    ) ON CONFLICT (tenant_id, skill_id, policy_version) DO NOTHING;
  END LOOP;

  INSERT INTO agentos.provisioning_events (tenant_id, idempotency_key, event_type, payload)
  VALUES (v_tenant_id, p_idempotency_key, 'TENANT_PROVISIONED',
    pg_catalog.jsonb_build_object('tenant_id', v_tenant_id, 'data_class', p_data_class))
  ON CONFLICT DO NOTHING;
  RETURN v_tenant_id;
END
$$;

CREATE OR REPLACE FUNCTION agentos.provision_tenant_shell(
  p_idempotency_key CHAR(64), p_request_fingerprint CHAR(64), p_display_name VARCHAR(128)
)
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT agentos.provision_tenant_shell_impl(NULL, FALSE, p_idempotency_key,
    p_request_fingerprint, p_display_name, 'PRODUCTION'::agentos.data_class)
$$;

CREATE FUNCTION agentos.provision_tenant_shell(
  p_idempotency_key CHAR(64), p_request_fingerprint CHAR(64), p_display_name VARCHAR(128),
  p_data_class agentos.data_class
)
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT agentos.provision_tenant_shell_impl(NULL, FALSE, p_idempotency_key,
    p_request_fingerprint, p_display_name, p_data_class)
$$;

CREATE OR REPLACE FUNCTION agentos.provision_tenant_shell_for_id(
  p_tenant_id UUID, p_idempotency_key CHAR(64), p_request_fingerprint CHAR(64), p_display_name VARCHAR(128)
)
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT agentos.provision_tenant_shell_impl(p_tenant_id, TRUE, p_idempotency_key,
    p_request_fingerprint, p_display_name, 'PRODUCTION'::agentos.data_class)
$$;

CREATE FUNCTION agentos.provision_tenant_shell_for_id(
  p_tenant_id UUID, p_idempotency_key CHAR(64), p_request_fingerprint CHAR(64),
  p_display_name VARCHAR(128), p_data_class agentos.data_class
)
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT agentos.provision_tenant_shell_impl(p_tenant_id, TRUE, p_idempotency_key,
    p_request_fingerprint, p_display_name, p_data_class)
$$;

REVOKE ALL ON FUNCTION agentos.provision_tenant_shell_impl(UUID, BOOLEAN, CHAR(64), CHAR(64), VARCHAR(128), agentos.data_class) FROM PUBLIC, agentos_app, agentos_platform;
REVOKE ALL ON FUNCTION agentos.provision_tenant_shell(CHAR(64), CHAR(64), VARCHAR(128)) FROM PUBLIC, agentos_app, agentos_platform;
REVOKE ALL ON FUNCTION agentos.provision_tenant_shell(CHAR(64), CHAR(64), VARCHAR(128), agentos.data_class) FROM PUBLIC, agentos_app, agentos_platform;
REVOKE ALL ON FUNCTION agentos.provision_tenant_shell_for_id(UUID, CHAR(64), CHAR(64), VARCHAR(128)) FROM PUBLIC, agentos_app, agentos_platform;
REVOKE ALL ON FUNCTION agentos.provision_tenant_shell_for_id(UUID, CHAR(64), CHAR(64), VARCHAR(128), agentos.data_class) FROM PUBLIC, agentos_app, agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.provision_tenant_shell(CHAR(64), CHAR(64), VARCHAR(128)) TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.provision_tenant_shell(CHAR(64), CHAR(64), VARCHAR(128), agentos.data_class) TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.provision_tenant_shell_for_id(UUID, CHAR(64), CHAR(64), VARCHAR(128)) TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.provision_tenant_shell_for_id(UUID, CHAR(64), CHAR(64), VARCHAR(128), agentos.data_class) TO agentos_platform;

-- Platform directory functions expose only the tenant's public classification in addition to the
-- existing fixed projection. Drop the dependent getter before changing its row type.
DROP FUNCTION agentos.platform_get_tenant(UUID);
DROP FUNCTION agentos.platform_list_tenants();
CREATE FUNCTION agentos.platform_list_tenants()
RETURNS TABLE (
  tenant_id UUID, display_name VARCHAR(128), status TEXT, data_class agentos.data_class,
  created_at TIMESTAMPTZ, enabled_modules TEXT[]
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT t.tenant_id, t.display_name, t.status, t.data_class, t.created_at,
         ARRAY_AGG(c.capability_id::TEXT ORDER BY c.capability_id)
           FILTER (WHERE c.status <> 'UNCONFIGURED') AS enabled_modules
    FROM agentos.tenants AS t
    LEFT JOIN agentos.tenant_capabilities AS c ON c.tenant_id = t.tenant_id
   GROUP BY t.tenant_id, t.display_name, t.status, t.data_class, t.created_at
   ORDER BY t.created_at, t.tenant_id
$$;
CREATE FUNCTION agentos.platform_get_tenant(p_tenant_id UUID)
RETURNS TABLE (
  tenant_id UUID, display_name VARCHAR(128), status TEXT, data_class agentos.data_class,
  created_at TIMESTAMPTZ, enabled_modules TEXT[]
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT directory.* FROM agentos.platform_list_tenants() AS directory
   WHERE directory.tenant_id = p_tenant_id
$$;
REVOKE ALL ON FUNCTION agentos.platform_list_tenants() FROM PUBLIC, agentos_app, agentos_platform;
REVOKE ALL ON FUNCTION agentos.platform_get_tenant(UUID) FROM PUBLIC, agentos_app, agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_list_tenants() TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_get_tenant(UUID) TO agentos_platform;

DO $$
DECLARE
  v_owner OID := (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname = CURRENT_USER);
  v_unowned TEXT[];
BEGIN
  SELECT pg_catalog.array_agg(p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')')
    INTO v_unowned
    FROM pg_catalog.pg_proc AS p
    JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname = 'agentos'
     AND p.proname IN (
       'apply_tenant_rls', 'provision_tenant_shell_impl', 'provision_tenant_shell',
       'provision_tenant_shell_for_id', 'platform_list_tenants', 'platform_get_tenant'
     )
     AND p.proowner <> v_owner;
  IF v_unowned IS NOT NULL THEN
    RAISE EXCEPTION 'T2.1 functions must be owned by migration role: %', v_unowned;
  END IF;
END
$$;
