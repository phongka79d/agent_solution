-- Durable Care escalation queue. Queue creation, task parking, conversation takeover state and
-- effect reservation settlement are committed by CareHandoffRepository in one tenant transaction.

CREATE TABLE agentos.care_handoffs (
  id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
  tenant_id UUID NOT NULL,
  run_id VARCHAR(64) NOT NULL,
  step_index INT NOT NULL CHECK (step_index > 0),
  effect_key CHAR(64) NOT NULL CHECK (effect_key ~ '^[0-9a-f]{64}$'),
  request_fingerprint CHAR(64) NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  session_id VARCHAR(128) NOT NULL,
  conversation_id UUID NOT NULL,
  customer_id UUID,
  escalation_reason TEXT NOT NULL,
  summary_context TEXT,
  status VARCHAR(16) NOT NULL DEFAULT 'ENQUEUED'
    CHECK (status IN ('ENQUEUED', 'ASSIGNED', 'COMPLETED')),
  queue_position INT NOT NULL CHECK (queue_position > 0),
  result_payload JSONB NOT NULL CHECK (jsonb_typeof(result_payload) = 'object'),
  execution_receipt JSONB NOT NULL CHECK (jsonb_typeof(execution_receipt) = 'object'),
  operator_id VARCHAR(128),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  completion_summary TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_care_handoffs_effect UNIQUE (tenant_id, effect_key),
  CONSTRAINT fk_care_handoffs_conversation FOREIGN KEY (tenant_id, conversation_id)
    REFERENCES agentos.conversations (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_care_handoffs_customer FOREIGN KEY (tenant_id, customer_id)
    REFERENCES agentos.customers (tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT fk_care_handoffs_task FOREIGN KEY (tenant_id, run_id)
    REFERENCES agentos.platform_durable_tasks (tenant_id, run_id) ON DELETE RESTRICT,
  CONSTRAINT fk_care_handoffs_effect FOREIGN KEY (tenant_id, effect_key)
    REFERENCES agentos.effect_reservations (tenant_id, effect_key) ON DELETE RESTRICT,
  CONSTRAINT ck_care_handoffs_assignment_state CHECK (
    (status = 'ENQUEUED' AND operator_id IS NULL AND claimed_at IS NULL AND completed_at IS NULL)
    OR (status = 'ASSIGNED' AND operator_id IS NOT NULL AND claimed_at IS NOT NULL AND completed_at IS NULL)
    OR (status = 'COMPLETED' AND operator_id IS NOT NULL AND claimed_at IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX uq_care_handoffs_active_conversation
  ON agentos.care_handoffs (tenant_id, conversation_id)
  WHERE status IN ('ENQUEUED', 'ASSIGNED');
CREATE INDEX idx_care_handoffs_queue
  ON agentos.care_handoffs (tenant_id, created_at, id)
  WHERE status = 'ENQUEUED';

ALTER TABLE agentos.care_handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.care_handoffs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON agentos.care_handoffs
  AS PERMISSIVE
  FOR ALL
  USING (tenant_id = ANY (string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]))
  WITH CHECK (tenant_id = ANY (string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]));

GRANT SELECT, INSERT, UPDATE ON agentos.care_handoffs TO agentos_app;
REVOKE DELETE, TRUNCATE ON agentos.care_handoffs FROM agentos_app;
