#!/bin/bash
# Creates least-privilege roles from container env. Refuses to run outside local/CI.
set -euo pipefail

: "${APP_ROLE_PASSWORD:?APP_ROLE_PASSWORD is required}"
: "${MIGRATOR_ROLE_PASSWORD:?MIGRATOR_ROLE_PASSWORD is required}"
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"

profile="${POSTGRES_ENV:-local}"
case "${profile}" in
  local|ci) ;;
  *)
    echo "FATAL: postgres role bootstrap refused for POSTGRES_ENV=${profile}; this image path is local/CI only" >&2
    exit 1
    ;;
esac

sql_quote() {
  printf "%s" "$1" | sed "s/'/''/g"
}

app_password="$(sql_quote "${APP_ROLE_PASSWORD}")"
migrator_password="$(sql_quote "${MIGRATOR_ROLE_PASSWORD}")"

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app') THEN
    CREATE ROLE agentos_app WITH LOGIN PASSWORD '${app_password}' NOBYPASSRLS;
  ELSE
    ALTER ROLE agentos_app WITH LOGIN PASSWORD '${app_password}' NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'agentos_migrator') THEN
    CREATE ROLE agentos_migrator WITH LOGIN PASSWORD '${migrator_password}' BYPASSRLS;
  ELSE
    ALTER ROLE agentos_migrator WITH LOGIN PASSWORD '${migrator_password}' BYPASSRLS;
  END IF;
END
\$\$;

GRANT USAGE ON SCHEMA agentos TO agentos_app;
GRANT ALL PRIVILEGES ON SCHEMA agentos TO agentos_migrator;
ALTER DEFAULT PRIVILEGES IN SCHEMA agentos GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO agentos_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA agentos GRANT USAGE, SELECT ON SEQUENCES TO agentos_app;
SQL
