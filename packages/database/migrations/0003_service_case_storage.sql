-- Durable case action receipts and append-only lifecycle history.
-- New application tables added after 0002 must declare their own RLS policy and grants.

ALTER TABLE agentos.service_cases
  ADD COLUMN evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN sla_target_hours INTEGER,
  ADD CONSTRAINT ck_service_cases_evidence_refs_array
    CHECK (jsonb_typeof(evidence_refs) = 'array'),
  ADD CONSTRAINT ck_service_cases_sla_target_hours_positive
    CHECK (sla_target_hours IS NULL OR sla_target_hours > 0);

ALTER TABLE agentos.service_cases
  ADD CONSTRAINT uq_service_cases_tenant_id UNIQUE (tenant_id, id);

CREATE TABLE agentos.service_case_events (
  id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
  tenant_id UUID NOT NULL,
  case_id UUID NOT NULL,
  effect_key CHAR(64) NOT NULL CHECK (effect_key ~ '^[0-9a-f]{64}$'),
  request_fingerprint CHAR(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  action_type VARCHAR(32) NOT NULL CHECK (action_type IN ('CREATE', 'TRANSITION_STATE', 'ASSIGN', 'RESOLVE', 'REOPEN', 'CLOSE')),
  actor_id VARCHAR(128) NOT NULL,
  case_version INT NOT NULL CHECK (case_version > 0),
  previous_state VARCHAR(32),
  next_state VARCHAR(32) NOT NULL CHECK (next_state IN ('NEW', 'CLASSIFIED', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED')),
  action_details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(action_details) = 'object'),
  result_payload JSONB NOT NULL CHECK (jsonb_typeof(result_payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_service_case_events_effect UNIQUE (tenant_id, effect_key),
  CONSTRAINT uq_service_case_events_version UNIQUE (tenant_id, case_id, case_version),
  CONSTRAINT fk_service_case_events_case FOREIGN KEY (tenant_id, case_id)
    REFERENCES agentos.service_cases (tenant_id, id) ON DELETE CASCADE
);

CREATE INDEX idx_service_case_events_case
  ON agentos.service_case_events (tenant_id, case_id, case_version);

ALTER TABLE agentos.service_case_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.service_case_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON agentos.service_case_events
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = ANY (string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]))
  WITH CHECK (tenant_id = ANY (string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]));

GRANT SELECT, INSERT ON agentos.service_case_events TO agentos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON agentos.service_case_events FROM agentos_app;
