-- Durable user identity, tenant memberships, persistent sessions, and single-use invitations.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname = current_user AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'identity_migration_owner_must_bypass_rls' USING ERRCODE = '42501';
  END IF;
END
$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_auth') THEN
    CREATE ROLE agentos_auth NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;
ALTER ROLE agentos_auth NOLOGIN NOBYPASSRLS;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app') THEN
    EXECUTE 'GRANT agentos_auth TO agentos_app WITH INHERIT FALSE';
  END IF;
END
$$;

CREATE TABLE agentos.users (
  user_id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
  email TEXT NOT NULL CHECK (email <> '' AND email = pg_catalog.lower(pg_catalog.btrim(email))),
  password_hash TEXT NOT NULL CHECK (password_hash <> ''),
  failed_login_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_login_attempts >= 0),
  last_failed_login_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  password_changed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX users_email_lower_uq ON agentos.users (pg_catalog.lower(email));
ALTER TABLE agentos.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.users FORCE ROW LEVEL SECURITY;
-- Deliberately no policy: users are global and inaccessible through ordinary table queries.

CREATE TABLE agentos.tenant_memberships (
  tenant_id UUID NOT NULL REFERENCES agentos.tenants (tenant_id) ON DELETE RESTRICT,
  user_id UUID NOT NULL REFERENCES agentos.users (user_id) ON DELETE RESTRICT,
  role_bundle TEXT NOT NULL CHECK (role_bundle IN ('COMPANY_ADMIN', 'OPERATOR', 'VIEWER')),
  status TEXT NOT NULL DEFAULT 'INVITED' CHECK (status IN ('INVITED', 'ACTIVE', 'DEACTIVATED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id)
);
SELECT agentos.apply_tenant_rls('agentos.tenant_memberships');

CREATE TABLE agentos.auth_sessions (
  session_id UUID PRIMARY KEY DEFAULT agentos.uuid_generate_v7(),
  user_id UUID NOT NULL REFERENCES agentos.users (user_id) ON DELETE RESTRICT,
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK (absolute_expires_at > created_at)
);
ALTER TABLE agentos.auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agentos.auth_sessions FORCE ROW LEVEL SECURITY;
-- Sessions are global and only accessible to the SECURITY DEFINER auth functions.

CREATE TABLE agentos.invitations (
  tenant_id UUID NOT NULL REFERENCES agentos.tenants (tenant_id) ON DELETE RESTRICT,
  invitation_id UUID NOT NULL DEFAULT agentos.uuid_generate_v7(),
  email TEXT NOT NULL CHECK (email <> '' AND email = pg_catalog.lower(pg_catalog.btrim(email))),
  token_hash CHAR(64) NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  role_bundle TEXT NOT NULL CHECK (role_bundle IN ('COMPANY_ADMIN', 'OPERATOR', 'VIEWER')),
  created_by UUID NOT NULL REFERENCES agentos.users (user_id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '72 hours'),
  consumed_at TIMESTAMPTZ,
  PRIMARY KEY (tenant_id, invitation_id),
  CHECK (expires_at > created_at AND expires_at <= created_at + INTERVAL '72 hours')
);
SELECT agentos.apply_tenant_rls('agentos.invitations');

CREATE INDEX auth_sessions_user_expiry_idx ON agentos.auth_sessions (user_id, absolute_expires_at);
CREATE INDEX invitations_pending_idx ON agentos.invitations (tenant_id, expires_at) WHERE consumed_at IS NULL;

CREATE FUNCTION agentos.auth_find_user_by_email(p_email TEXT)
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
   WHERE u.email = pg_catalog.lower(pg_catalog.btrim(p_email))
$$;

CREATE FUNCTION agentos.auth_create_session(
  p_user_id UUID,
  p_token_hash TEXT,
  p_idle_lifetime_seconds INTEGER,
  p_absolute_lifetime_seconds INTEGER
)
RETURNS TABLE (
  session_id UUID,
  user_id UUID,
  created_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  idle_expires_at TIMESTAMPTZ,
  absolute_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_user_id IS NULL OR p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_idle_lifetime_seconds IS NULL OR p_absolute_lifetime_seconds IS NULL
     OR p_idle_lifetime_seconds < 1 OR p_absolute_lifetime_seconds < p_idle_lifetime_seconds
     OR p_absolute_lifetime_seconds > 2592000 THEN
    RAISE EXCEPTION 'auth_session_parameters_invalid' USING ERRCODE = '22023';
  END IF;
  UPDATE agentos.users AS u
     SET failed_login_attempts = 0, last_failed_login_at = NULL, locked_until = NULL,
         updated_at = v_now
   WHERE u.user_id = p_user_id AND (u.locked_until IS NULL OR u.locked_until <= v_now);
  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN QUERY
  INSERT INTO agentos.auth_sessions AS s (
    user_id, token_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at
  ) VALUES (
    p_user_id, p_token_hash, v_now, v_now,
    v_now + pg_catalog.make_interval(secs => p_idle_lifetime_seconds),
    v_now + pg_catalog.make_interval(secs => p_absolute_lifetime_seconds)
  )
  RETURNING s.session_id, s.user_id, s.created_at, s.last_seen_at, s.idle_expires_at, s.absolute_expires_at;
END
$$;

CREATE FUNCTION agentos.auth_touch_session(p_token_hash TEXT, p_idle_lifetime_seconds INTEGER)
RETURNS TABLE (
  session_id UUID,
  user_id UUID,
  created_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  idle_expires_at TIMESTAMPTZ,
  absolute_expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$'
     OR p_idle_lifetime_seconds IS NULL OR p_idle_lifetime_seconds < 1 OR p_idle_lifetime_seconds > 2592000 THEN
    RAISE EXCEPTION 'auth_session_parameters_invalid' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
  UPDATE agentos.auth_sessions AS s
     SET last_seen_at = v_now,
         idle_expires_at = LEAST(v_now + pg_catalog.make_interval(secs => p_idle_lifetime_seconds), s.absolute_expires_at)
   WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL
     AND s.idle_expires_at > v_now AND s.absolute_expires_at > v_now
  RETURNING s.session_id, s.user_id, s.created_at, s.last_seen_at, s.idle_expires_at, s.absolute_expires_at;
END
$$;

CREATE FUNCTION agentos.auth_revoke_session(p_token_hash TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
BEGIN
  IF p_token_hash IS NULL OR p_token_hash !~ '^[0-9a-f]{64}$' THEN
    RETURN FALSE;
  END IF;
  UPDATE agentos.auth_sessions AS s SET revoked_at = clock_timestamp()
   WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL;
  RETURN FOUND;
END
$$;

CREATE FUNCTION agentos.auth_record_failed_login(p_user_id UUID)
RETURNS TABLE (failed_login_attempts INTEGER, locked_until TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_now TIMESTAMPTZ := clock_timestamp();
  v_attempts INTEGER;
  v_last_failed TIMESTAMPTZ;
  v_locked_until TIMESTAMPTZ;
BEGIN
  SELECT u.failed_login_attempts, u.last_failed_login_at, u.locked_until
    INTO v_attempts, v_last_failed, v_locked_until
    FROM agentos.users AS u WHERE u.user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_locked_until IS NOT NULL AND v_locked_until > v_now THEN
    RETURN QUERY SELECT v_attempts, v_locked_until;
    RETURN;
  END IF;
  IF v_last_failed IS NULL OR v_last_failed < v_now - INTERVAL '15 minutes' OR v_locked_until IS NOT NULL THEN
    v_attempts := 0;
  END IF;
  v_attempts := v_attempts + 1;
  v_locked_until := CASE WHEN v_attempts >= 5 THEN v_now + INTERVAL '15 minutes' ELSE NULL END;
  UPDATE agentos.users AS u
     SET failed_login_attempts = v_attempts, last_failed_login_at = v_now,
         locked_until = v_locked_until, updated_at = v_now
   WHERE u.user_id = p_user_id;
  RETURN QUERY SELECT v_attempts, v_locked_until;
END
$$;

CREATE FUNCTION agentos.auth_consume_invitation(p_token_hash TEXT, p_user_id UUID)
RETURNS TABLE (tenant_id UUID, role_bundle TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, agentos, pg_temp
AS $$
DECLARE
  v_invitation agentos.invitations%ROWTYPE;
  v_email TEXT;
  v_now TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF p_token_hash !~ '^[0-9a-f]{64}$' THEN RETURN; END IF;
  SELECT u.email INTO v_email FROM agentos.users AS u WHERE u.user_id = p_user_id;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT i.* INTO v_invitation FROM agentos.invitations AS i
   WHERE i.token_hash = p_token_hash AND i.consumed_at IS NULL AND i.expires_at > v_now
     AND i.email = v_email
   FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  UPDATE agentos.invitations AS i SET consumed_at = v_now
   WHERE i.tenant_id = v_invitation.tenant_id AND i.invitation_id = v_invitation.invitation_id
     AND i.consumed_at IS NULL;
  IF NOT FOUND THEN RETURN; END IF;
  INSERT INTO agentos.tenant_memberships (tenant_id, user_id, role_bundle, status)
  VALUES (v_invitation.tenant_id, p_user_id, v_invitation.role_bundle, 'ACTIVE');
  RETURN QUERY SELECT v_invitation.tenant_id, v_invitation.role_bundle;
END
$$;

-- Keep identity tables inaccessible to direct application queries; tenant memberships alone
-- have a tenant-bound read projection. Session, user, and invitation secrets are function-only.
REVOKE ALL ON agentos.users, agentos.auth_sessions, agentos.invitations FROM PUBLIC, agentos_app, agentos_platform, agentos_auth;
REVOKE ALL ON agentos.tenant_memberships FROM PUBLIC, agentos_app, agentos_platform, agentos_auth;
GRANT SELECT ON agentos.tenant_memberships TO agentos_app;
REVOKE ALL ON FUNCTION agentos.auth_find_user_by_email(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.auth_create_session(UUID, TEXT, INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.auth_touch_session(TEXT, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.auth_revoke_session(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.auth_record_failed_login(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION agentos.auth_consume_invitation(TEXT, UUID) FROM PUBLIC;
GRANT USAGE ON SCHEMA agentos TO agentos_auth;
GRANT EXECUTE ON FUNCTION agentos.auth_find_user_by_email(TEXT) TO agentos_auth;
GRANT EXECUTE ON FUNCTION agentos.auth_create_session(UUID, TEXT, INTEGER, INTEGER) TO agentos_auth;
GRANT EXECUTE ON FUNCTION agentos.auth_touch_session(TEXT, INTEGER) TO agentos_auth;
GRANT EXECUTE ON FUNCTION agentos.auth_revoke_session(TEXT) TO agentos_auth;
GRANT EXECUTE ON FUNCTION agentos.auth_record_failed_login(UUID) TO agentos_auth;
GRANT EXECUTE ON FUNCTION agentos.auth_consume_invitation(TEXT, UUID) TO agentos_auth;
