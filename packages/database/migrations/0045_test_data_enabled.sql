-- "Test data enabled" company setting (PLAN §9.1, T7.2).
-- Read by the Test Customer Lab; written by the platform company settings path (T8.2).
ALTER TABLE agentos.tenant_governance_settings
  ADD COLUMN IF NOT EXISTS test_data_enabled BOOLEAN NOT NULL DEFAULT FALSE;
