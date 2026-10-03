-- Bind AUTH-4 approval digests to the canonicalization contract version that produced them.
ALTER TABLE agentos.approvals
  ADD COLUMN digest_version INTEGER NOT NULL DEFAULT 1
    CHECK (digest_version > 0);
