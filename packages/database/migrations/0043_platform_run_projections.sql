-- Platform-scoped run and company operations projections (T8.1, decision D9).
--
-- Every function here is SECURITY DEFINER, owned by the migration role, and returns only
-- derived fields: a customer-facing search of these projections can see run lifecycle,
-- timing, failure class and eligibility — never a raw payload, a customer identifier or a
-- provider secret. The platform login role is NOLOGIN/NOBYPASSRLS and holds EXECUTE on
-- exactly these functions; agentos_app holds none of them (RLS rehearsal).

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

-- Derived run lifecycle state vocabulary matches `task_lifecycle_state`.
CREATE OR REPLACE FUNCTION agentos.platform_list_runs(
  p_tenant_id UUID DEFAULT NULL,
  p_state TEXT DEFAULT NULL,
  p_domain TEXT DEFAULT NULL,
  p_limit INT DEFAULT 50,
  p_before TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  tenant_id UUID,
  display_name VARCHAR(128),
  run_id VARCHAR(64),
  domain TEXT,
  current_step INT,
  state TEXT,
  failure_class TEXT,
  retry_eligible BOOLEAN,
  attempts INT,
  max_retries INT,
  duration_ms BIGINT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  correlation_id VARCHAR(64)
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT
    t.tenant_id,
    ten.display_name,
    t.run_id,
    CASE COALESCE(
      NULLIF(t.state_payload->>'domain', ''),
      NULLIF(t.state_payload->'signal'->'payload'->>'module', '')
    )
      WHEN 'care' THEN 'support'
      WHEN 'support' THEN 'support'
      WHEN 'sales' THEN 'sales'
      WHEN 'marketing' THEN 'marketing'
      ELSE 'unknown'
    END AS domain,
    t.current_step,
    t.state::TEXT,
    t.last_error_class,
    (t.state = 'failed'
      AND t.last_error_class = 'RETRYABLE'
      AND t.retry_count < t.max_retries) AS retry_eligible,
    t.retry_count,
    t.max_retries,
    (EXTRACT(EPOCH FROM (t.updated_at - t.created_at)) * 1000)::BIGINT AS duration_ms,
    t.created_at,
    t.updated_at,
    t.correlation_id
  FROM agentos.platform_durable_tasks AS t
  JOIN agentos.tenants AS ten ON ten.tenant_id = t.tenant_id
  WHERE (p_tenant_id IS NULL OR t.tenant_id = p_tenant_id)
    AND (p_state IS NULL OR t.state::TEXT = p_state)
    AND (p_before IS NULL OR t.created_at < p_before)
    AND (
      p_domain IS NULL
      OR (CASE COALESCE(NULLIF(t.state_payload->>'domain', ''), NULLIF(t.state_payload->'signal'->'payload'->>'module', ''))
            WHEN 'care' THEN 'support'
            WHEN 'support' THEN 'support'
            WHEN 'sales' THEN 'sales'
            WHEN 'marketing' THEN 'marketing'
            ELSE 'unknown'
          END) = p_domain
    )
  ORDER BY t.created_at DESC, t.run_id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
$$;

CREATE OR REPLACE FUNCTION agentos.platform_run_detail(
  p_tenant_id UUID,
  p_run_id VARCHAR(64)
)
RETURNS TABLE (
  tenant_id UUID,
  display_name VARCHAR(128),
  run_id VARCHAR(64),
  domain TEXT,
  correlation_id VARCHAR(64),
  current_step INT,
  state TEXT,
  task_version INT,
  failure_class TEXT,
  retry_eligible BOOLEAN,
  attempts INT,
  max_retries INT,
  lease_expires_at TIMESTAMPTZ,
  duration_ms BIGINT,
  stage_event_count BIGINT,
  evidence_count BIGINT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT
    t.tenant_id,
    ten.display_name,
    t.run_id,
    CASE COALESCE(
      NULLIF(t.state_payload->>'domain', ''),
      NULLIF(t.state_payload->'signal'->'payload'->>'module', '')
    )
      WHEN 'care' THEN 'support'
      WHEN 'support' THEN 'support'
      WHEN 'sales' THEN 'sales'
      WHEN 'marketing' THEN 'marketing'
      ELSE 'unknown'
    END AS domain,
    t.correlation_id,
    t.current_step,
    t.state::TEXT,
    t.task_version,
    t.last_error_class,
    (t.state = 'failed'
      AND t.last_error_class = 'RETRYABLE'
      AND t.retry_count < t.max_retries) AS retry_eligible,
    t.retry_count,
    t.max_retries,
    t.lease_expires_at,
    (EXTRACT(EPOCH FROM (t.updated_at - t.created_at)) * 1000)::BIGINT AS duration_ms,
    (SELECT COUNT(*) FROM agentos.run_stage_events AS e
      WHERE e.tenant_id = t.tenant_id AND e.run_id = t.run_id)::BIGINT AS stage_event_count,
    (SELECT COUNT(*) FROM agentos.evidence_records AS ev
      WHERE ev.tenant_id = t.tenant_id AND ev.run_id = t.run_id)::BIGINT AS evidence_count,
    t.created_at,
    t.updated_at
  FROM agentos.platform_durable_tasks AS t
  JOIN agentos.tenants AS ten ON ten.tenant_id = t.tenant_id
  WHERE t.tenant_id = p_tenant_id AND t.run_id = p_run_id
$$;

CREATE OR REPLACE FUNCTION agentos.platform_runs_summary()
RETURNS TABLE (
  state TEXT,
  run_count BIGINT,
  tenant_count BIGINT,
  retry_eligible_count BIGINT,
  reconciliation_count BIGINT
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT
    t.state::TEXT,
    COUNT(*)::BIGINT,
    COUNT(DISTINCT t.tenant_id)::BIGINT,
    COUNT(*) FILTER (
      WHERE t.state = 'failed' AND t.last_error_class = 'RETRYABLE' AND t.retry_count < t.max_retries
    )::BIGINT,
    COUNT(*) FILTER (
      WHERE t.state = 'failed'
        AND (t.last_error_class IS DISTINCT FROM 'RETRYABLE' OR t.retry_count >= t.max_retries)
    )::BIGINT
  FROM agentos.platform_durable_tasks AS t
  GROUP BY t.state
  ORDER BY t.state
$$;

CREATE OR REPLACE FUNCTION agentos.platform_reconciliation_queue(
  p_tenant_id UUID DEFAULT NULL,
  p_limit INT DEFAULT 50
)
RETURNS TABLE (
  tenant_id UUID,
  display_name VARCHAR(128),
  run_id VARCHAR(64),
  domain TEXT,
  state TEXT,
  failure_class TEXT,
  attempts INT,
  max_retries INT,
  reason TEXT,
  correlation_id VARCHAR(64),
  updated_at TIMESTAMPTZ
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT
    t.tenant_id,
    ten.display_name,
    t.run_id,
    CASE COALESCE(
      NULLIF(t.state_payload->>'domain', ''),
      NULLIF(t.state_payload->'signal'->'payload'->>'module', '')
    )
      WHEN 'care' THEN 'support'
      WHEN 'support' THEN 'support'
      WHEN 'sales' THEN 'sales'
      WHEN 'marketing' THEN 'marketing'
      ELSE 'unknown'
    END AS domain,
    t.state::TEXT,
    t.last_error_class,
    t.retry_count,
    t.max_retries,
    CASE
      WHEN t.last_error_class IS DISTINCT FROM 'RETRYABLE' THEN 'INDETERMINATE_OUTCOME'
      ELSE 'RETRIES_EXHAUSTED'
    END AS reason,
    t.correlation_id,
    t.updated_at
  FROM agentos.platform_durable_tasks AS t
  JOIN agentos.tenants AS ten ON ten.tenant_id = t.tenant_id
  WHERE t.state = 'failed'
    AND (t.last_error_class IS DISTINCT FROM 'RETRYABLE' OR t.retry_count >= t.max_retries)
    AND (p_tenant_id IS NULL OR t.tenant_id = p_tenant_id)
  ORDER BY t.updated_at ASC, t.run_id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
$$;

CREATE OR REPLACE FUNCTION agentos.platform_company_overview(p_tenant_id UUID)
RETURNS TABLE (
  tenant_id UUID,
  display_name VARCHAR(128),
  status TEXT,
  data_class TEXT,
  created_at TIMESTAMPTZ,
  runs_total BIGINT,
  runs_failed BIGINT,
  runs_running BIGINT,
  runs_waiting BIGINT,
  retry_eligible_count BIGINT,
  reconciliation_count BIGINT,
  needs_attention BOOLEAN,
  last_activity_at TIMESTAMPTZ
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT
    ten.tenant_id,
    ten.display_name,
    ten.status,
    ten.data_class::TEXT,
    ten.created_at,
    COALESCE(agg.runs_total, 0)::BIGINT,
    COALESCE(agg.runs_failed, 0)::BIGINT,
    COALESCE(agg.runs_running, 0)::BIGINT,
    COALESCE(agg.runs_waiting, 0)::BIGINT,
    COALESCE(agg.retry_eligible_count, 0)::BIGINT,
    COALESCE(agg.reconciliation_count, 0)::BIGINT,
    COALESCE(agg.runs_failed, 0) > 0
      OR COALESCE(agg.reconciliation_count, 0) > 0 AS needs_attention,
    agg.last_activity_at
  FROM agentos.tenants AS ten
  LEFT JOIN LATERAL (
    SELECT
      COUNT(*)::BIGINT AS runs_total,
      COUNT(*) FILTER (WHERE t.state = 'failed')::BIGINT AS runs_failed,
      COUNT(*) FILTER (WHERE t.state = 'running')::BIGINT AS runs_running,
      COUNT(*) FILTER (WHERE t.state IN ('queued', 'waiting', 'awaiting_human'))::BIGINT AS runs_waiting,
      COUNT(*) FILTER (
        WHERE t.state = 'failed' AND t.last_error_class = 'RETRYABLE' AND t.retry_count < t.max_retries
      )::BIGINT AS retry_eligible_count,
      COUNT(*) FILTER (
        WHERE t.state = 'failed'
          AND (t.last_error_class IS DISTINCT FROM 'RETRYABLE' OR t.retry_count >= t.max_retries)
      )::BIGINT AS reconciliation_count,
      MAX(t.updated_at) AS last_activity_at
    FROM agentos.platform_durable_tasks AS t
    WHERE t.tenant_id = ten.tenant_id
  ) AS agg ON TRUE
  WHERE ten.tenant_id = p_tenant_id
$$;

REVOKE ALL ON FUNCTION agentos.platform_list_runs(UUID, TEXT, TEXT, INT, TIMESTAMPTZ) FROM PUBLIC, agentos_app;
REVOKE ALL ON FUNCTION agentos.platform_run_detail(UUID, VARCHAR) FROM PUBLIC, agentos_app;
REVOKE ALL ON FUNCTION agentos.platform_runs_summary() FROM PUBLIC, agentos_app;
REVOKE ALL ON FUNCTION agentos.platform_reconciliation_queue(UUID, INT) FROM PUBLIC, agentos_app;
REVOKE ALL ON FUNCTION agentos.platform_company_overview(UUID) FROM PUBLIC, agentos_app;

GRANT USAGE ON SCHEMA agentos TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_list_runs(UUID, TEXT, TEXT, INT, TIMESTAMPTZ) TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_run_detail(UUID, VARCHAR) TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_runs_summary() TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_reconciliation_queue(UUID, INT) TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_company_overview(UUID) TO agentos_platform;
