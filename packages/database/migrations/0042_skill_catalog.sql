-- Skill catalog (platform, code-synced), per-tenant skill bindings, and skill test outcomes.
--
-- The contract half of a skill is immutable code: `packages/skills` is the single source of truth
-- and `agentos.skill_catalog` is a boot-synced projection of it. The binding half is data: a
-- company may only narrow what the code allows (enable, config, connector, assignment).
--
-- `agentos.skills` (0000) is DEPRECATED by this migration: it was never read at runtime and its
-- per-tenant, per-row contract duplication is exactly the drift this catalog removes.

-- 1. Platform-scoped catalog -------------------------------------------------------------------

CREATE TABLE agentos.skill_catalog (
  skill_id TEXT PRIMARY KEY CHECK (skill_id ~ '^skill\.[a-z_]+\.[a-z_]+$'),
  display_key TEXT NOT NULL CHECK (display_key <> '' AND display_key = pg_catalog.btrim(display_key)),
  domain TEXT NOT NULL CHECK (domain IN ('sales', 'care', 'marketing', 'knowledge', 'platform')),
  effect_class TEXT NOT NULL CHECK (effect_class IN ('READ', 'EFFECT', 'APPROVAL', 'INTERNAL')),
  required_authority TEXT NOT NULL CHECK (required_authority IN ('AUTH-0', 'AUTH-1', 'AUTH-2', 'AUTH-3', 'AUTH-4')),
  autonomy_class TEXT NOT NULL CHECK (autonomy_class IN ('NEVER', 'PROMOTABLE')),
  completion TEXT NOT NULL CHECK (completion IN ('SYNC', 'AWAITS_HUMAN')),
  receipt_ref TEXT NOT NULL CHECK (receipt_ref <> ''),
  tool_binding TEXT NOT NULL CHECK (tool_binding <> ''),
  allowed_agents TEXT[] NOT NULL CHECK (pg_catalog.cardinality(allowed_agents) > 0),
  connector_kinds TEXT[] NOT NULL DEFAULT '{}',
  config_schema JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_catalog.jsonb_typeof(config_schema) = 'object'),
  retired BOOLEAN NOT NULL DEFAULT false,
  contract_version BIGINT NOT NULL CHECK (contract_version > 0),
  contract_digest CHAR(64) NOT NULL CHECK (contract_digest ~ '^[0-9a-f]{64}$'),
  registered_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE agentos.skill_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.skill_catalog FORCE ROW LEVEL SECURITY;
CREATE POLICY skill_catalog_platform_access ON agentos.skill_catalog
  FOR ALL TO agentos_platform USING (true) WITH CHECK (true);
CREATE POLICY skill_catalog_app_read ON agentos.skill_catalog
  FOR SELECT TO agentos_app USING (true);

-- A contract change without a version bump is refused at the storage layer too, so a careless
-- writer cannot silently repin a digest that running agents have already dispatched against.
CREATE FUNCTION agentos.skill_catalog_contract_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, agentos, pg_temp
AS $$
BEGIN
  IF NEW.skill_id IS DISTINCT FROM OLD.skill_id THEN
    RAISE EXCEPTION 'skill catalog skill_id is immutable' USING ERRCODE = '23514';
  END IF;
  IF OLD.contract_digest IS DISTINCT FROM NEW.contract_digest
    AND NEW.contract_version <= OLD.contract_version THEN
    RAISE EXCEPTION 'skill % contract digest changed without a version bump', OLD.skill_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION agentos.skill_catalog_contract_guard() FROM PUBLIC;
CREATE TRIGGER skill_catalog_contract_guard
  BEFORE UPDATE ON agentos.skill_catalog
  FOR EACH ROW EXECUTE FUNCTION agentos.skill_catalog_contract_guard();

-- 2. Per-tenant binding: settings ---------------------------------------------------------------

CREATE TABLE agentos.tenant_skill_settings (
  tenant_id UUID NOT NULL REFERENCES agentos.tenants (tenant_id) ON DELETE RESTRICT,
  skill_id TEXT NOT NULL REFERENCES agentos.skill_catalog (skill_id) ON DELETE RESTRICT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  config JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_catalog.jsonb_typeof(config) = 'object'),
  connector_id TEXT,
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by TEXT NOT NULL CHECK (updated_by <> ''),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, skill_id)
);
SELECT agentos.apply_tenant_rls('agentos.tenant_skill_settings');

-- Configuration may only use keys the contract declares; a required key must be present once the
-- skill is enabled. This is the storage half of `config` validation (the API validates against the
-- JSON Schema itself); it never widens the declared surface.
CREATE FUNCTION agentos.tenant_skill_settings_config_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_schema JSONB;
  v_properties JSONB;
  v_required JSONB;
  v_key TEXT;
  v_unknown TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'tenant skill settings writes must advance the version' USING ERRCODE = '23514';
  END IF;
  SELECT config_schema INTO v_schema FROM agentos.skill_catalog WHERE skill_id = NEW.skill_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'skill % is not in the catalog', NEW.skill_id USING ERRCODE = '23503';
  END IF;
  v_properties := COALESCE(v_schema -> 'properties', '{}'::jsonb);
  v_required := COALESCE(v_schema -> 'required', '[]'::jsonb);
  FOR v_key IN SELECT pg_catalog.jsonb_object_keys(NEW.config) LOOP
    IF NOT (v_properties ? v_key) THEN
      RAISE EXCEPTION 'skill % config key % is not declared by the contract', NEW.skill_id, v_key
        USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF NEW.enabled THEN
    FOR v_key IN SELECT pg_catalog.jsonb_array_elements_text(v_required) LOOP
      IF NOT (NEW.config ? v_key) THEN
        RAISE EXCEPTION 'skill % requires config key % when enabled', NEW.skill_id, v_key
          USING ERRCODE = '23514';
      END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION agentos.tenant_skill_settings_config_guard() FROM PUBLIC;
