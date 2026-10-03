DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles
    WHERE rolname = current_user
      AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'schema_ledger_reader_owner_must_bypass_rls'
      USING ERRCODE = '42501';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION agentos.schema_applied_migrations()
RETURNS TABLE (filename TEXT)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT ledger.filename
  FROM agentos_meta.schema_migrations AS ledger
$$;

REVOKE ALL ON FUNCTION agentos.schema_applied_migrations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agentos.schema_applied_migrations() TO agentos_app;
