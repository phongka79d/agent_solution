-- Remove durable tasks before messages/conversations so run_responses are deleted by their
-- append-only parent cascade instead of being updated by FK ON DELETE SET NULL.
CREATE OR REPLACE FUNCTION agentos.reset_test_data(p_tenant UUID, p_actor TEXT, p_dry_run BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_counts JSONB;
  v_actor TEXT := pg_catalog.btrim(p_actor);
  v_current_tenant TEXT := pg_catalog.current_setting('app.current_tenant_id', TRUE);
BEGIN
  IF p_tenant IS NULL OR v_actor IS NULL OR v_actor = '' OR pg_catalog.length(v_actor) > 256 OR p_dry_run IS NULL THEN
    RAISE EXCEPTION 'reset_test_data arguments invalid' USING ERRCODE = '22023';
  END IF;
  IF v_current_tenant IS NULL OR NOT (p_tenant = ANY(pg_catalog.string_to_array(v_current_tenant, ',')::uuid[])) THEN
    RAISE EXCEPTION 'reset_test_data tenant context mismatch' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM agentos.tenants AS tenant WHERE tenant.tenant_id = p_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'reset_test_data tenant not found' USING ERRCODE = '22023'; END IF;

  SELECT pg_catalog.jsonb_build_object(
    'care_handoffs', (SELECT count(*) FROM agentos.care_handoffs WHERE tenant_id = p_tenant AND data_class = 'TEST'),
    'conversation_messages', (SELECT count(*) FROM agentos.conversation_messages WHERE tenant_id = p_tenant AND data_class = 'TEST'),
    'service_cases', (SELECT count(*) FROM agentos.service_cases WHERE tenant_id = p_tenant AND data_class = 'TEST'),
    'customer_events', (SELECT count(*) FROM agentos.customer_events WHERE tenant_id = p_tenant AND data_class = 'TEST'),
    'customer_identities', (SELECT count(*) FROM agentos.customer_identities WHERE tenant_id = p_tenant AND data_class = 'TEST'),
    'consents', (SELECT count(*) FROM agentos.consents WHERE tenant_id = p_tenant AND data_class = 'TEST'),
    'orders', (SELECT count(*) FROM agentos.orders WHERE tenant_id = p_tenant AND data_class = 'TEST'),
    'conversations', (SELECT count(*) FROM agentos.conversations WHERE tenant_id = p_tenant AND data_class = 'TEST'),
    'approvals', (SELECT count(*) FROM agentos.approvals WHERE tenant_id = p_tenant AND data_class = 'TEST'),
    'effect_reservations', (SELECT count(*) FROM agentos.effect_reservations WHERE tenant_id = p_tenant AND data_class = 'TEST'),
    'platform_durable_tasks', (SELECT count(*) FROM agentos.platform_durable_tasks WHERE tenant_id = p_tenant AND data_class = 'TEST'),
    'campaigns', (SELECT count(*) FROM agentos.campaigns WHERE tenant_id = p_tenant AND data_class = 'TEST'),
    'customers', (SELECT count(*) FROM agentos.customers WHERE tenant_id = p_tenant AND data_class = 'TEST')
  ) INTO v_counts;

  IF NOT p_dry_run THEN
    DELETE FROM agentos.care_handoffs WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.approvals WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.effect_reservations WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.platform_durable_tasks WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.conversation_messages WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.service_cases WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.customer_events WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.customer_identities WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.consents WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.orders WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.conversations WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.campaigns WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.customers WHERE tenant_id = p_tenant AND data_class = 'TEST';
  END IF;

  PERFORM agentos.platform_append_audit(
    'OPERATOR', v_actor, 'TEST_DATA', CASE WHEN p_dry_run THEN 'RESET_DRY_RUN' ELSE 'RESET' END,
    p_tenant, 'test-data', 'SUCCESS', NULL, v_counts,
    pg_catalog.jsonb_build_object('dry_run', p_dry_run, 'counts', v_counts), pg_catalog.gen_random_uuid()::text
  );
  RETURN pg_catalog.jsonb_build_object('tenant_id', p_tenant, 'dry_run', p_dry_run, 'counts', v_counts);
END
$$;
REVOKE ALL ON FUNCTION agentos.reset_test_data(UUID, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agentos.reset_test_data(UUID, TEXT, BOOLEAN) TO agentos_test_reset;
