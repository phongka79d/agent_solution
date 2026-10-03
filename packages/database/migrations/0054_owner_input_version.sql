-- Owner-input resolutions use a per-input version for optimistic concurrency.
ALTER TABLE agentos.unresolved_owner_inputs
  ADD COLUMN version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0);

GRANT UPDATE (version) ON agentos.unresolved_owner_inputs TO agentos_app;
