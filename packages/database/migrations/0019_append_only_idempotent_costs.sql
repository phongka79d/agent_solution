-- B62: harden append-only traces and make token-cost writes replay-safe.
-- Requires 0018_attempt_allocator_customer_360_consent.sql.

-- run_responses and the trace/event tables are immutable after insertion. The repository creates
-- any conversation message before inserting its terminal response, so no UPDATE privilege is needed.
REVOKE UPDATE, DELETE, TRUNCATE ON agentos.run_responses FROM agentos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON agentos.provider_call_ledger FROM agentos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON agentos.service_case_events FROM agentos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON agentos.autonomy_policy_events FROM agentos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON agentos.autonomy_control_events FROM agentos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON agentos.provisioning_events FROM agentos_app;

-- These event tables predate the trace trigger added by 0010. Use the same trigger function so
-- direct UPDATE/DELETE attempts fail closed even for a role that is not the serving app role.

CREATE TRIGGER trg_immutable_run_responses
    BEFORE UPDATE OR DELETE ON agentos.run_responses
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_append_only_trace_tampering();
CREATE TRIGGER trg_immutable_service_case_events
    BEFORE UPDATE OR DELETE ON agentos.service_case_events
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_append_only_trace_tampering();

CREATE TRIGGER trg_immutable_autonomy_policy_events
    BEFORE UPDATE OR DELETE ON agentos.autonomy_policy_events
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_append_only_trace_tampering();

CREATE TRIGGER trg_immutable_autonomy_control_events
    BEFORE UPDATE OR DELETE ON agentos.autonomy_control_events
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_append_only_trace_tampering();

CREATE TRIGGER trg_immutable_provisioning_events
    BEFORE UPDATE OR DELETE ON agentos.provisioning_events
    FOR EACH ROW EXECUTE FUNCTION agentos.prevent_append_only_trace_tampering();

-- record_id remains the public row identity. idempotency_key is the stable producer key so a
-- retried write may use a deterministic key even when its generated record id changes.
ALTER TABLE agentos.token_cost_records
    ADD COLUMN idempotency_key VARCHAR(128);

UPDATE agentos.token_cost_records
   SET idempotency_key = record_id::text
 WHERE idempotency_key IS NULL;

ALTER TABLE agentos.token_cost_records
    ALTER COLUMN idempotency_key SET NOT NULL;

ALTER TABLE agentos.token_cost_records
    ADD CONSTRAINT uq_token_cost_records_idempotency UNIQUE (tenant_id, idempotency_key);
