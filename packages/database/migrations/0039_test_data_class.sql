-- Server-owned data classification for the TEST customer lifecycle.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_test_reset') THEN
    CREATE ROLE agentos_test_reset NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- Classify the customer-facing tree, run lifecycle and campaigns. Root rows default
-- to production; historical DEMO rows are backfilled from their tenant/parent.
ALTER TABLE agentos.customers ADD COLUMN data_class agentos.data_class NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE agentos.customer_identities ADD COLUMN data_class agentos.data_class NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE agentos.consents ADD COLUMN data_class agentos.data_class NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE agentos.orders ADD COLUMN data_class agentos.data_class NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE agentos.customer_events ADD COLUMN data_class agentos.data_class NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE agentos.conversations ADD COLUMN data_class agentos.data_class NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE agentos.conversation_messages ADD COLUMN data_class agentos.data_class NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE agentos.service_cases ADD COLUMN data_class agentos.data_class NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE agentos.care_handoffs ADD COLUMN data_class agentos.data_class NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE agentos.campaigns ADD COLUMN data_class agentos.data_class NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE agentos.platform_durable_tasks ADD COLUMN data_class agentos.data_class NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE agentos.effect_reservations ADD COLUMN data_class agentos.data_class NOT NULL DEFAULT 'PRODUCTION';
ALTER TABLE agentos.approvals ADD COLUMN data_class agentos.data_class NOT NULL DEFAULT 'PRODUCTION';

UPDATE agentos.customers AS row SET data_class = tenant.data_class
  FROM agentos.tenants AS tenant WHERE tenant.tenant_id = row.tenant_id;
UPDATE agentos.customer_identities AS row SET data_class = parent.data_class
  FROM agentos.customers AS parent WHERE parent.tenant_id = row.tenant_id AND parent.id = row.customer_id;
UPDATE agentos.consents AS row SET data_class = parent.data_class
  FROM agentos.customers AS parent WHERE parent.tenant_id = row.tenant_id AND parent.id = row.customer_id;
UPDATE agentos.orders AS row SET data_class = parent.data_class
  FROM agentos.customers AS parent WHERE parent.tenant_id = row.tenant_id AND parent.id = row.customer_id;
