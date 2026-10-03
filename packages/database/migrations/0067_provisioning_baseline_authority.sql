-- Canonical skill_catalog is boot-synced from packages/skills, not an operator-authored grant map.
-- Grant only the minimum clearance covering the agent's non-external READ/INTERNAL skills.
-- AUTH-4 is never assignable, and approval/effect rows cannot increase this baseline.
CREATE OR REPLACE FUNCTION agentos.baseline_authority_for_agent(p_agent TEXT)
RETURNS TEXT
LANGUAGE SQL
STABLE
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT 'AUTH-' || COALESCE(MAX(RIGHT(contract.required_authority, 1)::integer), 0)::text
  FROM agentos.skill_catalog AS contract
  WHERE NOT contract.retired
    AND p_agent = ANY(contract.allowed_agents)
    AND contract.effect_class IN ('READ', 'INTERNAL')
    AND contract.required_authority IN ('AUTH-0', 'AUTH-1', 'AUTH-2', 'AUTH-3')
$$;
REVOKE ALL ON FUNCTION agentos.baseline_authority_for_agent(TEXT) FROM PUBLIC, agentos_app, agentos_platform;

-- New agent inserts alone receive the baseline; replay never changes an existing assignment,
-- activation state, or approval/autonomy policy. Keep the 0065 event-idempotency fix intact.
CREATE OR REPLACE FUNCTION agentos.provision_tenant_shell_impl(
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
      agentos.baseline_authority_for_agent(v_agent_code), FALSE)
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
  SELECT v_tenant_id, p_idempotency_key, 'TENANT_PROVISIONED',
    pg_catalog.jsonb_build_object('tenant_id', v_tenant_id, 'data_class', p_data_class)
  WHERE NOT EXISTS (
    SELECT 1 FROM agentos.provisioning_events AS event
     WHERE event.tenant_id = v_tenant_id
       AND event.idempotency_key = p_idempotency_key
       AND event.event_type = 'TENANT_PROVISIONED'
  )
  ON CONFLICT DO NOTHING;
  RETURN v_tenant_id;
END
$$;
