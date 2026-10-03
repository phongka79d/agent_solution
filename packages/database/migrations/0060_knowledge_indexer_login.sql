-- Dedicated connection identity for the knowledge indexer capability.
-- The login password is provisioned by bootstrap/rehearsal from INDEXER_ROLE_PASSWORD.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_indexer_login') THEN
    CREATE ROLE agentos_indexer_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE agentos_indexer_login WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- The login can SET ROLE to the narrowly granted indexer capability, but cannot inherit it.
GRANT agentos_indexer TO agentos_indexer_login WITH INHERIT FALSE;
