-- Durable cross-domain handoff ledger. This handoff ledger is a ledger, not a queue: the target run
-- lives in agentos.platform_durable_tasks. Reservation, target task creation and the ledger row are
-- committed by admitCrossDomainHandoff in one tenant transaction.

CREATE TABLE agentos.cross_domain_handoffs (
  id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
  tenant_id UUID NOT NULL,
  customer_id UUID NOT NULL,
  correlation_id VARCHAR(128) NOT NULL,
  idempotency_key CHAR(64) NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  request_fingerprint CHAR(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  source_domain VARCHAR(32) NOT NULL,
  source_agent VARCHAR(32) NOT NULL,
  source_run_id VARCHAR(128) NOT NULL,
  target_domain VARCHAR(32) NOT NULL,
  target_agent VARCHAR(32) NOT NULL,
  target_module VARCHAR(32) NOT NULL,
  target_run_id VARCHAR(128) NOT NULL,
  reason TEXT NOT NULL,
  classification VARCHAR(16) NOT NULL CHECK (classification IN ('FACT', 'SIGNAL', 'HYPOTHESIS', 'DECISION', 'ACTION')),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
  lifecycle_state VARCHAR(32) NOT NULL,
  lifecycle_version BIGINT NOT NULL CHECK (lifecycle_version >= 1),
  hop_count INT NOT NULL CHECK (hop_count >= 1),
  visited_domains TEXT[] NOT NULL CHECK (array_length(visited_domains, 1) >= 1),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_cross_domain_handoffs_idempotency UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT uq_cross_domain_handoffs_lifecycle UNIQUE (tenant_id, customer_id, lifecycle_version),
  CONSTRAINT fk_cross_domain_handoffs_customer FOREIGN KEY (tenant_id, customer_id)
    REFERENCES agentos.customers (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_cross_domain_handoffs_task FOREIGN KEY (tenant_id, target_run_id)
    REFERENCES agentos.platform_durable_tasks (tenant_id, run_id) ON DELETE RESTRICT
);

CREATE INDEX idx_cross_domain_handoffs_customer_timeline
  ON agentos.cross_domain_handoffs (tenant_id, customer_id, occurred_at, id);

ALTER TABLE agentos.cross_domain_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.cross_domain_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON agentos.cross_domain_handoffs
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = ANY (string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]))
  WITH CHECK (tenant_id = ANY (string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]));

GRANT SELECT, INSERT, UPDATE ON agentos.cross_domain_handoffs TO agentos_app;
REVOKE DELETE, TRUNCATE ON agentos.cross_domain_handoffs FROM agentos_app;
