-- Tenant-scoped append-only history for connector verification probes.
CREATE TABLE agentos.connector_probe_results (
  tenant_id UUID NOT NULL,
  probe_id UUID NOT NULL DEFAULT agentos.uuid_generate_v7(),
  connector_id VARCHAR(64) NOT NULL,
  probe_name TEXT NOT NULL CHECK (probe_name IN ('catalog', 'inventory', 'customers', 'orders')),
  outcome TEXT NOT NULL CHECK (outcome IN ('PASS', 'FAIL')),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  http_status SMALLINT CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  error_class TEXT,
  probed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (tenant_id, probe_id),
  FOREIGN KEY (tenant_id, connector_id)
    REFERENCES agentos.connector_configurations (tenant_id, connector_id) ON DELETE RESTRICT
);

SELECT agentos.apply_tenant_rls('agentos.connector_probe_results');
GRANT SELECT, INSERT ON agentos.connector_probe_results TO agentos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON agentos.connector_probe_results FROM agentos_app;
