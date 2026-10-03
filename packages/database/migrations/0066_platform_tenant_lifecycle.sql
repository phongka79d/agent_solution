-- Platform lifecycle writes use the dedicated platform login, never application-role table grants.
-- Match the explicit tenant context established by the authorized command repository.
CREATE OR REPLACE FUNCTION agentos.platform_set_tenant_status(p_tenant UUID, p_status TEXT)
RETURNS TABLE (tenant_id UUID, status TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
BEGIN
  IF p_tenant IS NULL OR p_status IS NULL OR p_status NOT IN ('SUSPENDED', 'ACTIVE') THEN
    RAISE EXCEPTION 'PLATFORM_TENANT_STATUS_INVALID' USING ERRCODE = '22023';
  END IF;
  IF pg_catalog.current_setting('app.current_tenant_id', TRUE) IS DISTINCT FROM p_tenant::text THEN
    RAISE EXCEPTION 'platform tenant lifecycle context mismatch' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  UPDATE agentos.tenants AS target
  SET status = p_status
  WHERE target.tenant_id = p_tenant
  RETURNING target.tenant_id, target.status;
END
$$;
REVOKE ALL ON FUNCTION agentos.platform_set_tenant_status(UUID, TEXT) FROM PUBLIC, agentos_app;
GRANT EXECUTE ON FUNCTION agentos.platform_set_tenant_status(UUID, TEXT) TO agentos_platform;
