-- Typed terminal responses distinguish grounded answers from approved template replies.
ALTER TABLE agentos.run_responses
    ADD COLUMN response_kind TEXT NOT NULL DEFAULT 'ANSWER',
    ADD COLUMN outcome TEXT NOT NULL DEFAULT 'ANSWERED',
    ADD COLUMN source TEXT NOT NULL DEFAULT 'Core.Evidence@1',
    ADD COLUMN template_key TEXT,
    ADD COLUMN reason_code TEXT,
    ADD CONSTRAINT ck_run_responses_response_kind
        CHECK (response_kind IN ('ANSWER', 'CLARIFICATION', 'REFUSAL', 'NO_ANSWER', 'HANDOFF_ACK')),
    ADD CONSTRAINT ck_run_responses_outcome
        CHECK (outcome IN ('ANSWERED', 'CLARIFIED', 'REFUSED', 'NO_ANSWER', 'HANDOFF_ACK')),
    ADD CONSTRAINT ck_run_responses_source_nonempty
        CHECK (length(btrim(source)) > 0);
