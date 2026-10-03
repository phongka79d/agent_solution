-- Persist platform authority separately from company authority in the identity membership model.
-- Invitations retain their scope all the way through redemption; the raw token remains digest-only.

ALTER TABLE agentos.tenant_memberships
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'company';
ALTER TABLE agentos.tenant_memberships
  DROP CONSTRAINT tenant_memberships_role_bundle_check;
ALTER TABLE agentos.tenant_memberships
  ADD CONSTRAINT ck_tenant_memberships_scope_role CHECK (
    (scope = 'company' AND role_bundle IN ('COMPANY_ADMIN', 'OPERATOR', 'VIEWER'))
    OR (scope = 'platform' AND role_bundle = 'PLATFORM_ADMIN')
  );
ALTER TABLE agentos.tenant_memberships
  DROP CONSTRAINT tenant_memberships_pkey;
ALTER TABLE agentos.tenant_memberships
  ADD CONSTRAINT pk_tenant_memberships PRIMARY KEY (tenant_id, user_id, scope);
CREATE INDEX tenant_memberships_platform_user_idx
  ON agentos.tenant_memberships (user_id, created_at)
  WHERE scope = 'platform';

ALTER TABLE agentos.invitations
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'company';
ALTER TABLE agentos.invitations
  DROP CONSTRAINT invitations_role_bundle_check;
ALTER TABLE agentos.invitations
  ADD CONSTRAINT ck_invitations_scope_role CHECK (
    (scope = 'company' AND role_bundle IN ('COMPANY_ADMIN', 'OPERATOR', 'VIEWER'))
    OR (scope = 'platform' AND role_bundle = 'PLATFORM_ADMIN')
  );
CREATE INDEX invitations_platform_pending_email_idx
  ON agentos.invitations (email, created_at DESC)
  WHERE scope = 'platform' AND consumed_at IS NULL;

DROP FUNCTION agentos.auth_find_active_memberships(UUID);
CREATE FUNCTION agentos.auth_find_active_memberships(p_user_id UUID)
RETURNS TABLE (tenant_id UUID, role_bundle TEXT, scope TEXT)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT m.tenant_id, m.role_bundle, m.scope
    FROM agentos.tenant_memberships AS m
   WHERE m.user_id = p_user_id AND m.status = 'ACTIVE'
   ORDER BY m.created_at, m.tenant_id, m.scope
