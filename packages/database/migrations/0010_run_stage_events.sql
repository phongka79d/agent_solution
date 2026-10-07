-- Durable, append-only lifecycle stage and provider-call trace for one run.
-- Requires 0009_run_responses.sql (and therefore the tenant-scoped durable task key).

CREATE TYPE agentos.run_stage AS ENUM (
    'SIGNAL',
    'CONTEXT',
    'HYPOTHESIS',
    'DECISION',
    'PLAN',
    'ACTION',
    'APPROVAL',
    'EXECUTION',
    'EVIDENCE',
    'OUTCOME',
    'LEARNING'
);

CREATE TABLE agentos.run_stage_events (
    tenant_id UUID NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    attempt_ordinal INT NOT NULL,
    step_index INT NOT NULL,
    stage agentos.run_stage NOT NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    evidence_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    entered_at TIMESTAMPTZ NOT NULL,

    CONSTRAINT pk_run_stage_events PRIMARY KEY (tenant_id, run_id, attempt_ordinal, step_index, stage),
    -- The composite run key already proves the tenant: `platform_durable_tasks (tenant_id, run_id)`
    -- is the run's identity, so no separate `agentos.tenants` row is required to record a stage.
    -- (Provisioning a tenant stays a privileged action; the app role holds SELECT only.)
    CONSTRAINT fk_run_stage_events_run
        FOREIGN KEY (tenant_id, run_id)
        REFERENCES agentos.platform_durable_tasks (tenant_id, run_id)
        ON DELETE CASCADE,
    CONSTRAINT ck_run_stage_events_attempt_positive CHECK (attempt_ordinal >= 1),
    CONSTRAINT ck_run_stage_events_step_nonnegative CHECK (step_index >= 0)
);

CREATE INDEX idx_run_stage_events_run
    ON agentos.run_stage_events (tenant_id, run_id, attempt_ordinal, entered_at, step_index);

CREATE TABLE agentos.provider_call_ledger (
    tenant_id UUID NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    step_index INT NOT NULL,
    stage agentos.run_stage NOT NULL,
    call_index INT NOT NULL,
    provider VARCHAR(128) NOT NULL,
    model VARCHAR(256) NOT NULL,
    observed_status VARCHAR(64) NOT NULL,
    latency_ms INT,
    prompt_tokens INT,
    completion_tokens INT,
    cached_tokens INT,
    estimated_cost_amount NUMERIC(20, 8),
    currency VARCHAR(8),
    cost_status VARCHAR(32),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT pk_provider_call_ledger PRIMARY KEY (tenant_id, run_id, step_index, stage, call_index),
    CONSTRAINT fk_provider_call_ledger_run
        FOREIGN KEY (tenant_id, run_id)
        REFERENCES agentos.platform_durable_tasks (tenant_id, run_id)
        ON DELETE CASCADE,
    CONSTRAINT ck_provider_call_ledger_step_nonnegative CHECK (step_index >= 0),
    CONSTRAINT ck_provider_call_ledger_call_nonnegative CHECK (call_index >= 0),
    CONSTRAINT ck_provider_call_ledger_latency_nonnegative CHECK (latency_ms IS NULL OR latency_ms >= 0),
    CONSTRAINT ck_provider_call_ledger_prompt_tokens_nonnegative CHECK (prompt_tokens IS NULL OR prompt_tokens >= 0),
    CONSTRAINT ck_provider_call_ledger_completion_tokens_nonnegative CHECK (completion_tokens IS NULL OR completion_tokens >= 0),
    CONSTRAINT ck_provider_call_ledger_cached_tokens_nonnegative CHECK (cached_tokens IS NULL OR cached_tokens >= 0),
    CONSTRAINT ck_provider_call_ledger_currency_with_cost CHECK (
        estimated_cost_amount IS NULL OR currency IS NOT NULL
    )
);

CREATE INDEX idx_provider_call_ledger_run
    ON agentos.provider_call_ledger (tenant_id, run_id, step_index, stage, call_index);

ALTER TABLE agentos.run_stage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.run_stage_events FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON agentos.run_stage_events
    AS PERMISSIVE
    FOR ALL
    USING (
        tenant_id = ANY (
            string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]
        )
    )
    WITH CHECK (
        tenant_id = ANY (
            string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]
        )
    );

ALTER TABLE agentos.provider_call_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.provider_call_ledger FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON agentos.provider_call_ledger
    AS PERMISSIVE
    FOR ALL
    USING (
        tenant_id = ANY (
            string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]
        )
    )
    WITH CHECK (
        tenant_id = ANY (
            string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]
        )
    );

-- The trace tables are append-only for every application path, but removing the owning run (a
-- privileged retention action) must not be blocked by its own cascade. `pg_trigger_depth() > 1`
-- is true only when this delete was caused by another trigger (the run's foreign-key cascade); a
-- direct DELETE or any UPDATE on these tables still refuses, so the trace stays tamper-evident.
CREATE OR REPLACE FUNCTION agentos.prevent_append_only_trace_tampering()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Table % is append-only and strictly immutable (NFR-002 Auditability Violation)', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_immutable_run_stage_events
    BEFORE UPDATE OR DELETE ON agentos.run_stage_events
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_append_only_trace_tampering();

CREATE TRIGGER trg_immutable_provider_call_ledger
    BEFORE UPDATE OR DELETE ON agentos.provider_call_ledger
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_append_only_trace_tampering();

GRANT SELECT, INSERT ON agentos.run_stage_events TO agentos_app;
GRANT SELECT, INSERT ON agentos.provider_call_ledger TO agentos_app;