UPDATE agentos.customer_events AS row SET data_class = COALESCE(
  (SELECT parent.data_class FROM agentos.customers AS parent WHERE parent.tenant_id = row.tenant_id AND parent.id = row.customer_id),
  (SELECT tenant.data_class FROM agentos.tenants AS tenant WHERE tenant.tenant_id = row.tenant_id)
);
UPDATE agentos.conversations AS row SET data_class = COALESCE(
  (SELECT parent.data_class FROM agentos.customers AS parent WHERE parent.tenant_id = row.tenant_id AND parent.id = row.customer_id),
  (SELECT tenant.data_class FROM agentos.tenants AS tenant WHERE tenant.tenant_id = row.tenant_id)
);
UPDATE agentos.conversation_messages AS row SET data_class = COALESCE(
  (SELECT parent.data_class FROM agentos.conversations AS parent WHERE parent.tenant_id = row.tenant_id AND parent.id = row.conversation_id),
  (SELECT tenant.data_class FROM agentos.tenants AS tenant WHERE tenant.tenant_id = row.tenant_id)
);
UPDATE agentos.platform_durable_tasks AS row SET data_class = COALESCE(
  (SELECT customer.data_class FROM agentos.customers AS customer
    WHERE customer.tenant_id = row.tenant_id
      AND customer.id = CASE
        WHEN COALESCE(row.state_payload->>'customer_id', row.state_payload->'signal'->'payload'->>'customer_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN COALESCE(row.state_payload->>'customer_id', row.state_payload->'signal'->'payload'->>'customer_id')::uuid END),
  (SELECT conversation.data_class FROM agentos.conversations AS conversation
    WHERE conversation.tenant_id = row.tenant_id
      AND conversation.id = CASE
        WHEN COALESCE(row.state_payload->>'conversation_id', row.state_payload->'signal'->'payload'->>'conversation_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN COALESCE(row.state_payload->>'conversation_id', row.state_payload->'signal'->'payload'->>'conversation_id')::uuid END),
  (SELECT tenant.data_class FROM agentos.tenants AS tenant WHERE tenant.tenant_id = row.tenant_id)
);
UPDATE agentos.service_cases AS row SET data_class = COALESCE(
  (SELECT customer.data_class FROM agentos.customers AS customer WHERE customer.tenant_id = row.tenant_id AND customer.id = row.customer_id),
  (SELECT conversation.data_class FROM agentos.conversations AS conversation WHERE conversation.tenant_id = row.tenant_id AND conversation.id = row.conversation_id),
  (SELECT tenant.data_class FROM agentos.tenants AS tenant WHERE tenant.tenant_id = row.tenant_id)
);
UPDATE agentos.care_handoffs AS row SET data_class = COALESCE(
  (SELECT customer.data_class FROM agentos.customers AS customer WHERE customer.tenant_id = row.tenant_id AND customer.id = row.customer_id),
  (SELECT conversation.data_class FROM agentos.conversations AS conversation WHERE conversation.tenant_id = row.tenant_id AND conversation.id = row.conversation_id),
  (SELECT task.data_class FROM agentos.platform_durable_tasks AS task WHERE task.tenant_id = row.tenant_id AND task.run_id = row.run_id),
  (SELECT tenant.data_class FROM agentos.tenants AS tenant WHERE tenant.tenant_id = row.tenant_id)
);
UPDATE agentos.campaigns AS row SET data_class = (SELECT tenant.data_class FROM agentos.tenants AS tenant WHERE tenant.tenant_id = row.tenant_id);
UPDATE agentos.effect_reservations AS row SET data_class = COALESCE(
  (SELECT task.data_class FROM agentos.platform_durable_tasks AS task WHERE task.tenant_id = row.tenant_id AND task.run_id = row.run_id),
  (SELECT tenant.data_class FROM agentos.tenants AS tenant WHERE tenant.tenant_id = row.tenant_id)
);
UPDATE agentos.approvals AS row SET data_class = COALESCE(
  (SELECT task.data_class FROM agentos.platform_durable_tasks AS task WHERE task.tenant_id = row.tenant_id AND task.run_id = row.run_id),
  (SELECT tenant.data_class FROM agentos.tenants AS tenant WHERE tenant.tenant_id = row.tenant_id)
);

CREATE OR REPLACE FUNCTION agentos.inherit_data_class()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_class agentos.data_class;
  v_customer UUID;
  v_conversation UUID;
  v_run TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.data_class IS DISTINCT FROM OLD.data_class THEN
      RAISE EXCEPTION 'data_class is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_TABLE_NAME IN ('customers', 'campaigns') AND NEW.data_class = 'TEST' THEN
    v_class := 'TEST';
  END IF;

  IF TG_TABLE_NAME = 'platform_durable_tasks' THEN
    IF COALESCE(NEW.state_payload->>'customer_id', NEW.state_payload->'signal'->'payload'->>'customer_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_customer := COALESCE(NEW.state_payload->>'customer_id', NEW.state_payload->'signal'->'payload'->>'customer_id')::uuid;
    END IF;
    IF COALESCE(NEW.state_payload->>'conversation_id', NEW.state_payload->'signal'->'payload'->>'conversation_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      v_conversation := COALESCE(NEW.state_payload->>'conversation_id', NEW.state_payload->'signal'->'payload'->>'conversation_id')::uuid;
    END IF;
  ELSE
    IF pg_catalog.to_jsonb(NEW) ? 'customer_id' THEN v_customer := NULLIF(pg_catalog.to_jsonb(NEW)->>'customer_id', '')::uuid; END IF;
    IF pg_catalog.to_jsonb(NEW) ? 'conversation_id' THEN v_conversation := NULLIF(pg_catalog.to_jsonb(NEW)->>'conversation_id', '')::uuid; END IF;
    IF pg_catalog.to_jsonb(NEW) ? 'run_id' THEN v_run := pg_catalog.to_jsonb(NEW)->>'run_id'; END IF;
  END IF;

  IF v_customer IS NOT NULL THEN
    SELECT customer.data_class INTO v_class FROM agentos.customers AS customer
     WHERE customer.tenant_id = NEW.tenant_id AND customer.id = v_customer;
  END IF;
  IF v_class IS NULL AND v_conversation IS NOT NULL THEN
    SELECT conversation.data_class INTO v_class FROM agentos.conversations AS conversation
     WHERE conversation.tenant_id = NEW.tenant_id AND conversation.id = v_conversation;
  END IF;
  IF v_class IS NULL AND v_run IS NOT NULL AND TG_TABLE_NAME <> 'platform_durable_tasks' THEN
    SELECT task.data_class INTO v_class FROM agentos.platform_durable_tasks AS task
     WHERE task.tenant_id = NEW.tenant_id AND task.run_id = v_run;
  END IF;
  IF v_class IS NULL THEN
    SELECT tenant.data_class INTO v_class FROM agentos.tenants AS tenant WHERE tenant.tenant_id = NEW.tenant_id;
  END IF;
  IF v_class IS NULL THEN
    RAISE EXCEPTION 'data_class tenant or parent not found' USING ERRCODE = '23503';
  END IF;
  NEW.data_class := v_class;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION agentos.inherit_data_class() FROM PUBLIC;

DO $$
DECLARE
  v_table TEXT;
BEGIN
  FOREACH v_table IN ARRAY ARRAY[
    'customers', 'customer_identities', 'consents', 'orders', 'customer_events',
    'conversations', 'conversation_messages', 'service_cases', 'care_handoffs',
    'campaigns', 'platform_durable_tasks', 'effect_reservations', 'approvals'
  ] LOOP
    EXECUTE pg_catalog.format('CREATE TRIGGER inherit_data_class BEFORE INSERT OR UPDATE OF data_class ON agentos.%I FOR EACH ROW EXECUTE FUNCTION agentos.inherit_data_class()', v_table);
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA agentos TO agentos_test_reset;
GRANT SELECT ON agentos.tenants, agentos.customer_identities, agentos.consents, agentos.orders,
  agentos.customer_events, agentos.conversation_messages, agentos.service_cases,
  agentos.care_handoffs, agentos.conversations, agentos.customers, agentos.campaigns,
  agentos.approvals, agentos.effect_reservations, agentos.platform_durable_tasks
  TO agentos_test_reset;
GRANT DELETE ON agentos.customer_identities, agentos.consents, agentos.orders,
  agentos.customer_events, agentos.conversation_messages, agentos.service_cases,
  agentos.care_handoffs, agentos.conversations, agentos.customers, agentos.campaigns,
  agentos.approvals, agentos.effect_reservations, agentos.platform_durable_tasks
  TO agentos_test_reset;
GRANT EXECUTE ON FUNCTION agentos.platform_append_audit(TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT)
  TO agentos_test_reset;
GRANT agentos_test_reset TO agentos_app WITH INHERIT FALSE;

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
    DELETE FROM agentos.conversation_messages WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.service_cases WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.customer_events WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.customer_identities WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.consents WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.orders WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.conversations WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.approvals WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.effect_reservations WHERE tenant_id = p_tenant AND data_class = 'TEST';
    DELETE FROM agentos.platform_durable_tasks WHERE tenant_id = p_tenant AND data_class = 'TEST';
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

