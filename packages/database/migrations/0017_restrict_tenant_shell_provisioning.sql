-- Tenant-shell provisioning is a platform control-plane operation.
-- Keep every overload unreachable to the tenant application role unless it explicitly
-- switches to the non-inheriting platform role inside a transaction.
DO $$
DECLARE
  provision_function record;
BEGIN
  FOR provision_function IN
    SELECT n.nspname AS schema_name,
           p.proname AS function_name,
           pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments
      FROM pg_catalog.pg_proc AS p
      JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
     WHERE n.nspname = 'agentos'
       AND p.proname LIKE 'provision_tenant_shell%'
       AND p.prokind = 'f'
  LOOP
    EXECUTE format(
      'REVOKE EXECUTE ON FUNCTION %I.%I(%s) FROM PUBLIC, agentos_app',
      provision_function.schema_name,
      provision_function.function_name,
      provision_function.arguments
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %I.%I(%s) TO agentos_platform',
      provision_function.schema_name,
      provision_function.function_name,
      provision_function.arguments
    );
  END LOOP;
END
$$;
