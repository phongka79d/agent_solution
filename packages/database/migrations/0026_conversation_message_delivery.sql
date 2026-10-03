-- Operator replies are stored before the widget confirms that it has read them.
ALTER TABLE agentos.conversation_messages
    ADD COLUMN delivery_status VARCHAR(16);

UPDATE agentos.conversation_messages
   SET delivery_status = 'STORED'
 WHERE sender_type = 'operator';

ALTER TABLE agentos.conversation_messages
    ADD CONSTRAINT ck_conversation_message_delivery_status
    CHECK (
      (sender_type = 'operator' AND delivery_status IN ('STORED', 'DELIVERED', 'FAILED'))
      OR (sender_type <> 'operator' AND delivery_status IS NULL)
    );
