-- Make the provisioned tenant governance settings editable through a versioned tenant transaction.
ALTER TABLE agentos.tenant_governance_settings
  ADD COLUMN IF NOT EXISTS approval_expiry_hours INTEGER NOT NULL DEFAULT 72,
  ADD COLUMN IF NOT EXISTS takeover_lease_seconds INTEGER NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'agentos.tenant_governance_settings'::regclass
       AND conname = 'ck_tenant_governance_approval_expiry_hours'
  ) THEN
    ALTER TABLE agentos.tenant_governance_settings
      ADD CONSTRAINT ck_tenant_governance_approval_expiry_hours
      CHECK (approval_expiry_hours BETWEEN 1 AND 720);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'agentos.tenant_governance_settings'::regclass
       AND conname = 'ck_tenant_governance_takeover_lease_seconds'
  ) THEN
    ALTER TABLE agentos.tenant_governance_settings
      ADD CONSTRAINT ck_tenant_governance_takeover_lease_seconds
      CHECK (takeover_lease_seconds BETWEEN 30 AND 600);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
     WHERE conrelid = 'agentos.tenant_governance_settings'::regclass
       AND conname = 'ck_tenant_governance_version'
  ) THEN
    ALTER TABLE agentos.tenant_governance_settings
      ADD CONSTRAINT ck_tenant_governance_version CHECK (version > 0);
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app') THEN
    GRANT UPDATE (
      require_distinct_approver,
      approval_expiry_hours,
      takeover_lease_seconds,
      version,
      updated_at
    ) ON agentos.tenant_governance_settings TO agentos_app;
  END IF;
END
$$;
