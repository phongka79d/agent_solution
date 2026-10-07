-- Durable terminal responses for one orchestrated run.
-- The response belongs to the same tenant-scoped durable task as its run. A conversational
-- response may also retain the agent message that was written atomically with it.

-- `conversation_messages.id` is already globally unique, but the tenant pair is required by the
-- composite foreign key below so PostgreSQL checks both identity and ownership at the boundary.
ALTER TABLE agentos.conversation_messages
    ADD CONSTRAINT uq_conversation_messages_tenant_id UNIQUE (tenant_id, id);

CREATE TABLE agentos.run_responses (
    tenant_id UUID NOT NULL,
    run_id VARCHAR(64) NOT NULL,
    answer TEXT NOT NULL,
    sources JSONB NOT NULL,
    conversation_id UUID,
    message_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT pk_run_responses PRIMARY KEY (tenant_id, run_id),
    CONSTRAINT uq_run_responses_message UNIQUE (tenant_id, message_id),
    CONSTRAINT fk_run_responses_task
        FOREIGN KEY (tenant_id, run_id)
        REFERENCES agentos.platform_durable_tasks (tenant_id, run_id)
        ON DELETE CASCADE,
    CONSTRAINT fk_run_responses_conversation
        FOREIGN KEY (tenant_id, conversation_id)
        REFERENCES agentos.conversations (tenant_id, id)
        ON DELETE SET NULL (conversation_id),
    CONSTRAINT fk_run_responses_message
        FOREIGN KEY (tenant_id, message_id)
        REFERENCES agentos.conversation_messages (tenant_id, id)
        ON DELETE SET NULL (message_id),
    CONSTRAINT ck_run_responses_message_has_conversation
        CHECK (message_id IS NULL OR conversation_id IS NOT NULL)
);

CREATE INDEX idx_run_responses_conversation
    ON agentos.run_responses (tenant_id, conversation_id)
    WHERE conversation_id IS NOT NULL;

ALTER TABLE agentos.run_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.run_responses FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON agentos.run_responses
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

GRANT SELECT, INSERT, UPDATE, DELETE ON agentos.run_responses TO agentos_app;
