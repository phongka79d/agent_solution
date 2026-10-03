-- Configuration audit is a platform-owned, globally hash-chained append-only ledger.
-- Tenant readers use the GUC-filtered view; no application role can read or mutate the base table.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_roles
     WHERE rolname = current_user
       AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'platform_audit_migration_owner_must_bypass_rls'
      USING ERRCODE = '42501';
  END IF;
END
$$;

CREATE SEQUENCE agentos.platform_audit_events_chain_seq_seq AS BIGINT;

CREATE TABLE agentos.platform_audit_events (
  event_id UUID PRIMARY KEY,
  chain_seq BIGINT NOT NULL DEFAULT nextval('agentos.platform_audit_events_chain_seq_seq'::regclass),
  prev_hash CHAR(64) NOT NULL,
  hash CHAR(64) NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  action TEXT NOT NULL,
  target_tenant UUID,
  target TEXT,
  outcome TEXT NOT NULL,
  reason TEXT,
  before_state JSONB,
  after_state JSONB,
  correlation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT uq_platform_audit_events_chain_seq UNIQUE (chain_seq),
  CONSTRAINT uq_platform_audit_events_hash UNIQUE (hash),
  CONSTRAINT ck_platform_audit_events_chain_seq CHECK (chain_seq > 0),
  CONSTRAINT ck_platform_audit_events_prev_hash CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT ck_platform_audit_events_hash CHECK (hash ~ '^[0-9a-f]{64}$')
);

ALTER SEQUENCE agentos.platform_audit_events_chain_seq_seq
  OWNED BY agentos.platform_audit_events.chain_seq;

-- The definer writer bypasses RLS; platform reads require an explicit platform-only policy.
ALTER TABLE agentos.platform_audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.platform_audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_audit_platform_read ON agentos.platform_audit_events
  AS PERMISSIVE FOR SELECT TO agentos_platform USING (TRUE);

CREATE OR REPLACE FUNCTION agentos.prevent_platform_audit_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, agentos, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION 'platform_audit_events_are_append_only'
    USING ERRCODE = '55000';
END
$$;

CREATE TRIGGER trg_immutable_platform_audit_events
  BEFORE UPDATE OR DELETE ON agentos.platform_audit_events
  FOR EACH ROW EXECUTE FUNCTION agentos.prevent_platform_audit_event_mutation();
CREATE TRIGGER trg_immutable_platform_audit_events_truncate
  BEFORE TRUNCATE ON agentos.platform_audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION agentos.prevent_platform_audit_event_mutation();

CREATE VIEW agentos.tenant_audit_events AS
SELECT event_id, chain_seq, prev_hash, hash, actor_kind, actor_id, scope, action,
       target_tenant AS tenant_id, target, outcome, reason,
       before_state, after_state, correlation_id, created_at
  FROM agentos.platform_audit_events
 WHERE target_tenant = ANY (
   string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]
 );

