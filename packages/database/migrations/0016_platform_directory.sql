-- Platform control-plane directory projections.
-- The platform role is deliberately NOLOGIN/NOBYPASSRLS: application traffic must
-- opt into it with SET LOCAL ROLE inside a transaction before calling these
-- SECURITY DEFINER projections. No customer-facing columns are returned here.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform'
  ) THEN
    CREATE ROLE agentos_platform NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE agentos_platform NOLOGIN NOBYPASSRLS;

-- Membership is non-inheriting so the ordinary application role cannot reach the
-- platform projection privileges without an explicit, transaction-local SET ROLE.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app') THEN
    EXECUTE 'GRANT agentos_platform TO agentos_app WITH INHERIT FALSE';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION agentos.platform_list_tenants()
RETURNS TABLE (
  tenant_id UUID,
  display_name VARCHAR(128),
  status TEXT,
  created_at TIMESTAMPTZ,
  enabled_modules TEXT[]
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
  SELECT
    t.tenant_id,
    t.display_name,
    t.status,
    t.created_at,
    ARRAY_AGG(c.capability_id::TEXT ORDER BY c.capability_id)
      FILTER (WHERE c.status <> 'UNCONFIGURED') AS enabled_modules
  FROM agentos.tenants AS t
  LEFT JOIN agentos.tenant_capabilities AS c ON c.tenant_id = t.tenant_id
  GROUP BY t.tenant_id, t.display_name, t.status, t.created_at
  ORDER BY t.created_at, t.tenant_id
$$;

CREATE OR REPLACE FUNCTION agentos.platform_get_tenant(p_tenant_id UUID)
RETURNS TABLE (
  tenant_id UUID,
  display_name VARCHAR(128),
  status TEXT,
  created_at TIMESTAMPTZ,
  enabled_modules TEXT[]
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
  SELECT directory.*
  FROM agentos.platform_list_tenants() AS directory
  WHERE directory.tenant_id = p_tenant_id
$$;

CREATE OR REPLACE FUNCTION agentos.platform_tenant_readiness(p_tenant_id UUID)
RETURNS TABLE (
  tenant_id UUID,
  capability_count BIGINT,
  capability_statuses JSONB,
  connector_count BIGINT,
  connector_statuses JSONB,
  owner_input_count BIGINT,
  owner_input_statuses JSONB,
  workspace_status TEXT,
  residency_status TEXT
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
  WITH capability_summary AS (
    SELECT
      tenant_id,
      COUNT(*)::BIGINT AS capability_count,
      JSONB_OBJECT_AGG(capability_id, status ORDER BY capability_id) AS capability_statuses
    FROM agentos.tenant_capabilities
    WHERE tenant_id = p_tenant_id
    GROUP BY tenant_id
  ), connector_summary AS (
    SELECT
      tenant_id,
      COUNT(*)::BIGINT AS connector_count,
      JSONB_OBJECT_AGG(connector_id, status ORDER BY connector_id) AS connector_statuses
    FROM agentos.connector_configurations
    WHERE tenant_id = p_tenant_id
    GROUP BY tenant_id
  ), owner_input_summary AS (
    SELECT
      tenant_id,
      COUNT(*)::BIGINT AS owner_input_count,
      JSONB_OBJECT_AGG(input_id, status ORDER BY input_id) AS owner_input_statuses
    FROM agentos.unresolved_owner_inputs
    WHERE tenant_id = p_tenant_id
    GROUP BY tenant_id
  )
  SELECT
    t.tenant_id,
    c.capability_count,
    c.capability_statuses,
    cc.connector_count,
    cc.connector_statuses,
    oi.owner_input_count,
    oi.owner_input_statuses,
    w.status AS workspace_status,
    r.status AS residency_status
  FROM agentos.tenants AS t
  LEFT JOIN capability_summary AS c ON c.tenant_id = t.tenant_id
  LEFT JOIN connector_summary AS cc ON cc.tenant_id = t.tenant_id
  LEFT JOIN owner_input_summary AS oi ON oi.tenant_id = t.tenant_id
  LEFT JOIN agentos.tenant_workspaces AS w ON w.tenant_id = t.tenant_id
  LEFT JOIN agentos.residency_configurations AS r ON r.tenant_id = t.tenant_id
  WHERE t.tenant_id = p_tenant_id
$$;

CREATE OR REPLACE FUNCTION agentos.platform_usage(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
)
RETURNS TABLE (
  tenant_id UUID,
  runs_count BIGINT,
  token_cost_records_count BIGINT,
  estimated_cost_total NUMERIC,
  input_tokens_total BIGINT,
  output_tokens_total BIGINT,
  cached_tokens_total BIGINT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = agentos, pg_temp
AS $$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from >= p_to THEN
    RAISE EXCEPTION 'usage window must be a non-empty interval'
      USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH run_summary AS (
    SELECT
      d.tenant_id,
      COUNT(*)::BIGINT AS runs_count
    FROM agentos.platform_durable_tasks AS d
    WHERE d.created_at >= p_from AND d.created_at < p_to
    GROUP BY d.tenant_id
  ), cost_summary AS (
    SELECT
      c.tenant_id,
      COUNT(*)::BIGINT AS token_cost_records_count,
      SUM(c.estimated_cost_amount) AS estimated_cost_total,
      SUM(c.input_tokens)::BIGINT AS input_tokens_total,
      SUM(c.output_tokens)::BIGINT AS output_tokens_total,
      SUM(c.cached_tokens)::BIGINT AS cached_tokens_total
    FROM agentos.token_cost_records AS c
    WHERE c.recorded_at >= p_from AND c.recorded_at < p_to
    GROUP BY c.tenant_id
  )
  SELECT
    COALESCE(r.tenant_id, c.tenant_id),
    r.runs_count,
    c.token_cost_records_count,
    c.estimated_cost_total,
    c.input_tokens_total,
    c.output_tokens_total,
    c.cached_tokens_total
  FROM run_summary AS r
  FULL OUTER JOIN cost_summary AS c ON c.tenant_id = r.tenant_id
  ORDER BY COALESCE(r.tenant_id, c.tenant_id);
END
$$;

REVOKE ALL ON FUNCTION agentos.platform_list_tenants() FROM PUBLIC, agentos_app;
REVOKE ALL ON FUNCTION agentos.platform_get_tenant(UUID) FROM PUBLIC, agentos_app;
REVOKE ALL ON FUNCTION agentos.platform_tenant_readiness(UUID) FROM PUBLIC, agentos_app;
REVOKE ALL ON FUNCTION agentos.platform_usage(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, agentos_app;

GRANT USAGE ON SCHEMA agentos TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_list_tenants() TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_get_tenant(UUID) TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_tenant_readiness(UUID) TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_usage(TIMESTAMPTZ, TIMESTAMPTZ) TO agentos_platform;
