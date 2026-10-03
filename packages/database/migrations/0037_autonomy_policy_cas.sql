ALTER TABLE agentos.autonomy_policies
  ADD COLUMN policy_revision BIGINT NOT NULL DEFAULT 1;

ALTER TABLE agentos.autonomy_policies
  ADD CONSTRAINT ck_autonomy_policy_revision_positive CHECK (policy_revision > 0);
