-- Re-issue application defaults for objects created by the migration owner.
-- Existing migrations are immutable; this repair is intentionally additive.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_migrator')
     AND EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app') THEN
    ALTER DEFAULT PRIVILEGES FOR ROLE agentos_migrator IN SCHEMA agentos
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agentos_app;
    ALTER DEFAULT PRIVILEGES FOR ROLE agentos_migrator IN SCHEMA agentos
      GRANT USAGE, SELECT ON SEQUENCES TO agentos_app;
  END IF;
END
$$;
