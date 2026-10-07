-- B15: make the tenant audit chain order independent of caller clocks.
-- 0000 creates audit_records and its append-only trigger. Existing rows are backfilled in the
-- historical reader order (timestamp, id) before the sequence becomes immutable and unique.

ALTER TABLE agentos.audit_records
  ADD COLUMN IF NOT EXISTS chain_seq BIGINT;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM agentos.audit_records
     WHERE chain_seq IS NULL
  ) THEN
    -- The migration is the one controlled backfill exception to the append-only trigger. The
    -- trigger is restored before this migration commits; application roles never receive this DDL.
    ALTER TABLE agentos.audit_records DISABLE TRIGGER trg_immutable_audit_records;

    WITH ordered AS (
      SELECT id,
             row_number() OVER (
               PARTITION BY tenant_id
               ORDER BY "timestamp", id
             )::BIGINT AS sequence_number
        FROM agentos.audit_records
    )
    UPDATE agentos.audit_records AS records
       SET chain_seq = ordered.sequence_number
      FROM ordered
     WHERE records.id = ordered.id
       AND records.chain_seq IS NULL;

    ALTER TABLE agentos.audit_records ENABLE TRIGGER trg_immutable_audit_records;
  END IF;
END
$$;

ALTER TABLE agentos.audit_records
  ALTER COLUMN chain_seq SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_catalog.pg_constraint
     WHERE conrelid = 'agentos.audit_records'::regclass
       AND conname = 'uq_audit_records_tenant_chain_seq'
  ) THEN
    ALTER TABLE agentos.audit_records
      ADD CONSTRAINT uq_audit_records_tenant_chain_seq UNIQUE (tenant_id, chain_seq);
  END IF;
END
$$;
