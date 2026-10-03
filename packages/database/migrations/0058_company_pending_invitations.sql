-- T9.4 company user views include live invitations so operators can resend rather than lose sight
-- of them before acceptance. The invitation id occupies the existing user_id projection for rows
-- whose status is INVITED; auth_update_membership still only targets real company memberships.
CREATE OR REPLACE FUNCTION agentos.auth_list_tenant_members(p_tenant_id UUID)
RETURNS TABLE (
  user_id UUID,
  email TEXT,
  display_name TEXT,
  role_bundle TEXT,
  status TEXT,
  last_sign_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  WITH pending AS (
    SELECT DISTINCT ON (i.email)
           i.invitation_id AS user_id, i.email, i.role_bundle, i.created_at
      FROM agentos.invitations AS i
     WHERE i.tenant_id = p_tenant_id AND i.scope = 'company'
       AND i.consumed_at IS NULL AND i.expires_at > clock_timestamp()
     ORDER BY i.email, i.created_at DESC, i.invitation_id DESC
  ), members AS (
    SELECT m.user_id, u.email, u.display_name,
           COALESCE(p.role_bundle, m.role_bundle) AS role_bundle,
           CASE WHEN p.email IS NULL THEN m.status ELSE 'INVITED' END AS status,
           latest_session.last_sign_in_at,
           COALESCE(p.created_at, m.created_at) AS created_at,
           CASE WHEN p.email IS NULL THEN m.updated_at ELSE p.created_at END AS updated_at
      FROM agentos.tenant_memberships AS m
      JOIN agentos.users AS u ON u.user_id = m.user_id
      LEFT JOIN pending AS p ON p.email = u.email
      LEFT JOIN LATERAL (
        SELECT pg_catalog.max(s.created_at) AS last_sign_in_at
          FROM agentos.auth_sessions AS s WHERE s.user_id = u.user_id
      ) AS latest_session ON TRUE
     WHERE m.tenant_id = p_tenant_id AND m.scope = 'company'
  ), invitees AS (
    SELECT p.user_id, p.email, NULL::TEXT AS display_name, p.role_bundle,
           'INVITED'::TEXT AS status, NULL::TIMESTAMPTZ AS last_sign_in_at,
           p.created_at, p.created_at AS updated_at
      FROM pending AS p
     WHERE NOT EXISTS (SELECT 1 FROM members AS m WHERE m.email = p.email)
  )
  SELECT * FROM members
  UNION ALL
  SELECT * FROM invitees
  ORDER BY created_at, user_id
$$;
REVOKE ALL ON FUNCTION agentos.auth_list_tenant_members(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agentos.auth_list_tenant_members(UUID) TO agentos_auth;
