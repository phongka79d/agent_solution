-- Session-bound security operations for the durable identity model (T9.2):
-- resolving a user's ACTIVE memberships at sign-in and rotating a password.
-- Both live behind the dedicated `agentos_auth` login role like every other identity function.

CREATE FUNCTION agentos.auth_find_active_memberships(p_user_id UUID)
RETURNS TABLE (
  tenant_id UUID,
  role_bundle TEXT
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT m.tenant_id, m.role_bundle
    FROM agentos.tenant_memberships AS m
   WHERE m.user_id = p_user_id
     AND m.status = 'ACTIVE'
   ORDER BY m.created_at, m.tenant_id
$$;

CREATE FUNCTION agentos.auth_find_user_by_id(p_user_id UUID)
RETURNS TABLE (
  user_id UUID,
  email TEXT,
  password_hash TEXT,
  failed_login_attempts INTEGER,
  locked_until TIMESTAMPTZ
)
LANGUAGE SQL
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
  SELECT u.user_id, u.email, u.password_hash, u.failed_login_attempts, u.locked_until
    FROM agentos.users AS u
   WHERE u.user_id = p_user_id
$$;

-- Rotating a password clears the lockout counters and revokes every live session for the user, so a
-- credential recovered after a compromise cannot leave an attacker's session alive.
CREATE FUNCTION agentos.auth_update_password(p_user_id UUID, p_password_hash TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_user_id IS NULL OR p_password_hash IS NULL OR p_password_hash = '' THEN
    RAISE EXCEPTION 'auth_password_parameters_invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE agentos.users AS u
     SET password_hash = p_password_hash,
         password_changed_at = v_now,
         updated_at = v_now,
         failed_login_attempts = 0,
         last_failed_login_at = NULL,
         locked_until = NULL
   WHERE u.user_id = p_user_id;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  UPDATE agentos.auth_sessions AS s
     SET revoked_at = v_now
   WHERE s.user_id = p_user_id AND s.revoked_at IS NULL;
  RETURN TRUE;
END
$$;

REVOKE ALL ON FUNCTION agentos.auth_find_user_by_email(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.auth_find_user_by_id(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.auth_find_active_memberships(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.auth_update_password(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agentos.auth_find_user_by_email(TEXT) TO agentos_auth;
GRANT EXECUTE ON FUNCTION agentos.auth_find_user_by_id(UUID) TO agentos_auth;
GRANT EXECUTE ON FUNCTION agentos.auth_update_password(UUID, TEXT) TO agentos_auth;
