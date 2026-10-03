-- Completed durable tasks retain their checkpoint under plan, not their admission signal.
-- Rebuild the derived column so its vocabulary remains sales/care/marketing.
ALTER TABLE agentos.platform_durable_tasks DROP COLUMN domain;

ALTER TABLE agentos.platform_durable_tasks
  ADD COLUMN domain TEXT GENERATED ALWAYS AS (
    CASE
      WHEN COALESCE(
        state_payload->>'domain',
        state_payload->'signal'->'payload'->>'module',
        CASE
          WHEN state_payload->'plan'->>'domain' = 'support' THEN 'care'
          ELSE state_payload->'plan'->>'domain'
        END
      ) IN ('sales', 'care', 'marketing')
        THEN COALESCE(
          state_payload->>'domain',
          state_payload->'signal'->'payload'->>'module',
          CASE
            WHEN state_payload->'plan'->>'domain' = 'support' THEN 'care'
            ELSE state_payload->'plan'->>'domain'
          END
        )
      WHEN state_payload->'signal'->>'event_type' LIKE 'sales.%' THEN 'sales'
      WHEN state_payload->'signal'->>'event_type' LIKE 'care.%' THEN 'care'
      WHEN state_payload->'signal'->>'event_type' LIKE 'marketing.%' THEN 'marketing'
      ELSE 'orchestration'
    END
  ) STORED;

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
      NULLIF(t.state_payload->'signal'->'payload'->>'module', ''),
      NULLIF(t.state_payload->'plan'->>'domain', '')
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
      OR (CASE COALESCE(
            NULLIF(t.state_payload->>'domain', ''),
            NULLIF(t.state_payload->'signal'->'payload'->>'module', ''),
            NULLIF(t.state_payload->'plan'->>'domain', '')
          )
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
      NULLIF(t.state_payload->'signal'->'payload'->>'module', ''),
      NULLIF(t.state_payload->'plan'->>'domain', '')
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
      NULLIF(t.state_payload->'signal'->'payload'->>'module', ''),
      NULLIF(t.state_payload->'plan'->>'domain', '')
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

CREATE OR REPLACE FUNCTION agentos.platform_usage(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
)
RETURNS TABLE (
  tenant_id UUID,
  display_name VARCHAR(128),
  usage_day TEXT,
  domain TEXT,
  model TEXT,
  currency VARCHAR(8),
  cost_recorded BOOLEAN,
  record_count BIGINT,
  input_tokens_total BIGINT,
  output_tokens_total BIGINT,
  cached_tokens_total BIGINT,
  tokens_total BIGINT,
  cost_total NUMERIC,
  monthly_token_budget BIGINT
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
  WITH window_rows AS (
    SELECT
      c.tenant_id,
      t.display_name::VARCHAR(128),
      to_char((c.recorded_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS usage_day,
      COALESCE(
        NULLIF(t_task.state_payload->>'domain', ''),
        NULLIF(t_task.state_payload->'signal'->'payload'->>'module', ''),
        NULLIF(t_task.state_payload->'plan'->>'domain', ''),
        NULLIF(c.provenance->>'domain', '')
      ) AS domain,
      NULLIF(c.model, '') AS model,
      CASE WHEN c.cost_status = 'RECORDED' THEN c.currency ELSE NULL END AS currency,
      (c.cost_status = 'RECORDED') AS cost_recorded,
      c.input_tokens,
      c.output_tokens,
      c.cached_tokens,
      c.estimated_cost_amount,
      cfg.monthly_token_budget
    FROM agentos.token_cost_records AS c
    JOIN agentos.tenants AS t
      ON t.tenant_id = c.tenant_id
    LEFT JOIN agentos.platform_durable_tasks AS t_task
      ON t_task.tenant_id = c.tenant_id AND t_task.run_id = c.run_id
    LEFT JOIN agentos.tenant_llm_configs AS cfg
      ON cfg.tenant_id = c.tenant_id
    WHERE c.recorded_at >= p_from AND c.recorded_at < p_to
  )
  SELECT
    w.tenant_id,
    w.display_name,
    w.usage_day,
    w.domain,
    w.model,
    w.currency,
    w.cost_recorded,
    COUNT(*)::BIGINT AS record_count,
    SUM(COALESCE(w.input_tokens, 0))::BIGINT AS input_tokens_total,
    SUM(COALESCE(w.output_tokens, 0))::BIGINT AS output_tokens_total,
    SUM(COALESCE(w.cached_tokens, 0))::BIGINT AS cached_tokens_total,
    SUM(
      COALESCE(w.input_tokens, 0)
      + COALESCE(w.output_tokens, 0)
      + COALESCE(w.cached_tokens, 0)
    )::BIGINT AS tokens_total,
    SUM(CASE WHEN w.cost_recorded THEN w.estimated_cost_amount ELSE NULL END) AS cost_total,
    w.monthly_token_budget
  FROM window_rows AS w
  GROUP BY
    w.tenant_id,
    w.display_name,
    w.usage_day,
    w.domain,
    w.model,
    w.currency,
    w.cost_recorded,
    w.monthly_token_budget
  ORDER BY
    w.tenant_id,
    w.usage_day,
    w.domain,
    w.model,
    w.currency NULLS FIRST,
    w.cost_recorded;
END
$$;

REVOKE ALL ON FUNCTION agentos.platform_list_runs(UUID, TEXT, TEXT, INT, TIMESTAMPTZ) FROM PUBLIC, agentos_app;
REVOKE ALL ON FUNCTION agentos.platform_run_detail(UUID, VARCHAR) FROM PUBLIC, agentos_app;
REVOKE ALL ON FUNCTION agentos.platform_reconciliation_queue(UUID, INT) FROM PUBLIC, agentos_app;
GRANT EXECUTE ON FUNCTION agentos.platform_list_runs(UUID, TEXT, TEXT, INT, TIMESTAMPTZ) TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_run_detail(UUID, VARCHAR) TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_reconciliation_queue(UUID, INT) TO agentos_platform;
REVOKE ALL ON FUNCTION agentos.platform_usage(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, agentos_app;
GRANT EXECUTE ON FUNCTION agentos.platform_usage(TIMESTAMPTZ, TIMESTAMPTZ) TO agentos_platform;
