-- Keep the uuid-ossp helpers in the public schema.
-- 0000 installs extensions after setting search_path to agentos, while the
-- provisioning function in 0012 intentionally calls the extension-qualified
-- public helpers. Existing Compose databases already install the extension in
-- public; this makes a clean migration replay equivalent.
DO $$
DECLARE
  extension_schema TEXT;
BEGIN
  SELECT n.nspname
    INTO extension_schema
    FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'uuid-ossp';

  IF extension_schema IS NULL THEN
    RAISE EXCEPTION 'uuid-ossp extension is required for tenant provisioning';
  END IF;

  IF extension_schema <> 'public' THEN
    EXECUTE 'ALTER EXTENSION "uuid-ossp" SET SCHEMA public';
  END IF;
END
$$;
