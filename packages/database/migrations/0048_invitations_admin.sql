-- Invitation issuance and tenant user administration (T9.3, workflow §4 "Company Admin first login").
--
-- Migration 0041 created the identity tables and the sign-in/session function surface; 0044 added
-- ACTIVE membership resolution and password rotation. This migration adds the *admin-side* surface:
-- issuing a single-use invitation for a company, accepting it (which creates or unlocks the user and
-- activates the membership), listing a company's members, changing a member's bundle, and
-- deactivating a member — deactivation revokes every live session for that user.
--
-- Invitations keep only the SHA-256 hash of the token; the raw token exists only in the delivery
-- channel and is never stored or logged. Every function stays behind the dedicated `agentos_auth`
-- login role; the tables themselves remain inaccessible to ordinary application queries.

CREATE FUNCTION agentos.auth_create_invitation(
  p_tenant_id UUID,
  p_email TEXT,
  p_role_bundle TEXT,
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
     OR p_role_bundle IS NULL OR p_role_bundle NOT IN ('COMPANY_ADMIN', 'OPERATOR', 'VIEWER')
     OR p_expires_at IS NULL
     OR p_expires_at <= v_now
     OR p_expires_at > v_now + INTERVAL '72 hours' THEN
    RAISE EXCEPTION 'auth_invitation_parameters_invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM agentos.tenants AS t WHERE t.tenant_id = p_tenant_id) THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM agentos.users AS u WHERE u.user_id = p_created_by) THEN
    RETURN;
  END IF;
  -- A fresh invitation supersedes any still-pending invitation for the same address and company, so
  -- only the newest link can activate the membership and an old resend cannot be replayed.
  UPDATE agentos.invitations AS i
     SET consumed_at = v_now
   WHERE i.tenant_id = p_tenant_id AND i.email = v_email AND i.consumed_at IS NULL;
  INSERT INTO agentos.invitations (tenant_id, email, token_hash, role_bundle, created_by, created_at, expires_at)
  VALUES (p_tenant_id, v_email, p_token_hash, p_role_bundle, p_created_by, v_now, p_expires_at)
  RETURNING invitation_id INTO v_id;
  RETURN QUERY SELECT v_id, p_expires_at;
END
$$;

-- Redeeming an invitation creates the user when the address is new, otherwise it resets that user's
-- password (revoking their previous sessions) and re-activates the membership. Consumption and the
-- membership activation happen in one transaction under the invitation row lock, so two concurrent
-- redemptions of the same token cannot both succeed.
CREATE FUNCTION agentos.auth_accept_invitation(p_token_hash TEXT, p_password_hash TEXT)
RETURNS TABLE (user_id UUID, email TEXT, tenant_id UUID, role_bundle TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_invitation agentos.invitations%ROWTYPE;
  v_user_id UUID;
  v_now TIMESTAMPTZ := clock_timestamp();
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
    INSERT INTO agentos.users (email, password_hash, password_changed_at)
    VALUES (v_invitation.email, p_password_hash, v_now)
    RETURNING users.user_id INTO v_user_id;
  ELSE
    UPDATE agentos.users AS u
       SET password_hash = p_password_hash,
           password_changed_at = v_now,
           updated_at = v_now,
           failed_login_attempts = 0,
           last_failed_login_at = NULL,
           locked_until = NULL
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

-- Tells the accept page whether a link is still usable, without consuming it. Returns only the
-- address and company the invitation targets.
CREATE FUNCTION agentos.auth_inspect_invitation(p_token_hash TEXT)
RETURNS TABLE (email TEXT, tenant_id UUID, role_bundle TEXT, expires_at TIMESTAMPTZ)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT i.email, i.tenant_id, i.role_bundle, i.expires_at
    FROM agentos.invitations AS i
   WHERE p_token_hash ~ '^[0-9a-f]{64}$'
     AND i.token_hash = p_token_hash
     AND i.consumed_at IS NULL
     AND i.expires_at > clock_timestamp()
$$;

-- The company-admin user list. The company is taken from the authenticated principal, never from a
-- request parameter, and the join to `users` is the one read that exposes a member's address.
CREATE FUNCTION agentos.auth_list_tenant_members(p_tenant_id UUID)
RETURNS TABLE (
  user_id UUID,
  email TEXT,
  role_bundle TEXT,
  status TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT m.user_id, u.email, m.role_bundle, m.status, m.created_at, m.updated_at
    FROM agentos.tenant_memberships AS m
    JOIN agentos.users AS u ON u.user_id = m.user_id
   WHERE m.tenant_id = p_tenant_id
   ORDER BY m.created_at, m.user_id
$$;

-- Change a member's bundle and/or status. Deactivating revokes every live session the user holds,
-- so a deactivated operator cannot keep using a token issued before the change.
CREATE FUNCTION agentos.auth_update_membership(
  p_tenant_id UUID,
  p_user_id UUID,
  p_role_bundle TEXT,
  p_status TEXT
)
RETURNS TABLE (
  user_id UUID,
  email TEXT,
  role_bundle TEXT,
  status TEXT,
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
  SELECT m.user_id, u.email, m.role_bundle, m.status, m.created_at, m.updated_at
    FROM agentos.tenant_memberships AS m
    JOIN agentos.users AS u ON u.user_id = m.user_id
   WHERE m.tenant_id = p_tenant_id AND m.user_id = p_user_id;
END
$$;

REVOKE ALL ON FUNCTION agentos.auth_create_invitation(UUID, TEXT, TEXT, TEXT, UUID, TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.auth_accept_invitation(TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.auth_inspect_invitation(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.auth_list_tenant_members(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.auth_update_membership(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agentos.auth_create_invitation(UUID, TEXT, TEXT, TEXT, UUID, TIMESTAMPTZ) TO agentos_auth;
GRANT EXECUTE ON FUNCTION agentos.auth_accept_invitation(TEXT, TEXT) TO agentos_auth;
GRANT EXECUTE ON FUNCTION agentos.auth_inspect_invitation(TEXT) TO agentos_auth;
GRANT EXECUTE ON FUNCTION agentos.auth_list_tenant_members(UUID) TO agentos_auth;
GRANT EXECUTE ON FUNCTION agentos.auth_update_membership(UUID, UUID, TEXT, TEXT) TO agentos_auth;
