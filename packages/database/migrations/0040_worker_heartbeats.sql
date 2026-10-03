-- Cross-process worker presence and a value-free platform health projection.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = current_user
      AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'worker_health_owner_must_bypass_rls'
      USING ERRCODE = '42501';
  END IF;
END
$$;

CREATE TABLE agentos.worker_heartbeats (
  worker_id TEXT PRIMARY KEY CHECK (length(worker_id) BETWEEN 1 AND 128),
  heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE agentos.worker_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.worker_heartbeats FORCE ROW LEVEL SECURITY;
CREATE POLICY worker_heartbeats_app_write ON agentos.worker_heartbeats
  FOR ALL TO agentos_app USING (true) WITH CHECK (true);
CREATE POLICY worker_heartbeats_platform_read ON agentos.worker_heartbeats
  FOR SELECT TO agentos_platform USING (true);
REVOKE ALL ON TABLE agentos.worker_heartbeats FROM PUBLIC, agentos_app, agentos_platform;
GRANT SELECT, INSERT, UPDATE ON TABLE agentos.worker_heartbeats TO agentos_app;
GRANT SELECT ON TABLE agentos.worker_heartbeats TO agentos_platform;

CREATE OR REPLACE FUNCTION agentos.platform_system_health_snapshot()
RETURNS JSONB
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT jsonb_build_object(
    'workers', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('worker_id', worker_id, 'heartbeat_at', heartbeat_at)
                       ORDER BY worker_id)
      FROM agentos.worker_heartbeats
    ), '[]'::jsonb),
    'queue_depth', COALESCE((
      SELECT count(*) FROM agentos.platform_durable_tasks WHERE state = 'queued'
    ), 0),
    'oldest_queued_at', (
      SELECT min(created_at) FROM agentos.platform_durable_tasks WHERE state = 'queued'
    ),
    'expired_leases', COALESCE((
      SELECT count(*) FROM agentos.platform_durable_tasks
      WHERE state = 'running' AND lease_expires_at < clock_timestamp()
    ), 0),
    'llm_last_probe', (
      SELECT to_jsonb(probe)
      FROM (
        SELECT scope, provider_id, outcome, latency_ms, error_class, tested_at
        FROM agentos.llm_probe_results
        ORDER BY tested_at DESC
        LIMIT 1
      ) AS probe
    ),
    'connectors', COALESCE((
      SELECT jsonb_agg(
        jsonb_build_object(
          'tenant_id', probes.tenant_id,
          'company', tenant.display_name,
          'connector_id', probes.connector_id,
          'probe_name', probes.probe_name,
          'outcome', probes.outcome,
          'latency_ms', probes.latency_ms,
          'error_class', probes.error_class,
          'probed_at', probes.probed_at
        ) ORDER BY tenant.display_name, probes.connector_id, probes.probe_name
      )
      FROM (
        SELECT DISTINCT ON (tenant_id, connector_id, probe_name)
          tenant_id, connector_id, probe_name, outcome, latency_ms, error_class, probed_at
        FROM agentos.connector_probe_results
        ORDER BY tenant_id, connector_id, probe_name, probed_at DESC
      ) AS probes
      JOIN agentos.tenants AS tenant ON tenant.tenant_id = probes.tenant_id
    ), '[]'::jsonb)
  )
$$;
REVOKE ALL ON FUNCTION agentos.platform_system_health_snapshot() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app') THEN
    GRANT EXECUTE ON FUNCTION agentos.platform_system_health_snapshot() TO agentos_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform') THEN
    GRANT EXECUTE ON FUNCTION agentos.platform_system_health_snapshot() TO agentos_platform;
  END IF;
END
$$;
