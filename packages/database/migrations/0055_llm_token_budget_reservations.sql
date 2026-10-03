CREATE TABLE agentos.llm_tenant_token_budget_usage (
  tenant_id UUID PRIMARY KEY REFERENCES agentos.tenants (tenant_id) ON DELETE CASCADE,
  used_tokens BIGINT NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
  reserved_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0)
);

CREATE TABLE agentos.llm_run_token_budget_usage (
  tenant_id UUID NOT NULL REFERENCES agentos.tenants (tenant_id) ON DELETE CASCADE,
  run_id VARCHAR(128) NOT NULL,
  used_tokens BIGINT NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
  reserved_tokens BIGINT NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  PRIMARY KEY (tenant_id, run_id)
);

CREATE TABLE agentos.llm_token_budget_reservations (
  tenant_id UUID NOT NULL,
  run_id VARCHAR(128) NOT NULL,
  reservation_id VARCHAR(128) NOT NULL,
  estimated_tokens BIGINT NOT NULL CHECK (estimated_tokens > 0),
  actual_tokens BIGINT CHECK (actual_tokens >= 0),
  state TEXT NOT NULL CHECK (state IN ('RESERVED', 'SETTLED')),
  reserved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  settled_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, run_id, reservation_id),
  FOREIGN KEY (tenant_id, run_id)
    REFERENCES agentos.llm_run_token_budget_usage (tenant_id, run_id)
    ON DELETE CASCADE
);

ALTER TABLE agentos.llm_tenant_token_budget_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.llm_tenant_token_budget_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON agentos.llm_tenant_token_budget_usage
  AS PERMISSIVE FOR ALL
  USING (tenant_id = ANY (string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]))
  WITH CHECK (tenant_id = ANY (string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]));

ALTER TABLE agentos.llm_run_token_budget_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.llm_run_token_budget_usage FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON agentos.llm_run_token_budget_usage
  AS PERMISSIVE FOR ALL
  USING (tenant_id = ANY (string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]))
  WITH CHECK (tenant_id = ANY (string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]));

ALTER TABLE agentos.llm_token_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.llm_token_budget_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation_policy ON agentos.llm_token_budget_reservations
  AS PERMISSIVE FOR ALL
  USING (tenant_id = ANY (string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]))
  WITH CHECK (tenant_id = ANY (string_to_array(current_setting('app.current_tenant_id', true), ',')::uuid[]));

GRANT SELECT, INSERT, UPDATE ON agentos.llm_tenant_token_budget_usage TO agentos_app;
GRANT SELECT, INSERT, UPDATE ON agentos.llm_run_token_budget_usage TO agentos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON agentos.llm_token_budget_reservations TO agentos_app;