$$;
REVOKE ALL ON FUNCTION agentos.auth_find_active_memberships(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agentos.auth_find_active_memberships(UUID) TO agentos_auth;

DROP FUNCTION agentos.auth_create_invitation(UUID, TEXT, TEXT, TEXT, UUID, TIMESTAMPTZ);
CREATE FUNCTION agentos.auth_create_invitation(
  p_tenant_id UUID,
  p_email TEXT,
  p_role_bundle TEXT,
  p_scope TEXT,
  p_token_hash TEXT,
  p_created_by UUID,
  p_expires_at TIMESTAMPTZ
)
RETURNS TABLE (invitation_id UUID, expires_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_email TEXT := pg_catalog.lower(pg_catalog.btrim(p_email));
  v_now TIMESTAMPTZ := clock_timestamp();
  v_id UUID;
BEGIN
  IF p_tenant_id IS NULL OR p_created_by IS NULL
     OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR v_email IS NULL OR v_email = ''
     OR p_scope NOT IN ('company', 'platform')
     OR (p_scope = 'company' AND p_role_bundle NOT IN ('COMPANY_ADMIN', 'OPERATOR', 'VIEWER'))
     OR (p_scope = 'platform' AND p_role_bundle <> 'PLATFORM_ADMIN')
     OR p_expires_at IS NULL OR p_expires_at <= v_now
     OR p_expires_at > v_now + INTERVAL '72 hours' THEN
    RAISE EXCEPTION 'auth_invitation_parameters_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM agentos.tenants AS t WHERE t.tenant_id = p_tenant_id)
     OR NOT EXISTS (SELECT 1 FROM agentos.users AS u WHERE u.user_id = p_created_by) THEN
    RETURN;
  END IF;

  UPDATE agentos.invitations AS i
     SET consumed_at = v_now
   WHERE i.scope = p_scope AND i.email = v_email AND i.consumed_at IS NULL
     AND (p_scope = 'platform' OR i.tenant_id = p_tenant_id);
  INSERT INTO agentos.invitations AS created (tenant_id, email, token_hash, role_bundle, scope, created_by, created_at, expires_at)
  VALUES (p_tenant_id, v_email, p_token_hash, p_role_bundle, p_scope, p_created_by, v_now, p_expires_at)
  -- Qualified: the OUT column invitation_id would otherwise make the reference ambiguous.
  RETURNING created.invitation_id INTO v_id;
  RETURN QUERY SELECT v_id, p_expires_at;
END
$$;
REVOKE ALL ON FUNCTION agentos.auth_create_invitation(UUID, TEXT, TEXT, TEXT, TEXT, UUID, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agentos.auth_create_invitation(UUID, TEXT, TEXT, TEXT, TEXT, UUID, TIMESTAMPTZ) TO agentos_auth;

DROP FUNCTION agentos.auth_accept_invitation(TEXT, TEXT, TEXT);
CREATE FUNCTION agentos.auth_accept_invitation(
  p_token_hash TEXT,
  p_password_hash TEXT,
  p_display_name TEXT DEFAULT NULL
)
RETURNS TABLE (user_id UUID, email TEXT, tenant_id UUID, role_bundle TEXT, scope TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_invitation agentos.invitations%ROWTYPE;
  v_user_id UUID;
  v_now TIMESTAMPTZ := clock_timestamp();
  v_display_name TEXT := NULLIF(pg_catalog.btrim(p_display_name), '');
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_password_hash IS NULL OR p_password_hash = '' THEN
    RETURN;
  END IF;
  SELECT i.* INTO v_invitation
    FROM agentos.invitations AS i
   WHERE i.token_hash = p_token_hash AND i.consumed_at IS NULL AND i.expires_at > v_now
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  SELECT u.user_id INTO v_user_id
    FROM agentos.users AS u WHERE u.email = v_invitation.email FOR UPDATE;
  IF NOT FOUND THEN
    INSERT INTO agentos.users (email, password_hash, password_changed_at, display_name)
    VALUES (v_invitation.email, p_password_hash, v_now, v_display_name)
    RETURNING users.user_id INTO v_user_id;
  ELSE
    UPDATE agentos.users AS u
       SET password_hash = p_password_hash,
           password_changed_at = v_now,
           updated_at = v_now,
           failed_login_attempts = 0,
           last_failed_login_at = NULL,
           locked_until = NULL,
           display_name = COALESCE(v_display_name, u.display_name)
     WHERE u.user_id = v_user_id;
    UPDATE agentos.auth_sessions AS s
       SET revoked_at = v_now
     WHERE s.user_id = v_user_id AND s.revoked_at IS NULL;
  END IF;

  INSERT INTO agentos.tenant_memberships (tenant_id, user_id, role_bundle, status, scope)
  VALUES (v_invitation.tenant_id, v_user_id, v_invitation.role_bundle, 'ACTIVE', v_invitation.scope)
  ON CONFLICT (tenant_id, user_id, scope)
  DO UPDATE SET role_bundle = EXCLUDED.role_bundle, status = 'ACTIVE', updated_at = v_now;

  UPDATE agentos.invitations AS i
     SET consumed_at = v_now
   WHERE i.tenant_id = v_invitation.tenant_id AND i.invitation_id = v_invitation.invitation_id
     AND i.consumed_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY SELECT v_user_id, v_invitation.email, v_invitation.tenant_id,
                      v_invitation.role_bundle, v_invitation.scope;
END
$$;
REVOKE ALL ON FUNCTION agentos.auth_accept_invitation(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agentos.auth_accept_invitation(TEXT, TEXT, TEXT) TO agentos_auth;

DROP FUNCTION agentos.auth_inspect_invitation(TEXT);
CREATE FUNCTION agentos.auth_inspect_invitation(p_token_hash TEXT)
RETURNS TABLE (email TEXT, tenant_id UUID, role_bundle TEXT, scope TEXT, expires_at TIMESTAMPTZ)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT i.email, i.tenant_id, i.role_bundle, i.scope, i.expires_at
    FROM agentos.invitations AS i
   WHERE p_token_hash ~ '^[0-9a-f]{64}$'
     AND i.token_hash = p_token_hash
     AND i.consumed_at IS NULL
     AND i.expires_at > clock_timestamp()
$$;
REVOKE ALL ON FUNCTION agentos.auth_inspect_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agentos.auth_inspect_invitation(TEXT) TO agentos_auth;

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
  SELECT m.user_id, u.email, u.display_name, m.role_bundle, m.status,
         latest_session.last_sign_in_at, m.created_at, m.updated_at
    FROM agentos.tenant_memberships AS m
    JOIN agentos.users AS u ON u.user_id = m.user_id
    LEFT JOIN LATERAL (
      SELECT pg_catalog.max(s.created_at) AS last_sign_in_at
        FROM agentos.auth_sessions AS s WHERE s.user_id = u.user_id
    ) AS latest_session ON TRUE
   WHERE m.tenant_id = p_tenant_id AND m.scope = 'company'
   ORDER BY m.created_at, m.user_id
$$;

CREATE OR REPLACE FUNCTION agentos.auth_update_membership(
  p_tenant_id UUID,
  p_user_id UUID,
  p_role_bundle TEXT,
  p_status TEXT
)
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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_tenant_id IS NULL OR p_user_id IS NULL
     OR (p_role_bundle IS NOT NULL AND p_role_bundle NOT IN ('COMPANY_ADMIN', 'OPERATOR', 'VIEWER'))
     OR (p_status IS NOT NULL AND p_status NOT IN ('INVITED', 'ACTIVE', 'DEACTIVATED')) THEN
    RAISE EXCEPTION 'auth_membership_parameters_invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE agentos.tenant_memberships AS m
     SET role_bundle = COALESCE(p_role_bundle, m.role_bundle),
         status = COALESCE(p_status, m.status),
         updated_at = v_now
   WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id AND m.scope = 'company';
  IF NOT FOUND THEN RETURN; END IF;
  IF p_status = 'DEACTIVATED' THEN
    UPDATE agentos.auth_sessions AS s
       SET revoked_at = v_now
     WHERE s.user_id = p_user_id AND s.revoked_at IS NULL;
  END IF;
  RETURN QUERY
  SELECT m.user_id, u.email, u.display_name, m.role_bundle, m.status,
         latest_session.last_sign_in_at, m.created_at, m.updated_at
    FROM agentos.tenant_memberships AS m
    JOIN agentos.users AS u ON u.user_id = m.user_id
    LEFT JOIN LATERAL (
      SELECT pg_catalog.max(s.created_at) AS last_sign_in_at
        FROM agentos.auth_sessions AS s WHERE s.user_id = u.user_id
    ) AS latest_session ON TRUE
   WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id AND m.scope = 'company';
END
$$;

CREATE FUNCTION agentos.auth_list_platform_admins()
RETURNS TABLE (
  user_id UUID,
  email TEXT,
  display_name TEXT,
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
           i.email, i.created_at, i.tenant_id
      FROM agentos.invitations AS i
     WHERE i.scope = 'platform' AND i.consumed_at IS NULL AND i.expires_at > clock_timestamp()
     ORDER BY i.email, i.created_at DESC, i.invitation_id DESC
  ), members AS (
    SELECT m.user_id, u.email, u.display_name,
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
     WHERE m.scope = 'platform'
  ), invitees AS (
    SELECT NULL::UUID AS user_id, p.email, NULL::TEXT AS display_name, 'INVITED'::TEXT AS status,
           NULL::TIMESTAMPTZ AS last_sign_in_at, p.created_at, p.created_at AS updated_at
      FROM pending AS p
     WHERE NOT EXISTS (SELECT 1 FROM members AS m WHERE m.email = p.email)
  )
  SELECT * FROM members
  UNION ALL
  SELECT * FROM invitees
  ORDER BY created_at, email
$$;
REVOKE ALL ON FUNCTION agentos.auth_list_platform_admins() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agentos.auth_list_platform_admins() TO agentos_auth;

CREATE OR REPLACE FUNCTION agentos.auth_consume_invitation(p_token_hash TEXT, p_user_id UUID)
RETURNS TABLE (tenant_id UUID, role_bundle TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  v_invitation agentos.invitations%ROWTYPE;
  v_email TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  SELECT u.email INTO v_email FROM agentos.users AS u WHERE u.user_id = p_user_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT i.* INTO v_invitation FROM agentos.invitations AS i
   WHERE i.token_hash = p_token_hash AND i.scope = 'company' AND i.consumed_at IS NULL
     AND i.expires_at > v_now AND i.email = v_email
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE agentos.invitations AS i SET consumed_at = v_now
   WHERE i.tenant_id = v_invitation.tenant_id AND i.invitation_id = v_invitation.invitation_id
     AND i.consumed_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO agentos.tenant_memberships (tenant_id, user_id, role_bundle, status, scope)
  VALUES (v_invitation.tenant_id, p_user_id, v_invitation.role_bundle, 'ACTIVE', 'company')
  ON CONFLICT (tenant_id, user_id, scope)
  DO UPDATE SET role_bundle = EXCLUDED.role_bundle, status = 'ACTIVE', updated_at = v_now;
  RETURN QUERY SELECT v_invitation.tenant_id, v_invitation.role_bundle;
END
$$;

REVOKE ALL ON FUNCTION agentos.auth_list_tenant_members(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.auth_update_membership(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agentos.auth_list_tenant_members(UUID) TO agentos_auth;
GRANT EXECUTE ON FUNCTION agentos.auth_update_membership(UUID, UUID, TEXT, TEXT) TO agentos_auth;
REVOKE ALL ON FUNCTION agentos.auth_consume_invitation(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agentos.auth_consume_invitation(TEXT, UUID) TO agentos_auth;
