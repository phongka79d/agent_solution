-- Platform usage projection v2 (T8.4, PLAN §8.5).
--
-- Replaces agentos.platform_usage(TIMESTAMPTZ, TIMESTAMPTZ) with an additive
-- grouping projection: one row per company / UTC day / domain / model / currency.
-- Only cost rows with cost_status = 'RECORDED' contribute to cost_total; rows with
-- cost_status = 'UNAVAILABLE' are returned with cost_recorded = false, currency NULL
-- and cost_total NULL, so a consumer can never sum an unrecorded cost into a currency
-- total. Tokens are counted for both recorded and unrecorded rows.
--
-- The return signature changes, which CREATE OR REPLACE cannot do, so the v1 function is dropped
-- first. It stays SECURITY DEFINER (owner executes the privileged reads) and the execution grants
-- are re-asserted on the new function.

DROP FUNCTION IF EXISTS agentos.platform_usage(TIMESTAMPTZ, TIMESTAMPTZ);

CREATE FUNCTION agentos.platform_usage(
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

REVOKE ALL ON FUNCTION agentos.platform_usage(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, agentos_app;
GRANT EXECUTE ON FUNCTION agentos.platform_usage(TIMESTAMPTZ, TIMESTAMPTZ) TO agentos_platform;