CREATE OR REPLACE FUNCTION agentos.platform_append_audit(
  p_actor_kind TEXT,
  p_actor_id TEXT,
  p_scope TEXT,
  p_action TEXT,
  p_target_tenant UUID,
  p_target TEXT,
  p_outcome TEXT,
  p_reason TEXT,
  p_before JSONB,
  p_after JSONB,
  p_correlation_id TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_event_id UUID;
  v_chain_seq BIGINT;
  v_prev_hash TEXT;
  v_hash TEXT;
  v_created_at TIMESTAMPTZ;
  v_payload JSONB;
BEGIN
  IF p_actor_kind IS NULL OR p_actor_id IS NULL OR p_scope IS NULL OR p_action IS NULL
     OR p_outcome IS NULL OR p_correlation_id IS NULL THEN
    RAISE EXCEPTION 'platform audit required fields must not be null'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    WITH RECURSIVE nodes(value) AS (
      SELECT roots.value
        FROM (VALUES (p_before), (p_after)) AS roots(value)
       WHERE roots.value IS NOT NULL
      UNION ALL
      SELECT child.value
        FROM nodes AS parent
        CROSS JOIN LATERAL (
          SELECT entry.value
            FROM jsonb_each(CASE WHEN jsonb_typeof(parent.value) = 'object' THEN parent.value ELSE '{}'::jsonb END) AS entry
          UNION ALL
          SELECT entry.value
            FROM jsonb_array_elements(CASE WHEN jsonb_typeof(parent.value) = 'array' THEN parent.value ELSE '[]'::jsonb END) AS entry
        ) AS child
    )
    SELECT 1
      FROM nodes
      CROSS JOIN LATERAL jsonb_object_keys(
        CASE WHEN jsonb_typeof(nodes.value) = 'object' THEN nodes.value ELSE '{}'::jsonb END
      ) AS keys(key)
     WHERE keys.key ~* '(secret|password|api_key|token|private_key|plaintext)'
  ) THEN
    RAISE EXCEPTION 'platform audit before/after contains a sensitive key; redact it before appending'
      USING ERRCODE = '22023';
  END IF;

  -- Serialize the tail lookup and insert so concurrent writers cannot fork the global chain.
  PERFORM pg_advisory_xact_lock(202610010029::BIGINT);
  SELECT events.hash
    INTO v_prev_hash
    FROM agentos.platform_audit_events AS events
   ORDER BY events.chain_seq DESC
   LIMIT 1;
  v_prev_hash := COALESCE(v_prev_hash, repeat('0', 64));

  v_event_id := gen_random_uuid();
  v_chain_seq := nextval('agentos.platform_audit_events_chain_seq_seq'::regclass);
  v_created_at := clock_timestamp();
  -- Hash a stable UTC timestamp representation alongside the exact stored values.
  v_payload := jsonb_build_array(
    v_chain_seq, v_event_id, p_actor_kind, p_actor_id, p_scope, p_action,
    p_target_tenant, p_target, p_outcome, p_reason, p_before, p_after,
    p_correlation_id,
    to_char(v_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
  v_hash := encode(sha256(convert_to(v_prev_hash || '|' || v_payload::TEXT, 'UTF8')), 'hex');

  INSERT INTO agentos.platform_audit_events (
    event_id, chain_seq, prev_hash, hash, actor_kind, actor_id, scope, action,
    target_tenant, target, outcome, reason, before_state, after_state, correlation_id, created_at
  ) VALUES (
    v_event_id, v_chain_seq, v_prev_hash, v_hash, p_actor_kind, p_actor_id, p_scope, p_action,
    p_target_tenant, p_target, p_outcome, p_reason, p_before, p_after, p_correlation_id, v_created_at
  );

  RETURN v_event_id;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_proc AS routine
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
     WHERE namespace.nspname = 'agentos'
       AND routine.proname = 'platform_append_audit'
       AND pg_catalog.pg_get_userbyid(routine.proowner) = current_user
  ) THEN
    RAISE EXCEPTION 'platform_audit_writer_owner_mismatch'
      USING ERRCODE = '42501';
  END IF;
END
$$;

REVOKE ALL ON FUNCTION agentos.prevent_platform_audit_event_mutation() FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.platform_append_audit(TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON agentos.tenant_audit_events FROM PUBLIC, agentos_app, agentos_platform;
REVOKE ALL ON agentos.platform_audit_events FROM PUBLIC, agentos_app, agentos_platform;
REVOKE ALL ON SEQUENCE agentos.platform_audit_events_chain_seq_seq FROM PUBLIC, agentos_app, agentos_platform;
GRANT SELECT ON agentos.platform_audit_events TO agentos_platform;
GRANT SELECT ON agentos.tenant_audit_events TO agentos_app;
GRANT EXECUTE ON FUNCTION agentos.platform_append_audit(TEXT, TEXT, TEXT, TEXT, UUID, TEXT, TEXT, TEXT, JSONB, JSONB, TEXT)
  TO agentos_app, agentos_platform;
