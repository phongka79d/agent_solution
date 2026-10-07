-- D5 / B39: every tenant starts with the Care onboarding itinerary unresolved.
-- The runtime only binds this input from an explicit owner value; this row is the
-- projection/attention marker and is never interpreted as a fabricated itinerary.

INSERT INTO agentos.unresolved_owner_inputs (tenant_id, input_id, status)
SELECT tenant_id, 'careOnboardingItinerary', 'UNRESOLVED'
  FROM agentos.tenants
ON CONFLICT (tenant_id, input_id) DO NOTHING;

-- Keep both provisioning entry points consistent for tenants created after this
-- migration. These are the existing signatures; CREATE OR REPLACE preserves the
-- control-plane grants, which are re-applied below for clarity.
CREATE OR REPLACE FUNCTION agentos.provision_tenant_shell(
  p_idempotency_key CHAR(64),
  p_request_fingerprint CHAR(64),
  p_display_name VARCHAR(128)
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_tenant_id UUID;
  v_existing_fingerprint CHAR(64);
  v_capability_id TEXT;
  v_agent_code TEXT;
  v_connector_id TEXT;
  v_skill_id TEXT;
  v_owner_input TEXT;
BEGIN
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'idempotency_key must be a lowercase SHA-256 digest' USING ERRCODE = '22023';
  END IF;
  IF p_request_fingerprint IS NULL OR p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'request_fingerprint must be a lowercase SHA-256 digest' USING ERRCODE = '22023';
  END IF;
  IF p_display_name IS NULL OR btrim(p_display_name) = '' THEN
    RAISE EXCEPTION 'display_name is required' USING ERRCODE = '22023';
  END IF;

  SELECT tenant_id, request_fingerprint
    INTO v_tenant_id, v_existing_fingerprint
    FROM agentos.tenants
   WHERE idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing_fingerprint <> p_request_fingerprint THEN
      RAISE EXCEPTION 'idempotency key is already bound to another request fingerprint'
        USING ERRCODE = '23505', CONSTRAINT = 'tenants_idempotency_key_key';
    END IF;
    RETURN v_tenant_id;
  END IF;

  INSERT INTO agentos.tenants (status, display_name, idempotency_key, request_fingerprint)
  VALUES ('PROVISIONED', p_display_name, p_idempotency_key, p_request_fingerprint)
  ON CONFLICT (idempotency_key) DO NOTHING
  RETURNING tenant_id INTO v_tenant_id;

  IF v_tenant_id IS NULL THEN
    SELECT tenant_id, request_fingerprint
      INTO v_tenant_id, v_existing_fingerprint
      FROM agentos.tenants
     WHERE idempotency_key = p_idempotency_key
     FOR UPDATE;
    IF v_existing_fingerprint <> p_request_fingerprint THEN
      RAISE EXCEPTION 'idempotency key is already bound to another request fingerprint'
        USING ERRCODE = '23505', CONSTRAINT = 'tenants_idempotency_key_key';
    END IF;
    RETURN v_tenant_id;
  END IF;

  INSERT INTO agentos.tenant_workspaces (tenant_id, admin_binding_ref, status)
  VALUES (v_tenant_id, 'tenant:' || v_tenant_id::TEXT, 'UNCONFIGURED');

  FOREACH v_agent_code IN ARRAY ARRAY[
    'MKT-01', 'MKT-02', 'MKT-03', 'MKT-04', 'MKT-05', 'MKT-06',
    'SAL-01', 'SAL-02', 'SAL-03', 'SAL-04', 'SAL-05',
    'CS-01', 'CS-02'
  ] LOOP
    INSERT INTO agentos.agents (tenant_id, code, name, domain, assigned_authority, is_active)
    VALUES (
      v_tenant_id,
      v_agent_code,
      v_agent_code,
      CASE
        WHEN v_agent_code LIKE 'MKT-%' THEN 'marketing'
        WHEN v_agent_code LIKE 'SAL-%' THEN 'sales'
        ELSE 'support'
      END,
      'AUTH-0',
      FALSE
    );
  END LOOP;

  FOREACH v_capability_id IN ARRAY ARRAY['care', 'sales', 'marketing'] LOOP
    INSERT INTO agentos.tenant_capabilities (tenant_id, capability_id, status)
    VALUES (v_tenant_id, v_capability_id, 'UNCONFIGURED');
  END LOOP;

  FOREACH v_connector_id IN ARRAY ARRAY['API-001', 'API-002', 'API-003', 'ADPT-GL-001', 'ADPT-GL-002', 'ADPT-GL-003', 'SHOPIFY'] LOOP
    INSERT INTO agentos.connector_configurations (tenant_id, connector_id, status)
    VALUES (v_tenant_id, v_connector_id, 'UNBOUND');
  END LOOP;

  FOREACH v_owner_input IN ARRAY ARRAY[
    'ASM-001', 'ASM-002', 'ASM-003', 'ASM-004', 'FLOOR_POLICY', 'REFUND_POLICY',
    'RETENTION_POLICY', 'KPI_BASELINE', 'PROVIDER_CREDENTIALS', 'RESIDENCY_REGION', 'PROMOTION_LIMITS',
    'careOnboardingItinerary'
  ] LOOP
    INSERT INTO agentos.unresolved_owner_inputs (tenant_id, input_id, status)
    VALUES (v_tenant_id, v_owner_input, 'UNRESOLVED');
  END LOOP;

  INSERT INTO agentos.namespace_bindings (tenant_id, redis_prefix, vector_filter, storage_prefix)
  VALUES (
    v_tenant_id,
    'tenant:' || v_tenant_id::TEXT,
    'tenant_id=' || v_tenant_id::TEXT,
    'tenant/' || v_tenant_id::TEXT
  );

  INSERT INTO agentos.residency_configurations (tenant_id, status)
  VALUES (v_tenant_id, 'UNRESOLVED');

  INSERT INTO agentos.tenant_autonomy_controls (tenant_id, paused, kill_switch)
  VALUES (v_tenant_id, FALSE, FALSE);

  FOREACH v_skill_id IN ARRAY ARRAY[
    'skill.sales.check_stock', 'skill.sales.search_product', 'skill.sales.retrieve_customer',
    'skill.care.search_faq', 'skill.mkt.segment_audience', 'skill.mkt.generate_content'
  ] LOOP
    INSERT INTO agentos.autonomy_policies (
      tenant_id, skill_id, policy_version, policy_id, state, previous_approved_state,
      reason, parameters, provenance, effective_at, rollback_policy_version, rollback_state
    ) VALUES (
      v_tenant_id, v_skill_id, 'MINIMUM', agentos.uuid_generate_v7(), 'MINIMUM', 'MINIMUM',
      'SAFE_MINIMUM', '{}'::jsonb,
      '{"source":"SERVER_POLICY","decision":"SAFE_MINIMUM"}'::jsonb,
      CURRENT_TIMESTAMP, 'MINIMUM', 'MINIMUM'
    );
  END LOOP;

  INSERT INTO agentos.provisioning_events (tenant_id, idempotency_key, event_type, payload)
  VALUES (
    v_tenant_id, p_idempotency_key, 'TENANT_PROVISIONED',
    jsonb_build_object('tenant_id', v_tenant_id)
  );

  RETURN v_tenant_id;
END;
$$;

CREATE OR REPLACE FUNCTION agentos.provision_tenant_shell_for_id(
  p_tenant_id UUID,
  p_idempotency_key CHAR(64),
  p_request_fingerprint CHAR(64),
  p_display_name VARCHAR(128)
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
DECLARE
  v_existing_tenant_id UUID;
  v_existing_status TEXT;
  v_existing_display_name VARCHAR(128);
  v_existing_idempotency_key CHAR(64);
  v_existing_fingerprint CHAR(64);
  v_agent_code TEXT;
  v_capability_id TEXT;
  v_connector_id TEXT;
  v_owner_input TEXT;
  v_skill_id TEXT;
  v_event_id UUID;
  v_event_tenant_id UUID;
  v_event_idempotency_key CHAR(64);
  v_event_type TEXT;
BEGIN
  IF p_tenant_id IS NULL THEN
    RAISE EXCEPTION 'tenant_id is required' USING ERRCODE = '22023';
  END IF;
  IF current_setting('app.current_tenant_id', true) IS DISTINCT FROM p_tenant_id::TEXT THEN
    RAISE EXCEPTION 'tenant context must match the requested tenant' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL OR p_idempotency_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'idempotency_key must be a lowercase SHA-256 digest' USING ERRCODE = '22023';
  END IF;
  IF p_request_fingerprint IS NULL OR p_request_fingerprint !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'request_fingerprint must be a lowercase SHA-256 digest' USING ERRCODE = '22023';
  END IF;
  IF p_display_name IS NULL OR btrim(p_display_name) = '' THEN
    RAISE EXCEPTION 'display_name is required' USING ERRCODE = '22023';
  END IF;

  SELECT tenant_id, status, display_name, idempotency_key, request_fingerprint
    INTO v_existing_tenant_id, v_existing_status, v_existing_display_name,
         v_existing_idempotency_key, v_existing_fingerprint
    FROM agentos.tenants
   WHERE tenant_id = p_tenant_id
   FOR UPDATE;

  IF FOUND THEN
    IF v_existing_status <> 'PROVISIONED'
       OR v_existing_display_name <> p_display_name
       OR v_existing_idempotency_key <> p_idempotency_key
       OR v_existing_fingerprint <> p_request_fingerprint THEN
      RAISE EXCEPTION 'existing tenant has mismatched identity or provisioning keys'
        USING ERRCODE = '23505', CONSTRAINT = 'tenants_pkey';
    END IF;
  ELSE
    SELECT tenant_id, request_fingerprint
      INTO v_existing_tenant_id, v_existing_fingerprint
      FROM agentos.tenants
     WHERE idempotency_key = p_idempotency_key
     FOR UPDATE;

    IF FOUND THEN
      RAISE EXCEPTION 'idempotency key is already bound to another tenant row'
        USING ERRCODE = '23505', CONSTRAINT = 'tenants_idempotency_key_key';
    END IF;

    INSERT INTO agentos.tenants (tenant_id, status, display_name, idempotency_key, request_fingerprint)
    VALUES (p_tenant_id, 'PROVISIONED', p_display_name, p_idempotency_key, p_request_fingerprint)
    ON CONFLICT DO NOTHING;

    SELECT tenant_id, status, display_name, idempotency_key, request_fingerprint
      INTO v_existing_tenant_id, v_existing_status, v_existing_display_name,
           v_existing_idempotency_key, v_existing_fingerprint
      FROM agentos.tenants
     WHERE tenant_id = p_tenant_id
     FOR UPDATE;

    IF NOT FOUND
       OR v_existing_status <> 'PROVISIONED'
       OR v_existing_display_name <> p_display_name
       OR v_existing_idempotency_key <> p_idempotency_key
       OR v_existing_fingerprint <> p_request_fingerprint THEN
      RAISE EXCEPTION 'existing tenant has mismatched identity or provisioning keys'
        USING ERRCODE = '23505', CONSTRAINT = 'tenants_pkey';
    END IF;
  END IF;

  INSERT INTO agentos.tenant_workspaces (tenant_id, admin_binding_ref, status)
  VALUES (p_tenant_id, 'tenant:' || p_tenant_id::TEXT, 'UNCONFIGURED')
  ON CONFLICT (tenant_id) DO NOTHING;

  FOREACH v_agent_code IN ARRAY ARRAY[
    'MKT-01', 'MKT-02', 'MKT-03', 'MKT-04', 'MKT-05', 'MKT-06',
    'SAL-01', 'SAL-02', 'SAL-03', 'SAL-04', 'SAL-05',
    'CS-01', 'CS-02'
  ] LOOP
    INSERT INTO agentos.agents (tenant_id, code, name, domain, assigned_authority, is_active)
    VALUES (
      p_tenant_id,
      v_agent_code,
      v_agent_code,
      CASE
        WHEN v_agent_code LIKE 'MKT-%' THEN 'marketing'
        WHEN v_agent_code LIKE 'SAL-%' THEN 'sales'
        ELSE 'support'
      END,
      'AUTH-0',
      FALSE
    )
    ON CONFLICT (tenant_id, code) DO NOTHING;
  END LOOP;

  FOREACH v_capability_id IN ARRAY ARRAY['care', 'sales', 'marketing'] LOOP
    INSERT INTO agentos.tenant_capabilities (tenant_id, capability_id, status)
    VALUES (p_tenant_id, v_capability_id, 'UNCONFIGURED')
    ON CONFLICT (tenant_id, capability_id) DO NOTHING;
  END LOOP;

  FOREACH v_connector_id IN ARRAY ARRAY['API-001', 'API-002', 'API-003', 'ADPT-GL-001', 'ADPT-GL-002', 'ADPT-GL-003', 'SHOPIFY'] LOOP
    INSERT INTO agentos.connector_configurations (tenant_id, connector_id, status)
    VALUES (p_tenant_id, v_connector_id, 'UNBOUND')
    ON CONFLICT (tenant_id, connector_id) DO NOTHING;
  END LOOP;

  FOREACH v_owner_input IN ARRAY ARRAY[
    'ASM-001', 'ASM-002', 'ASM-003', 'ASM-004', 'FLOOR_POLICY', 'REFUND_POLICY',
    'RETENTION_POLICY', 'KPI_BASELINE', 'PROVIDER_CREDENTIALS', 'RESIDENCY_REGION', 'PROMOTION_LIMITS',
    'careOnboardingItinerary'
  ] LOOP
    INSERT INTO agentos.unresolved_owner_inputs (tenant_id, input_id, status)
    VALUES (p_tenant_id, v_owner_input, 'UNRESOLVED')
    ON CONFLICT (tenant_id, input_id) DO NOTHING;
  END LOOP;

  INSERT INTO agentos.namespace_bindings (tenant_id, redis_prefix, vector_filter, storage_prefix)
  VALUES (
    p_tenant_id,
    'tenant:' || p_tenant_id::TEXT,
    'tenant_id=' || p_tenant_id::TEXT,
    'tenant/' || p_tenant_id::TEXT
  )
  ON CONFLICT (tenant_id) DO NOTHING;

  INSERT INTO agentos.residency_configurations (tenant_id, status)
  VALUES (p_tenant_id, 'UNRESOLVED')
  ON CONFLICT (tenant_id) DO NOTHING;

  INSERT INTO agentos.tenant_autonomy_controls (tenant_id, paused, kill_switch)
  VALUES (p_tenant_id, FALSE, FALSE)
  ON CONFLICT (tenant_id) DO NOTHING;

  FOREACH v_skill_id IN ARRAY ARRAY[
    'skill.sales.check_stock', 'skill.sales.search_product', 'skill.sales.retrieve_customer',
    'skill.care.search_faq', 'skill.mkt.segment_audience', 'skill.mkt.generate_content'
  ] LOOP
    INSERT INTO agentos.autonomy_policies (
      tenant_id, skill_id, policy_version, policy_id, state, previous_approved_state,
      reason, parameters, provenance, effective_at, rollback_policy_version, rollback_state
    ) VALUES (
      p_tenant_id, v_skill_id, 'MINIMUM', agentos.uuid_generate_v7(), 'MINIMUM', 'MINIMUM',
      'SAFE_MINIMUM', '{}'::jsonb,
      '{"source":"SERVER_POLICY","decision":"SAFE_MINIMUM"}'::jsonb,
      CURRENT_TIMESTAMP, 'MINIMUM', 'MINIMUM'
    )
    ON CONFLICT (tenant_id, skill_id, policy_version) DO NOTHING;
  END LOOP;

  SELECT event_id, tenant_id, idempotency_key, event_type
    INTO v_event_id, v_event_tenant_id, v_event_idempotency_key, v_event_type
    FROM agentos.provisioning_events
   WHERE tenant_id = p_tenant_id
     AND idempotency_key = p_idempotency_key
   FOR UPDATE;

  IF NOT FOUND THEN
    v_event_id := public.uuid_generate_v5(
      public.uuid_ns_url(),
      'agentos:tenant-provisioning:' || p_tenant_id::TEXT || ':' || p_idempotency_key
    );
    INSERT INTO agentos.provisioning_events (event_id, tenant_id, idempotency_key, event_type, payload)
    VALUES (
      v_event_id,
      p_tenant_id,
      p_idempotency_key,
      'TENANT_PROVISIONED',
      jsonb_build_object('tenant_id', p_tenant_id)
    )
    ON CONFLICT (event_id) DO NOTHING;

    SELECT event_id, tenant_id, idempotency_key, event_type
      INTO v_event_id, v_event_tenant_id, v_event_idempotency_key, v_event_type
      FROM agentos.provisioning_events
     WHERE event_id = v_event_id
     FOR UPDATE;
  END IF;

  IF NOT FOUND
     OR v_event_tenant_id <> p_tenant_id
     OR v_event_idempotency_key <> p_idempotency_key
     OR v_event_type <> 'TENANT_PROVISIONED' THEN
    RAISE EXCEPTION 'existing provisioning event has mismatched identity'
      USING ERRCODE = '23505', CONSTRAINT = 'provisioning_events_pkey';
  END IF;

  RETURN p_tenant_id;
END;
$$;

REVOKE ALL ON FUNCTION agentos.provision_tenant_shell(CHAR(64), CHAR(64), VARCHAR(128)) FROM PUBLIC, agentos_app;
GRANT EXECUTE ON FUNCTION agentos.provision_tenant_shell(CHAR(64), CHAR(64), VARCHAR(128)) TO agentos_platform;
REVOKE ALL ON FUNCTION agentos.provision_tenant_shell_for_id(UUID, CHAR(64), CHAR(64), VARCHAR(128)) FROM PUBLIC, agentos_app;
GRANT EXECUTE ON FUNCTION agentos.provision_tenant_shell_for_id(UUID, CHAR(64), CHAR(64), VARCHAR(128)) TO agentos_platform;