CREATE TRIGGER tenant_skill_settings_config_guard
  BEFORE INSERT OR UPDATE ON agentos.tenant_skill_settings
  FOR EACH ROW EXECUTE FUNCTION agentos.tenant_skill_settings_config_guard();

-- 3. Per-tenant binding: agent assignment -------------------------------------------------------

CREATE TABLE agentos.tenant_skill_agents (
  tenant_id UUID NOT NULL,
  skill_id TEXT NOT NULL,
  agent_code TEXT NOT NULL CHECK (agent_code ~ '^(MKT|SAL|CS)-[0-9]{2}$'),
  assigned_by TEXT NOT NULL CHECK (assigned_by <> ''),
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, skill_id, agent_code),
  FOREIGN KEY (tenant_id, skill_id)
    REFERENCES agentos.tenant_skill_settings (tenant_id, skill_id) ON DELETE CASCADE
);
SELECT agentos.apply_tenant_rls('agentos.tenant_skill_agents');

-- Assignment can only narrow the contract ceiling: the database refuses an agent that the code
-- manifest does not allow for this skill (§10.2 "agent assignment ⊆ allowed agents").
CREATE FUNCTION agentos.tenant_skill_agents_ceiling_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_allowed TEXT[];
BEGIN
  SELECT allowed_agents INTO v_allowed FROM agentos.skill_catalog WHERE skill_id = NEW.skill_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'skill % is not in the catalog', NEW.skill_id USING ERRCODE = '23503';
  END IF;
  IF NOT (NEW.agent_code = ANY (v_allowed)) THEN
    RAISE EXCEPTION 'agent % is not allowed to run skill %', NEW.agent_code, NEW.skill_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;
REVOKE ALL ON FUNCTION agentos.tenant_skill_agents_ceiling_guard() FROM PUBLIC;
CREATE TRIGGER tenant_skill_agents_ceiling_guard
  BEFORE INSERT OR UPDATE ON agentos.tenant_skill_agents
  FOR EACH ROW EXECUTE FUNCTION agentos.tenant_skill_agents_ceiling_guard();

-- 4. Skill test outcomes (T4.4 writes these; retention is tenant-scoped) -------------------------

CREATE TABLE agentos.skill_test_results (
  test_id UUID NOT NULL DEFAULT agentos.uuid_generate_v7(),
  tenant_id UUID NOT NULL REFERENCES agentos.tenants (tenant_id) ON DELETE RESTRICT,
  skill_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('READ_DISPATCH', 'CONNECTOR_DRY_RUN')),
  outcome TEXT NOT NULL CHECK (outcome IN ('PASS', 'FAIL', 'REFUSED')),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_catalog.jsonb_typeof(detail) = 'object'),
  tested_by TEXT NOT NULL CHECK (tested_by <> ''),
  tested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, test_id),
  FOREIGN KEY (tenant_id, skill_id)
    REFERENCES agentos.tenant_skill_settings (tenant_id, skill_id) ON DELETE CASCADE
);
SELECT agentos.apply_tenant_rls('agentos.skill_test_results');

CREATE INDEX tenant_skill_agents_by_agent_idx
  ON agentos.tenant_skill_agents (tenant_id, agent_code, skill_id);
CREATE INDEX skill_test_results_recent_idx
  ON agentos.skill_test_results (tenant_id, skill_id, tested_at DESC, test_id DESC);

-- 5. Grants --------------------------------------------------------------------------------------

REVOKE ALL ON TABLE agentos.skill_catalog, agentos.tenant_skill_settings,
  agentos.tenant_skill_agents, agentos.skill_test_results FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform') THEN
    GRANT SELECT, INSERT, UPDATE ON agentos.skill_catalog, agentos.tenant_skill_settings,
      agentos.tenant_skill_agents, agentos.skill_test_results TO agentos_platform;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app') THEN
    GRANT SELECT ON agentos.skill_catalog TO agentos_app;
    GRANT SELECT, INSERT, UPDATE ON agentos.tenant_skill_settings,
      agentos.tenant_skill_agents, agentos.skill_test_results TO agentos_app;
    REVOKE DELETE, TRUNCATE ON agentos.tenant_skill_settings,
      agentos.tenant_skill_agents, agentos.skill_test_results FROM agentos_app;
  END IF;
END
$$;

COMMENT ON TABLE agentos.skills IS
  'DEPRECATED by migration 0042_skill_catalog.sql (T4.2): never read at runtime; contract state lives in agentos.skill_catalog and per-tenant binding in agentos.tenant_skill_settings/tenant_skill_agents. Retained read-only for the roadmap until a later migration drops it.';
