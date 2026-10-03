-- 0061: operator retry eligibility after the automatic retry budget is spent.
--
-- The durable retry timer (T5.5) now spends the whole RETRYABLE budget automatically, so a run that
-- reaches `failed` with last_error_class = 'RETRYABLE' has retry_count = max_retries by construction.
-- The platform projections previously required retry_count < max_retries, which made every such run
-- ineligible and sent it to the reconciliation bucket, disagreeing with the server's retry route
-- (PLAN §13.2 "Admin retries a RETRYABLE failed run"; T8.3 actions from server retry_eligibility).
-- A failed RETRYABLE run is operator-retryable; any other failed run stays visible as a failed run.
-- UNKNOWN effects never reach `failed`: they park as `waiting` with wait_reason RECONCILE until the
-- sweeper or an operator settles them, and the operator reconcile command accepts only such a parked
-- run. The reconciliation queue and counts therefore list exactly those parked runs (PLAN T8.3
-- "UNKNOWN run → appears in Đối soát"); a run whose resolution is already queued is excluded.
-- Signatures, return shapes, security attributes and grants are unchanged (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION agentos.platform_list_runs(
  p_tenant_id UUID DEFAULT NULL,
  p_state TEXT DEFAULT NULL,
  p_domain TEXT DEFAULT NULL,
  p_limit INT DEFAULT 50,
  p_before TIMESTAMPTZ DEFAULT NULL,
  p_search TEXT DEFAULT NULL
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
      AND t.last_error_class = 'RETRYABLE') AS retry_eligible,
    t.retry_count,
    t.max_retries,
    (EXTRACT(EPOCH FROM (t.updated_at - t.created_at)) * 1000)::BIGINT AS duration_ms,
    t.created_at,
    t.updated_at,
    t.correlation_id
  FROM agentos.platform_durable_tasks AS t
  JOIN agentos.tenants AS ten ON ten.tenant_id = t.tenant_id
  LEFT JOIN LATERAL (
    SELECT CASE
      WHEN jsonb_typeof(t.state_payload #> '{signal,subject,conversation_id}') = 'string'
        AND jsonb_typeof(t.state_payload #> '{signal,payload,conversation_id}') = 'string'
        AND NULLIF(t.state_payload->'signal'->'subject'->>'conversation_id', '')
          = t.state_payload->'signal'->'payload'->>'conversation_id'
      THEN t.state_payload->'signal'->'subject'->>'conversation_id'
      ELSE NULL
    END AS conversation_id
  ) AS conversation ON TRUE
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
    AND (
      NULLIF(BTRIM(p_search), '') IS NULL
      OR POSITION(LOWER(BTRIM(p_search)) IN LOWER(t.run_id)) > 0
      OR POSITION(LOWER(BTRIM(p_search)) IN LOWER(t.correlation_id)) > 0
      OR POSITION(LOWER(BTRIM(p_search)) IN LOWER(COALESCE(conversation.conversation_id, ''))) > 0
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
  updated_at TIMESTAMPTZ,
  lease_owner VARCHAR(64),
  conversation_id TEXT,
  error_code TEXT,
  cost_breakdown JSONB,
  input_tokens_total BIGINT,
  output_tokens_total BIGINT,
  cached_tokens_total BIGINT
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
      AND t.last_error_class = 'RETRYABLE') AS retry_eligible,
    t.retry_count,
    t.max_retries,
    t.lease_expires_at,
    (EXTRACT(EPOCH FROM (t.updated_at - t.created_at)) * 1000)::BIGINT AS duration_ms,
    (SELECT COUNT(*) FROM agentos.run_stage_events AS e
      WHERE e.tenant_id = t.tenant_id AND e.run_id = t.run_id)::BIGINT AS stage_event_count,
    (SELECT COUNT(*) FROM agentos.evidence_records AS ev
      WHERE ev.tenant_id = t.tenant_id AND ev.run_id = t.run_id)::BIGINT AS evidence_count,
    t.created_at,
    t.updated_at,
    t.lease_owner,
    CASE
      WHEN jsonb_typeof(t.state_payload #> '{signal,subject,conversation_id}') = 'string'
        AND jsonb_typeof(t.state_payload #> '{signal,payload,conversation_id}') = 'string'
        AND NULLIF(t.state_payload->'signal'->'subject'->>'conversation_id', '')
          = t.state_payload->'signal'->'payload'->>'conversation_id'
      THEN t.state_payload->'signal'->'subject'->>'conversation_id'
      ELSE NULL
    END AS conversation_id,
    NULLIF(t.error_details->>'code', '') AS error_code,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'currency', totals.currency,
        'cost_recorded', totals.cost_recorded,
        'record_count', totals.record_count,
        'cost_total', totals.cost_total
      ) ORDER BY totals.cost_recorded DESC, totals.currency NULLS FIRST)
      FROM (
        SELECT
          (cost.cost_status = 'RECORDED') AS cost_recorded,
          CASE WHEN cost.cost_status = 'RECORDED' THEN cost.currency ELSE NULL END AS currency,
          COUNT(*)::BIGINT AS record_count,
          SUM(CASE WHEN cost.cost_status = 'RECORDED' THEN cost.estimated_cost_amount END)::TEXT AS cost_total
        FROM agentos.token_cost_records AS cost
        WHERE cost.tenant_id = t.tenant_id AND cost.run_id = t.run_id
        GROUP BY
          cost.cost_status,
          CASE WHEN cost.cost_status = 'RECORDED' THEN cost.currency ELSE NULL END
      ) AS totals
    ), '[]'::jsonb) AS cost_breakdown,
    COALESCE((
      SELECT SUM(COALESCE(cost.input_tokens, 0))::BIGINT
      FROM agentos.token_cost_records AS cost
      WHERE cost.tenant_id = t.tenant_id AND cost.run_id = t.run_id
    ), 0)::BIGINT AS input_tokens_total,
    COALESCE((
      SELECT SUM(COALESCE(cost.output_tokens, 0))::BIGINT
      FROM agentos.token_cost_records AS cost
      WHERE cost.tenant_id = t.tenant_id AND cost.run_id = t.run_id
    ), 0)::BIGINT AS output_tokens_total,
    COALESCE((
      SELECT SUM(COALESCE(cost.cached_tokens, 0))::BIGINT
      FROM agentos.token_cost_records AS cost
      WHERE cost.tenant_id = t.tenant_id AND cost.run_id = t.run_id
    ), 0)::BIGINT AS cached_tokens_total
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
      WHEN t.state_payload->>'reconciliation_required' = 'true' THEN 'RECONCILIATION_REQUIRED'
      ELSE 'INDETERMINATE_OUTCOME'
    END AS reason,
    t.correlation_id,
    t.updated_at
  FROM agentos.platform_durable_tasks AS t
  JOIN agentos.tenants AS ten ON ten.tenant_id = t.tenant_id
  WHERE t.state = 'waiting'
    AND t.state_payload->>'wait_reason' = 'RECONCILE'
    AND NOT (t.state_payload ? 'resume_event')
    AND (p_tenant_id IS NULL OR t.tenant_id = p_tenant_id)
  ORDER BY t.updated_at ASC, t.run_id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200)
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
      WHERE t.state = 'failed' AND t.last_error_class = 'RETRYABLE'
    )::BIGINT,
    COUNT(*) FILTER (
      WHERE t.state = 'waiting'
        AND t.state_payload->>'wait_reason' = 'RECONCILE'
        AND NOT (t.state_payload ? 'resume_event')
    )::BIGINT
  FROM agentos.platform_durable_tasks AS t
  GROUP BY t.state
  ORDER BY t.state
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
        WHERE t.state = 'failed' AND t.last_error_class = 'RETRYABLE'
      )::BIGINT AS retry_eligible_count,
      COUNT(*) FILTER (
        WHERE t.state = 'waiting'
          AND t.state_payload->>'wait_reason' = 'RECONCILE'
          AND NOT (t.state_payload ? 'resume_event')
      )::BIGINT AS reconciliation_count,
      MAX(t.updated_at) AS last_activity_at
    FROM agentos.platform_durable_tasks AS t
    WHERE t.tenant_id = ten.tenant_id
  ) AS agg ON TRUE
  WHERE ten.tenant_id = p_tenant_id
$$;
