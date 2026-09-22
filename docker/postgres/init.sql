-- Local/CI bootstrap only. Business tables and RLS policies are owned by implement/03
-- and are intentionally not created here.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

CREATE SCHEMA IF NOT EXISTS agentos;

-- Session variable is set per transaction (SET LOCAL) so transaction-pooled
-- connections cannot leak a tenant into the next checkout.
CREATE OR REPLACE FUNCTION agentos.current_tenant_id()
RETURNS UUID AS $$
BEGIN
  RETURN NULLIF(current_setting('app.current_tenant_id', true), '')::UUID;
END;
$$ LANGUAGE plpgsql STABLE;
