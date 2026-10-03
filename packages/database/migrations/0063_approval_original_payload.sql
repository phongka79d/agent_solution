-- T6.8: retain the exact normalized input reviewed before MODIFY replaces its binding.
-- Legacy MODIFIED rows deliberately stay NULL: their original bytes cannot be reconstructed.
-- Existing table-level grants and tenant RLS cover these columns; no new privileges are needed.
ALTER TABLE agentos.approvals
  ADD COLUMN original_payload JSONB,
  ADD COLUMN original_payload_sha256 CHAR(64),
  ADD COLUMN original_digest_version INTEGER,
  ADD CONSTRAINT ck_approvals_original_payload CHECK (
    (original_payload IS NULL
      AND original_payload_sha256 IS NULL
      AND original_digest_version IS NULL)
    OR (original_payload IS NOT NULL
      AND jsonb_typeof(original_payload) = 'object'
      AND original_payload_sha256 IS NOT NULL
      AND original_payload_sha256 ~ '^[0-9a-f]{64}$'
      AND original_digest_version IS NOT NULL
      AND original_digest_version > 0)
  );
