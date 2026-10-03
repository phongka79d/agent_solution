-- Dedicated connection identity for platform-only database work.
-- Passwords are provisioned from PLATFORM_ROLE_PASSWORD by bootstrap; never embed credentials here.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform') THEN
    CREATE ROLE agentos_platform NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform_login') THEN
    CREATE ROLE agentos_platform_login LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

ALTER ROLE agentos_platform WITH NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE agentos_platform_login WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- The login can SET ROLE to the capability role, but it cannot inherit its grants.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform_login')
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform') THEN
    EXECUTE 'GRANT agentos_platform TO agentos_platform_login WITH INHERIT FALSE';
  END IF;

  -- Retire the old escalation path. Guard absent roles for partial/legacy databases.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app')
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform') THEN
    EXECUTE 'REVOKE agentos_platform FROM agentos_app';
  END IF;
END
$$;
