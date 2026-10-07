-- Idempotent message appends for operator replies.
-- An operator reply carries a bounded request key; a replay of the same key on the same
-- conversation returns the original message instead of appending a second one. The unique index is
-- partial so every existing row (and every automated turn, which has no request key) is unaffected.

ALTER TABLE agentos.conversation_messages
    ADD COLUMN request_id VARCHAR(128);

CREATE UNIQUE INDEX uq_conversation_messages_request
    ON agentos.conversation_messages (tenant_id, conversation_id, request_id, sender_type)
    WHERE request_id IS NOT NULL;
