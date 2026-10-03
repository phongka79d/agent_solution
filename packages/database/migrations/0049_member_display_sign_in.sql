-- T9.4 company member projections: a name the invitee may provide and the latest recorded sign-in.
-- Identity sessions are user-scoped (not tenant-scoped); this is therefore the latest sign-in session
-- for each member user, projected alongside the tenant membership being listed.
ALTER TABLE agentos.users ADD COLUMN display_name TEXT;

-- Adding columns to a table-returning function requires dropping its prior composite signature.
DROP FUNCTION agentos.auth_list_tenant_members(UUID);
CREATE FUNCTION agentos.auth_list_tenant_members(p_tenant_id UUID)
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
        FROM agentos.auth_sessions AS s
       WHERE s.user_id = u.user_id
    ) AS latest_session ON TRUE
   WHERE m.tenant_id = p_tenant_id
   ORDER BY m.created_at, m.user_id
$$;
REVOKE ALL ON FUNCTION agentos.auth_list_tenant_members(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agentos.auth_list_tenant_members(UUID) TO agentos_auth;

-- Keep role/status updates returning the same complete member projection as list operations.
DROP FUNCTION agentos.auth_update_membership(UUID, UUID, TEXT, TEXT);
CREATE FUNCTION agentos.auth_update_membership(
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
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_tenant_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'auth_membership_parameters_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_role_bundle IS NOT NULL AND p_role_bundle NOT IN ('COMPANY_ADMIN', 'OPERATOR', 'VIEWER') THEN
    RAISE EXCEPTION 'auth_membership_parameters_invalid' USING ERRCODE = '22023';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('INVITED', 'ACTIVE', 'DEACTIVATED') THEN
    RAISE EXCEPTION 'auth_membership_parameters_invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE agentos.tenant_memberships AS m
     SET role_bundle = COALESCE(p_role_bundle, m.role_bundle),
         status = COALESCE(p_status, m.status),
         updated_at = v_now
   WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
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
        FROM agentos.auth_sessions AS s
       WHERE s.user_id = u.user_id
    ) AS latest_session ON TRUE
   WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id;
END
$$;
REVOKE ALL ON FUNCTION agentos.auth_update_membership(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agentos.auth_update_membership(UUID, UUID, TEXT, TEXT) TO agentos_auth;

-- An invitee may optionally provide a display name while creating/resetting their credentials.
DROP FUNCTION agentos.auth_accept_invitation(TEXT, TEXT);
CREATE FUNCTION agentos.auth_accept_invitation(
  p_token_hash TEXT,
  p_password_hash TEXT,
  p_display_name TEXT DEFAULT NULL
)
RETURNS TABLE (user_id UUID, email TEXT, tenant_id UUID, role_bundle TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
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
  IF NOT FOUND THEN
    RETURN;
  END IF;

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

  INSERT INTO agentos.tenant_memberships (tenant_id, user_id, role_bundle, status)
  VALUES (v_invitation.tenant_id, v_user_id, v_invitation.role_bundle, 'ACTIVE')
  ON CONFLICT (tenant_id, user_id)
  DO UPDATE SET role_bundle = EXCLUDED.role_bundle, status = 'ACTIVE', updated_at = v_now;

  UPDATE agentos.invitations AS i
     SET consumed_at = v_now
   WHERE i.tenant_id = v_invitation.tenant_id AND i.invitation_id = v_invitation.invitation_id
     AND i.consumed_at IS NULL;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT v_user_id, v_invitation.email, v_invitation.tenant_id, v_invitation.role_bundle;
END
$$;
REVOKE ALL ON FUNCTION agentos.auth_accept_invitation(TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agentos.auth_accept_invitation(TEXT, TEXT, TEXT) TO agentos_auth;
