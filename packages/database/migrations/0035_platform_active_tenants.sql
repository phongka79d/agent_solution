-- Worker tenant discovery is a fixed, domain-only platform projection.
CREATE OR REPLACE FUNCTION agentos.platform_active_tenants()
RETURNS TABLE (
  tenant_id UUID,
  enabled_domains TEXT[]
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT
    t.tenant_id,
    ARRAY_AGG(
      CASE c.capability_id
        WHEN 'care' THEN 'support'
        WHEN 'sales' THEN 'sales'
        WHEN 'marketing' THEN 'marketing'
      END
      ORDER BY c.capability_id
    ) FILTER (WHERE c.capability_id IN ('care', 'sales', 'marketing')) AS enabled_domains
  FROM agentos.tenants AS t
  JOIN agentos.tenant_capabilities AS c ON c.tenant_id = t.tenant_id
  WHERE t.status NOT IN ('SUSPENDED', 'ARCHIVED')
    AND c.status = 'ENABLED'
    AND c.capability_id IN ('care', 'sales', 'marketing')
  GROUP BY t.tenant_id
  ORDER BY t.tenant_id
$$;

REVOKE ALL ON FUNCTION agentos.platform_active_tenants() FROM PUBLIC;
GRANT USAGE ON SCHEMA agentos TO agentos_platform;
GRANT EXECUTE ON FUNCTION agentos.platform_active_tenants() TO agentos_platform, agentos_app;
