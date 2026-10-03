-- Bounded platform-only skill execution aggregates over the append-only stage ledger.
-- The function exposes no tenant, run, customer, or payload identifiers.
CREATE FUNCTION agentos.platform_skill_fleet_health()
RETURNS TABLE (
  skill_id TEXT,
  runs_24h BIGINT,
  success_rate_24h NUMERIC,
  p95_ms_24h BIGINT
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  WITH attempts AS (
    SELECT r.tenant_id, r.run_id, r.step_index, r.skill_id, r.attempt_ordinal,
           pg_catalog.bool_and(r.status = 'completed') AS succeeded,
           pg_catalog.sum(r.duration_ms)::BIGINT AS duration_ms,
           pg_catalog.max(r.completed_at) AS completed_at
      FROM agentos.run_stage_results AS r
     WHERE r.skill_id IS NOT NULL
       AND r.completed_at >= pg_catalog.clock_timestamp() - INTERVAL '24 hours'
     GROUP BY r.tenant_id, r.run_id, r.step_index, r.skill_id, r.attempt_ordinal
  ), latest_attempts AS (
    SELECT a.*,
           pg_catalog.row_number() OVER (
             PARTITION BY a.tenant_id, a.run_id, a.step_index, a.skill_id
             ORDER BY a.attempt_ordinal DESC, a.completed_at DESC
           ) AS attempt_rank
      FROM attempts AS a
  ), executions AS (
    SELECT tenant_id, run_id, step_index, skill_id, succeeded, duration_ms
      FROM latest_attempts
     WHERE attempt_rank = 1
  )
  SELECT e.skill_id,
         pg_catalog.count(*)::BIGINT AS runs_24h,
         pg_catalog.round(
           100.0 * pg_catalog.count(*) FILTER (WHERE e.succeeded)::NUMERIC
           / NULLIF(pg_catalog.count(*), 0),
           1
         ) AS success_rate_24h,
         pg_catalog.percentile_disc(0.95) WITHIN GROUP (ORDER BY e.duration_ms)::BIGINT AS p95_ms_24h
    FROM executions AS e
   GROUP BY e.skill_id
   ORDER BY e.skill_id
$$;

REVOKE ALL ON FUNCTION agentos.platform_skill_fleet_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agentos.platform_skill_fleet_health() TO agentos_platform;
