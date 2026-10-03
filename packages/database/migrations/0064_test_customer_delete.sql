-- Single-customer Test Lab deletion uses the same reset-only execution boundary as reset_test_data.
-- Serving-role ledger DELETE privileges remain revoked; only this tenant/TEST-fenced function can
-- remove a customer's care/cross-domain handoffs and TEST runs before deleting its seed rows.
-- Like 0050, deleting the owning task cascades run_responses through the existing
-- pg_trigger_depth() exemption; direct response DELETE/UPDATE remains forbidden.
CREATE OR REPLACE FUNCTION agentos.delete_test_customer(p_tenant UUID, p_customer UUID)
RETURNS SETOF agentos.customers
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_customer agentos.customers%ROWTYPE;
  v_run_ids TEXT[];
  v_current_tenant TEXT := pg_catalog.current_setting('app.current_tenant_id', TRUE);
BEGIN
  IF p_tenant IS NULL OR p_customer IS NULL THEN
    RAISE EXCEPTION 'TEST_CUSTOMER_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF v_current_tenant IS NULL OR NOT (p_tenant = ANY(pg_catalog.string_to_array(v_current_tenant, ',')::uuid[])) THEN
    RAISE EXCEPTION 'delete_test_customer tenant context mismatch' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_customer FROM agentos.customers
  WHERE tenant_id = p_tenant AND id = p_customer FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TEST_CUSTOMER_NOT_FOUND' USING ERRCODE = '22023';
  END IF;
  IF v_customer.data_class <> 'TEST' THEN
    RAISE EXCEPTION 'TEST_CUSTOMER_NOT_TEST_DATA' USING ERRCODE = '22023';
  END IF;

  -- Reuse the customer/conversation payload paths used by inherit_data_class. A response's
  -- conversation also identifies older runs whose checkpoint no longer has those fields.
  -- An explicit different customer always wins over a conversation-derived association.
  SELECT pg_catalog.array_agg(owned.run_id) INTO v_run_ids
  FROM (
    SELECT task.run_id FROM agentos.platform_durable_tasks AS task
    WHERE task.tenant_id = p_tenant AND task.data_class = 'TEST'
      AND (
        pg_catalog.lower(COALESCE(task.state_payload->>'customer_id', task.state_payload->'signal'->'payload'->>'customer_id')) = p_customer::text
        OR (
          COALESCE(task.state_payload->>'customer_id', task.state_payload->'signal'->'payload'->>'customer_id') IS NULL
          AND EXISTS (
            SELECT 1 FROM agentos.conversations AS conversation
            WHERE conversation.tenant_id = p_tenant AND conversation.customer_id = p_customer
              AND conversation.data_class = 'TEST'
              AND (
                pg_catalog.lower(COALESCE(task.state_payload->>'conversation_id', task.state_payload->'signal'->'payload'->>'conversation_id')) = conversation.id::text
                OR EXISTS (
                  SELECT 1 FROM agentos.run_responses AS response
                  WHERE response.tenant_id = p_tenant AND response.run_id = task.run_id
                    AND response.conversation_id = conversation.id
                )
              )
          )
        )
      )
    FOR UPDATE OF task
  ) AS owned;

  DELETE FROM agentos.care_handoffs
  WHERE tenant_id = p_tenant AND customer_id = p_customer AND data_class = 'TEST';
  -- cross_domain_handoffs predates data_class; its locked customer is the classification fence.
  DELETE FROM agentos.cross_domain_handoffs
  WHERE tenant_id = p_tenant AND customer_id = p_customer;
  DELETE FROM agentos.approvals
  WHERE tenant_id = p_tenant AND run_id = ANY(v_run_ids) AND data_class = 'TEST';
  DELETE FROM agentos.effect_reservations
  WHERE tenant_id = p_tenant AND run_id = ANY(v_run_ids) AND data_class = 'TEST';
  -- Delete tasks before conversations/messages: SET NULL would UPDATE immutable responses.
  DELETE FROM agentos.platform_durable_tasks
  WHERE tenant_id = p_tenant AND run_id = ANY(v_run_ids) AND data_class = 'TEST';
  DELETE FROM agentos.conversations
  WHERE tenant_id = p_tenant AND customer_id = p_customer AND data_class = 'TEST';
  DELETE FROM agentos.service_cases
  WHERE tenant_id = p_tenant AND customer_id = p_customer AND data_class = 'TEST';
  DELETE FROM agentos.orders
  WHERE tenant_id = p_tenant AND customer_id = p_customer AND data_class = 'TEST';
  DELETE FROM agentos.customer_events
  WHERE tenant_id = p_tenant AND customer_id = p_customer AND data_class = 'TEST';
  DELETE FROM agentos.consents
  WHERE tenant_id = p_tenant AND customer_id = p_customer AND data_class = 'TEST';
  DELETE FROM agentos.customer_identities
  WHERE tenant_id = p_tenant AND customer_id = p_customer AND data_class = 'TEST';
  DELETE FROM agentos.customers
  WHERE tenant_id = p_tenant AND id = p_customer AND data_class = 'TEST';

  RETURN NEXT v_customer;
END
$$;
REVOKE ALL ON FUNCTION agentos.delete_test_customer(UUID, UUID) FROM PUBLIC, agentos_app;
GRANT EXECUTE ON FUNCTION agentos.delete_test_customer(UUID, UUID) TO agentos_test_reset;
