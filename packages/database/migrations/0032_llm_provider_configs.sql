-- Platform-owned provider defaults, tenant overrides, and sanitized probe outcomes.
CREATE TABLE agentos.platform_llm_providers (
  provider_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 128),
  base_url TEXT NOT NULL CHECK (base_url ~ '^https://'),
  reasoning_model TEXT NOT NULL CHECK (length(reasoning_model) BETWEEN 1 AND 128),
  fast_model TEXT NOT NULL CHECK (length(fast_model) BETWEEN 1 AND 128),
  timeout_ms INTEGER NOT NULL CHECK (timeout_ms BETWEEN 1000 AND 120000),
  structured_mode TEXT NOT NULL CHECK (structured_mode IN ('json_object', 'json_schema')),
  secret_id UUID REFERENCES agentos.platform_secrets (secret_id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'CONFIGURED' CHECK (status IN ('CONFIGURED', 'VERIFIED', 'FAILED')),
  is_default BOOLEAN NOT NULL DEFAULT false,
  config_version BIGINT NOT NULL DEFAULT 1 CHECK (config_version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX platform_llm_providers_single_default
  ON agentos.platform_llm_providers (is_default) WHERE is_default;
ALTER TABLE agentos.platform_llm_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.platform_llm_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_llm_providers_platform_access ON agentos.platform_llm_providers
  FOR ALL TO agentos_platform USING (true) WITH CHECK (true);

CREATE TABLE agentos.tenant_llm_configs (
  tenant_id UUID PRIMARY KEY REFERENCES agentos.tenants (tenant_id) ON DELETE RESTRICT,
  mode TEXT NOT NULL DEFAULT 'INHERIT' CHECK (mode IN ('INHERIT', 'CUSTOM')),
  provider_id TEXT,
  base_url TEXT CHECK (base_url IS NULL OR base_url ~ '^https://'),
  reasoning_model TEXT,
  fast_model TEXT,
  timeout_ms INTEGER CHECK (timeout_ms IS NULL OR timeout_ms BETWEEN 1000 AND 120000),
  structured_mode TEXT CHECK (structured_mode IS NULL OR structured_mode IN ('json_object', 'json_schema')),
  secret_id UUID,
  monthly_token_budget BIGINT CHECK (monthly_token_budget IS NULL OR monthly_token_budget > 0),
  CONSTRAINT tenant_llm_secret_reference FOREIGN KEY (tenant_id, secret_id)
    REFERENCES agentos.tenant_secrets (tenant_id, secret_id) ON DELETE RESTRICT,
  config_version BIGINT NOT NULL DEFAULT 1 CHECK (config_version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT tenant_llm_custom_complete CHECK (
    mode = 'INHERIT' OR (
      provider_id IS NOT NULL AND base_url IS NOT NULL AND reasoning_model IS NOT NULL AND fast_model IS NOT NULL
      AND timeout_ms IS NOT NULL AND structured_mode IS NOT NULL AND secret_id IS NOT NULL
    )
  )
);
SELECT agentos.apply_tenant_rls('agentos.tenant_llm_configs');

CREATE TABLE agentos.llm_probe_results (
  probe_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope TEXT NOT NULL CHECK (scope IN ('PLATFORM', 'TENANT')),
  tenant_id UUID REFERENCES agentos.tenants (tenant_id) ON DELETE RESTRICT,
  provider_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('PASS', 'FAIL')),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  http_status SMALLINT CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  error_class TEXT,
  tested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((scope = 'PLATFORM' AND tenant_id IS NULL) OR (scope = 'TENANT' AND tenant_id IS NOT NULL))
);
ALTER TABLE agentos.llm_probe_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.llm_probe_results FORCE ROW LEVEL SECURITY;
CREATE POLICY llm_probe_tenant_isolation ON agentos.llm_probe_results
  FOR ALL TO agentos_app
  USING (tenant_id = ANY (pg_catalog.string_to_array(
    pg_catalog.current_setting('app.current_tenant_id', true), ',')::uuid[]))
  WITH CHECK (tenant_id = ANY (pg_catalog.string_to_array(
    pg_catalog.current_setting('app.current_tenant_id', true), ',')::uuid[]));
CREATE POLICY llm_probe_platform_access ON agentos.llm_probe_results
  FOR ALL TO agentos_platform USING (true) WITH CHECK (true);

REVOKE ALL ON TABLE agentos.platform_llm_providers, agentos.tenant_llm_configs,
  agentos.llm_probe_results FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE agentos.tenant_llm_configs,
      agentos.llm_probe_results TO agentos_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE agentos.platform_llm_providers,
      agentos.llm_probe_results TO agentos_platform;
  END IF;
END
$$;
