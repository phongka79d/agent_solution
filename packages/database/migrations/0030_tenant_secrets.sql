-- Encrypted tenant credentials and platform-owned provider credentials.
CREATE TABLE agentos.tenant_secrets (
  tenant_id UUID NOT NULL REFERENCES agentos.tenants (tenant_id) ON DELETE RESTRICT,
  secret_id UUID NOT NULL,
  purpose TEXT NOT NULL,
  key_version CHAR(8) NOT NULL,
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) >= 16),
  fingerprint CHAR(64) NOT NULL,
  last4 TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, secret_id)
);

SELECT agentos.apply_tenant_rls('agentos.tenant_secrets');

CREATE TABLE agentos.platform_secrets (
  secret_id UUID PRIMARY KEY,
  purpose TEXT NOT NULL,
  key_version CHAR(8) NOT NULL,
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) >= 16),
  fingerprint CHAR(64) NOT NULL,
  last4 TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ
);

-- Platform secrets have no tenant column; isolate them to explicit platform-role sessions.
ALTER TABLE agentos.platform_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.platform_secrets FORCE ROW LEVEL SECURITY;
CREATE POLICY platform_secrets_platform_read ON agentos.platform_secrets
  FOR SELECT TO agentos_platform USING (true);
CREATE POLICY platform_secrets_platform_insert ON agentos.platform_secrets
  FOR INSERT TO agentos_platform WITH CHECK (true);
CREATE POLICY platform_secrets_platform_update ON agentos.platform_secrets
  FOR UPDATE TO agentos_platform USING (true) WITH CHECK (true);
REVOKE CREATE ON SCHEMA agentos FROM agentos_platform;
REVOKE ALL ON TABLE agentos.tenant_secrets FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app') THEN
    REVOKE ALL ON TABLE agentos.tenant_secrets FROM agentos_app;
    GRANT SELECT, INSERT, UPDATE ON TABLE agentos.tenant_secrets TO agentos_app;
  END IF;
END
$$;

REVOKE ALL ON TABLE agentos.platform_secrets FROM PUBLIC, agentos_app;
GRANT USAGE ON SCHEMA agentos TO agentos_platform;
GRANT SELECT, INSERT, UPDATE ON TABLE agentos.platform_secrets TO agentos_platform;
