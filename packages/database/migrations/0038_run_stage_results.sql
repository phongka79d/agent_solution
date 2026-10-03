-- Append-only completion details for lifecycle stages; the entry ledger remains in run_stage_events.
-- The task domain is derived from the already-persisted, constrained admission payload (no extra write path).
ALTER TABLE agentos.platform_durable_tasks
  ADD COLUMN domain TEXT GENERATED ALWAYS AS (
    CASE
      WHEN COALESCE(state_payload->>'domain', state_payload->'signal'->'payload'->>'module') IN ('sales', 'care', 'marketing')
        THEN COALESCE(state_payload->>'domain', state_payload->'signal'->'payload'->>'module')
      WHEN state_payload->'signal'->>'event_type' LIKE 'sales.%' THEN 'sales'
      WHEN state_payload->'signal'->>'event_type' LIKE 'care.%' THEN 'care'
      WHEN state_payload->'signal'->>'event_type' LIKE 'marketing.%' THEN 'marketing'
      ELSE 'orchestration'
    END
  ) STORED;

CREATE TABLE agentos.run_stage_results (
  tenant_id UUID NOT NULL,
  run_id VARCHAR(64) NOT NULL,
  attempt_ordinal INT NOT NULL,
  step_index INT NOT NULL,
  stage agentos.run_stage NOT NULL,
  status VARCHAR(32) NOT NULL CHECK (status IN ('completed', 'failed', 'refused', 'awaiting_human')),
  started_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  duration_ms INT NOT NULL CHECK (duration_ms >= 0),
  agent_code VARCHAR(32),
  skill_id VARCHAR(128),
  summary_key VARCHAR(128),
  refusal_code VARCHAR(64),
  error_class VARCHAR(32),
  input_digest CHAR(64) CHECK (input_digest IS NULL OR input_digest ~ '^[0-9a-f]{64}$'),
  output_digest CHAR(64) CHECK (output_digest IS NULL OR output_digest ~ '^[0-9a-f]{64}$'),
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT pk_run_stage_results PRIMARY KEY (tenant_id, run_id, attempt_ordinal, step_index, stage),
  CONSTRAINT fk_run_stage_results_run FOREIGN KEY (tenant_id, run_id)
    REFERENCES agentos.platform_durable_tasks (tenant_id, run_id) ON DELETE CASCADE,
  CONSTRAINT ck_run_stage_results_attempt_positive CHECK (attempt_ordinal >= 1),
  CONSTRAINT ck_run_stage_results_step_nonnegative CHECK (step_index >= 0),
  CONSTRAINT ck_run_stage_results_completion_order CHECK (completed_at >= started_at)
);

CREATE INDEX idx_run_stage_results_run
  ON agentos.run_stage_results (tenant_id, run_id, attempt_ordinal, started_at, step_index);

SELECT agentos.apply_tenant_rls('agentos.run_stage_results');
GRANT SELECT, INSERT ON agentos.run_stage_results TO agentos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON agentos.run_stage_results FROM agentos_app;

CREATE TRIGGER trg_immutable_run_stage_results
  BEFORE UPDATE OR DELETE ON agentos.run_stage_results
  FOR EACH ROW EXECUTE FUNCTION agentos.prevent_append_only_trace_tampering();

-- Legacy audit ledgers inherited UPDATE / DELETE / TRUNCATE from the broad 0002 table grant.
REVOKE UPDATE, DELETE, TRUNCATE ON agentos.audit_records FROM agentos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON agentos.agent_run_logs FROM agentos_app;
