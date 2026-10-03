#!/usr/bin/env node
/**
 * Migration rehearsal for `packages/database`.
 *
 * Applies `migrations/*.sql` to the database named by `DATABASE_URL` and records each file's
 * sha256 in `agentos_meta.schema_migrations` inside the SAME transaction as that file's DDL, so
 * a partially applied migration can never be described as applied. A file is skipped only when
 * the ledger already holds its exact checksum; a mismatch (or any SQL failure) exits 1 and
 * rewrites nothing, leaving the drift for an operator to reconcile.
 *
 * Transaction boundaries:
 *   1. `0000_agentos_schema.sql` + `0001_tenant_scoped_fks.sql` - 0001 upgrades the foreign keys
 *      0000 declares, so the two commit or roll back together.
 *   2. `0002_rls_policies.sql` - RLS, roles, and grants run once every table exists.
 * Any further migration file applies after those, one transaction per file.
 *
 * File bodies are sent as a single simple (non-parameterized) query: they hold many statements
 * and dollar-quoted function bodies, which the extended protocol cannot carry. Success is
 * asserted against the catalog afterwards, so an empty or unauthorized schema can never exit 0.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from 'pg';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

const LEDGER_SCHEMA = 'agentos_meta';
const LEDGER_TABLE = 'schema_migrations';
const LEDGER = `${LEDGER_SCHEMA}.${LEDGER_TABLE}`;
const SEARCH_PATH = 'agentos, public';

/** Migrations that must share a transaction, in execution order. */
const TRANSACTION_GROUPS = [
  ['0000_agentos_schema.sql', '0001_tenant_scoped_fks.sql'],
  ['0002_rls_policies.sql'],
];

/** Agentos functions that migrations and boot checks require to exist. */
const REQUIRED_FUNCTIONS = [
  'uuid_generate_v7',
  'prevent_immutable_table_modification',
  'current_tenant_id',
  'schema_applied_migrations',
  'platform_append_audit',
  'inherit_data_class',
  'reset_test_data',
  'auth_find_user_by_email',
  'auth_create_session',
  'auth_touch_session',
  'auth_revoke_session',
  'auth_record_failed_login',
  'auth_consume_invitation',
  'auth_find_active_memberships',
  'auth_find_user_by_id',
  'auth_update_password',
];
const REQUIRED_PUBLIC_FUNCTIONS = ['uuid_generate_v5', 'uuid_ns_url'];

const SCHEMA_FILE = '0000_agentos_schema.sql';

/**
 * Reads the connection string, or fails closed.
 *
 * @returns The trimmed `DATABASE_URL`.
 * @throws Error `DATABASE_URL_REQUIRED` when the variable is unset or blank.
 */
function loadConnectionString() {
  const connectionString = process.env.DATABASE_URL?.trim();

  if (!connectionString) {
    throw new Error(
      'DATABASE_URL_REQUIRED: set DATABASE_URL before rehearsing migrations. ' +
        'Refusing to report an empty or unauthorized schema as migrated.',
    );
  }

  return connectionString;
}

/**
 * Names the target database without ever echoing credentials.
 *
 * @param connectionString - The configured connection string.
 * @returns `host/database`, or a generic description when the URL cannot be parsed.
 */
function describeTarget(connectionString) {
  try {
    const { host, pathname } = new URL(connectionString);

    return `${host}${pathname}`;
  } catch {
    return 'the configured database';
  }
}

/**
 * Loads the PostgreSQL driver lazily, after configuration has been validated.
 *
 * @returns The `pg` Client constructor.
 * @throws Error `MIGRATION_DRIVER_UNAVAILABLE` when `pg` is not resolvable.
 */
async function loadDriver() {
  try {
    const { Client } = await import('pg');

    return Client;
  } catch {
    throw new Error(
      'MIGRATION_DRIVER_UNAVAILABLE: the `pg` driver is not resolvable from packages/database. ' +
        'Install the workspace dependencies before rehearsing migrations.',
    );
  }
}

/** @returns Every `migrations/*.sql` filename, lexicographic. */
function readMigrations() {
  return readdirSync(migrationsDirectory)
    .filter((entry) => entry.toLowerCase().endsWith('.sql'))
    .sort();
}

/**
 * Groups the discovered migrations into their transactions.
 *
 * @param files - Discovered migration filenames, lexicographic.
 * @returns One array of filenames per transaction, in execution order.
 * @throws Error `MIGRATION_FILE_MISSING` when a declared migration is absent.
 */
function migrationPlan(files) {
  const declared = TRANSACTION_GROUPS.flat();
  const missing = declared.filter((file) => !files.includes(file));

  if (missing.length > 0) {
    throw new Error(`MIGRATION_FILE_MISSING: ${missing.join(', ')} absent from migrations/.`);
  }

  const plan = TRANSACTION_GROUPS.map((group) => files.filter((file) => group.includes(file)));
  const grouped = new Set(declared);

  for (const file of files) {
    if (!grouped.has(file)) {
      plan.push([file]);
    }
  }

  return plan;
}

/** @returns The lowercase hex sha256 of a migration file's text. */
function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Creates the migration ledger. It lives in `agentos_meta`, never in `agentos`, so the RLS
 * sweep has no tenant_id to demand from it.
 *
 * @param client - Connected client inside the transaction.
 */
async function ensureLedger(client) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS ${LEDGER_SCHEMA}`);
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${LEDGER} (
       filename TEXT PRIMARY KEY,
       sha256 CHAR(64) NOT NULL,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
     )`,
  );
}

/**
 * Applies one migration and records it, inside the caller's transaction.
 *
 * @param client - Connected client inside the transaction.
 * @param filename - Migration filename relative to `migrations/`.
 * @throws Error `MIGRATION_CHECKSUM_MISMATCH` when the ledger disagrees with the file.
 */
async function applyMigration(client, filename) {
  const sql = readFileSync(join(migrationsDirectory, filename), 'utf8');
  const checksum = sha256(sql);
  const { rows } = await client.query(`SELECT sha256 FROM ${LEDGER} WHERE filename = $1`, [filename]);
  const recorded = rows[0]?.sha256?.trim();

  if (recorded !== undefined) {
    if (recorded !== checksum) {
      throw new Error(
        `MIGRATION_CHECKSUM_MISMATCH: ${filename} is recorded as ${recorded} but hashes to ${checksum}. ` +
          'The file changed after it was applied; reconcile the drift instead of rewriting applied history.',
      );
    }

    console.log(`skip   ${filename} (already applied, sha256 ${checksum})`);

    return;
  }

  await client.query(sql);
  await client.query(`INSERT INTO ${LEDGER} (filename, sha256) VALUES ($1, $2)`, [filename, checksum]);

  console.log(`apply  ${filename} (sha256 ${checksum})`);
}

/**
 * Extracts the table and view names a schema file declares.
 *
 * @param schemaSql - Contents of every discovered migration SQL file.
 * @returns Declared `tables` and `views`.
 */
function declaredObjects(schemaSql) {
  const names = (pattern) => [...schemaSql.matchAll(pattern)].map((match) => match[1]);

  return {
    tables: names(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:agentos\.)?(\w+)/g),
    views: names(/CREATE (?:OR REPLACE )?VIEW\s+(?:IF NOT EXISTS\s+)?(?:agentos\.)?(\w+)/g),
  };
}

/**
 * Fails unless the applied schema is what the DDL declares and RLS binds every table.
 *
 * @param client - Connected client.
 * @param schemaSql - Contents of every discovered migration SQL file.
 * @throws Error `MIGRATION_VERIFICATION_FAILED` listing each unmet expectation.
 */
async function assertAppliedSchema(client, schemaSql) {
  const { tables, views } = declaredObjects(schemaSql);
  const { rows: relations } = await client.query(
    `SELECT c.relname AS name, c.relkind AS kind, c.relrowsecurity AS enabled, c.relforcerowsecurity AS forced
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'agentos' AND c.relkind IN ('r', 'p', 'v')`,
  );
  const { rows: routines } = await client.query(
    `SELECT p.proname AS name
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'agentos'`,
  );
  const { rows: publicRoutines } = await client.query(
    `SELECT p.proname AS name
       FROM pg_catalog.pg_proc p
       JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
    [REQUIRED_PUBLIC_FUNCTIONS],
  );
  const { rows: auditSequenceColumns } = await client.query(
    `SELECT data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = 'agentos'
        AND table_name = 'audit_records'
        AND column_name = 'chain_seq'`,
  );
  const { rows: auditSequenceConstraints } = await client.query(
    `SELECT 1
       FROM pg_catalog.pg_constraint
      WHERE conrelid = 'agentos.audit_records'::regclass
        AND conname = 'uq_audit_records_tenant_chain_seq'
        AND contype = 'u'`,
  );
  const { rows: missingTenantColumns } = await client.query(
    `SELECT expected.table_name, expected.column_name
       FROM (VALUES
         ('tenants', 'data_class'),
         ('customers', 'data_class'), ('customer_identities', 'data_class'), ('consents', 'data_class'),
         ('orders', 'data_class'), ('customer_events', 'data_class'), ('conversations', 'data_class'),
         ('conversation_messages', 'data_class'), ('service_cases', 'data_class'), ('care_handoffs', 'data_class'),
         ('campaigns', 'data_class'), ('platform_durable_tasks', 'data_class'),
         ('effect_reservations', 'data_class'), ('approvals', 'data_class'),
         ('connector_configurations', 'secret_id'), ('connector_configurations', 'bound_at'),
         ('connector_configurations', 'probe_outcome'), ('connector_configurations', 'probe_latency_ms'),
         ('connector_configurations', 'probe_http_status'), ('connector_configurations', 'probe_error_class'),
         ('connector_configurations', 'probed_at'), ('connector_configurations', 'version'),
         ('unresolved_owner_inputs', 'resolved_value'), ('unresolved_owner_inputs', 'resolved_value_ref'),
         ('unresolved_owner_inputs', 'resolved_by'), ('unresolved_owner_inputs', 'resolved_at'),
        ('tenant_profiles', 'tenant_id'), ('tenant_profiles', 'company_name'),
        ('users', 'email'), ('users', 'password_hash'),
        ('tenant_memberships', 'role_bundle'), ('tenant_memberships', 'status'),
        ('auth_sessions', 'token_hash'), ('auth_sessions', 'idle_expires_at'), ('auth_sessions', 'absolute_expires_at'),
        ('invitations', 'token_hash'), ('invitations', 'expires_at'), ('invitations', 'consumed_at')
       ) AS expected(table_name, column_name)
       LEFT JOIN information_schema.columns AS actual
         ON actual.table_schema = 'agentos'
        AND actual.table_name = expected.table_name
        AND actual.column_name = expected.column_name
      WHERE actual.column_name IS NULL`,
  );
  const { rows: testDataSecurityRows } = await client.query(
    `SELECT
       EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_test_reset') AS reset_role_present,
       COALESCE((SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcanlogin
                   FROM pg_catalog.pg_roles WHERE rolname = 'agentos_test_reset'), FALSE) AS reset_role_constrained,
       COALESCE(pg_catalog.pg_has_role(
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app'),
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'agentos_test_reset'),
         'MEMBER'
       ), FALSE) AS app_can_set_reset_role,
       COALESCE(pg_catalog.has_function_privilege(
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'agentos_test_reset'),
         pg_catalog.to_regprocedure('agentos.reset_test_data(uuid,text,boolean)'), 'EXECUTE'
       ), FALSE) AS reset_role_can_execute,
       COALESCE((SELECT prosecdef FROM pg_catalog.pg_proc
                   WHERE oid = pg_catalog.to_regprocedure('agentos.reset_test_data(uuid,text,boolean)')), FALSE) AS reset_is_definer,
       (SELECT count(*)::integer FROM pg_catalog.pg_trigger
         WHERE tgname = 'inherit_data_class' AND NOT tgisinternal) AS data_class_trigger_count`,
  );
  const { rows: platformSecurityRows } = await client.query(
    `SELECT
       EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform') AS platform_role_present,
       COALESCE((SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcanlogin
                   FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform'), FALSE) AS platform_role_constrained,
       EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform_login') AS platform_login_present,
       COALESCE((SELECT NOT rolsuper AND NOT rolbypassrls AND rolcanlogin AND NOT rolinherit
                        AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
                   FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform_login'), FALSE) AS platform_login_constrained,
       COALESCE(pg_catalog.pg_has_role(
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app'),
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform'),
         'SET'
       ), FALSE) AS app_can_set_platform_role,
       COALESCE(pg_catalog.pg_has_role(
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform_login'),
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform'),
         'USAGE'
       ), FALSE) AS platform_login_inherits_role,
       COALESCE(pg_catalog.pg_has_role(
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform_login'),
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'agentos_platform'),
         'SET'
       ), FALSE) AS platform_login_can_set_role`,
  );
  const { rows: indexerSecurityRows } = await client.query(
    `SELECT
       EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_indexer') AS indexer_role_present,
       COALESCE((SELECT NOT rolsuper AND NOT rolbypassrls AND NOT rolcanlogin
                   FROM pg_catalog.pg_roles WHERE rolname = 'agentos_indexer'), FALSE) AS indexer_role_constrained,
       EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_indexer_login') AS indexer_login_present,
       COALESCE((SELECT NOT rolsuper AND NOT rolbypassrls AND rolcanlogin AND NOT rolinherit
                        AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication
                   FROM pg_catalog.pg_roles WHERE rolname = 'agentos_indexer_login'), FALSE) AS indexer_login_constrained,
       COALESCE(pg_catalog.pg_has_role(
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'agentos_app'),
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'agentos_indexer'),
         'SET'
       ), FALSE) AS app_can_set_indexer_role,
       COALESCE(pg_catalog.pg_has_role(
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'agentos_indexer_login'),
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'agentos_indexer'),
         'USAGE'
       ), FALSE) AS indexer_login_inherits_role,
       COALESCE(pg_catalog.pg_has_role(
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'agentos_indexer_login'),
         (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'agentos_indexer'),
         'SET'
       ), FALSE) AS indexer_login_can_set_role`,
  );
  const { rows: tenantDeletePrivileges } = await client.query(
    `SELECT
       has_table_privilege('agentos_app', 'agentos.connector_configurations', 'DELETE') AS connector_delete,
       has_table_privilege('agentos_app', 'agentos.unresolved_owner_inputs', 'DELETE') AS owner_input_delete,
       has_table_privilege('agentos_app', 'agentos.tenant_profiles', 'DELETE') AS profile_delete`,
  );
  const { rows: publicTenantFunctions } = await client.query(
    `SELECT DISTINCT p.proname AS name
       FROM pg_catalog.pg_proc AS p
       JOIN pg_catalog.pg_namespace AS n ON n.oid = p.pronamespace
      WHERE n.nspname = 'agentos'
        AND p.proname = ANY($1::text[])
        AND EXISTS (
          SELECT 1
            FROM pg_catalog.aclexplode(
              COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))
            ) AS privilege
           WHERE privilege.grantee = 0 AND privilege.privilege_type = 'EXECUTE'
        )`,
    [[
      'apply_tenant_rls', 'provision_tenant_shell_impl', 'provision_tenant_shell',
      'provision_tenant_shell_for_id', 'platform_list_tenants', 'platform_get_tenant',
      'auth_find_user_by_email', 'auth_create_session', 'auth_touch_session',
      'auth_revoke_session', 'auth_record_failed_login', 'auth_consume_invitation',
      'inherit_data_class', 'reset_test_data',
    ]],
  );
  const { rows: identitySecurityRows } = await client.query(
    `SELECT
       EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'agentos_auth') AS auth_role_present,
       COALESCE((SELECT rolsuper OR rolbypassrls OR rolcanlogin
                   FROM pg_catalog.pg_roles WHERE rolname = 'agentos_auth'), TRUE) AS auth_role_overprivileged,
       has_table_privilege('agentos_app', 'agentos.users', 'SELECT') AS app_reads_users,
       has_table_privilege('agentos_app', 'agentos.auth_sessions', 'SELECT') AS app_reads_sessions,
       has_table_privilege('agentos_app', 'agentos.invitations', 'SELECT') AS app_reads_invitations,
       has_table_privilege('agentos_app', 'agentos.tenant_memberships', 'SELECT') AS app_reads_memberships,
       (SELECT count(*) FROM pg_catalog.pg_policy AS policy
         JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = 'agentos' AND relation.relname IN ('users', 'auth_sessions')) AS unexpected_global_policies,
       (SELECT count(*) FROM pg_catalog.pg_proc AS routine
         JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = 'agentos'
          AND routine.proname = ANY($1::text[]) AND NOT routine.prosecdef) AS non_definer_auth_functions`,
    [[
      'auth_find_user_by_email', 'auth_create_session', 'auth_touch_session',
      'auth_revoke_session', 'auth_record_failed_login', 'auth_consume_invitation',
    ]],
  );


  const present = new Set(relations.map((relation) => relation.name));
  const unforced = relations
    .filter((relation) => relation.kind !== 'v' && (relation.enabled !== true || relation.forced !== true))
    .map((relation) => relation.name);
  const absent = (kind, expected) => {
    const missing = expected.filter((name) => !present.has(name));

    return missing.length > 0 ? `${kind} absent after apply: ${missing.join(', ')}` : undefined;
  };
  const routineNames = new Set(routines.map((routine) => routine.name));
  const publicRoutineNames = new Set(publicRoutines.map((routine) => routine.name));
  const missingPublicFunctions = REQUIRED_PUBLIC_FUNCTIONS.filter((name) => !publicRoutineNames.has(name));
  const missingFunctions = REQUIRED_FUNCTIONS.filter((name) => !routineNames.has(name));
  const requiredTenantFunctions = [
    'apply_tenant_rls',
    'provision_tenant_shell',
    'provision_tenant_shell_impl',
    'provision_tenant_shell_for_id',
  ];
  const missingTenantFunctions = requiredTenantFunctions.filter((name) => !routineNames.has(name));
  const tenantDeletePrivilege = tenantDeletePrivileges[0];
  const unexpectedTenantDeletePrivileges = Object.entries(tenantDeletePrivilege ?? {})
    .filter(([, allowed]) => allowed === true)
    .map(([privilege]) => privilege);
  const testDataSecurity = testDataSecurityRows[0];
  const testDataSecurityProblem =
    testDataSecurity?.reset_role_present !== true
      || testDataSecurity.reset_role_constrained !== true
      || testDataSecurity.app_can_set_reset_role !== true
      || testDataSecurity.reset_role_can_execute !== true
      || testDataSecurity.reset_is_definer !== true
      || Number(testDataSecurity.data_class_trigger_count) !== 13
      ? 'T7.1 reset role, SECURITY DEFINER function, or class inheritance triggers are misconfigured'
      : undefined;
  const identitySecurity = identitySecurityRows[0];
  const identitySecurityProblem =
    identitySecurity?.auth_role_present !== true
      || identitySecurity.auth_role_overprivileged !== false
      || identitySecurity.app_reads_users !== false
      || identitySecurity.app_reads_sessions !== false
      || identitySecurity.app_reads_invitations !== false
      || identitySecurity.app_reads_memberships !== true
      || Number(identitySecurity.unexpected_global_policies) !== 0
      || Number(identitySecurity.non_definer_auth_functions) !== 0
      ? 'identity role, default-deny tables, or SECURITY DEFINER boundaries are misconfigured'
      : undefined;
  const platformSecurity = platformSecurityRows[0];
  const platformSecurityProblem =
    platformSecurity?.platform_role_present !== true
      || platformSecurity.platform_role_constrained !== true
      || platformSecurity.platform_login_present !== true
      || platformSecurity.platform_login_constrained !== true
      || platformSecurity.app_can_set_platform_role !== false
      || platformSecurity.platform_login_inherits_role !== false
      || platformSecurity.platform_login_can_set_role !== true
      ? 'T8.1 dedicated platform login, non-inheriting membership, or app role revocation is misconfigured'
      : undefined;
  const indexerSecurity = indexerSecurityRows[0];
  const indexerSecurityProblem =
    indexerSecurity?.indexer_role_present !== true
      || indexerSecurity.indexer_role_constrained !== true
      || indexerSecurity.indexer_login_present !== true
      || indexerSecurity.indexer_login_constrained !== true
      || indexerSecurity.app_can_set_indexer_role !== false
      || indexerSecurity.indexer_login_inherits_role !== false
      || indexerSecurity.indexer_login_can_set_role !== true
      ? 'T8.2 dedicated knowledge indexer login, non-inheriting membership, or app role isolation is misconfigured'
      : undefined;

  const auditSequenceColumn = auditSequenceColumns[0];
  const auditSequenceProblem =
    auditSequenceColumn?.data_type !== 'bigint' || auditSequenceColumn.is_nullable !== 'NO'
      ? 'audit_records.chain_seq must be a NOT NULL bigint'
      : undefined;
  const auditSequenceConstraintProblem =
    auditSequenceConstraints.length !== 1
      ? 'audit_records must enforce UNIQUE (tenant_id, chain_seq)'
      : undefined;
  const problems = [
    absent('tables', tables),
    absent('views', views),
    missingFunctions.length > 0 ? `functions absent after apply: ${missingFunctions.join(', ')}` : undefined,
    missingPublicFunctions.length > 0 ? `public functions absent after apply: ${missingPublicFunctions.join(', ')}` : undefined,
    unforced.length > 0 ? `tables without ENABLE + FORCE ROW LEVEL SECURITY: ${unforced.join(', ')}` : undefined,
    missingTenantFunctions.length > 0
      ? `T2.1 functions absent after apply: ${missingTenantFunctions.join(', ')}`
      : undefined,
    missingTenantColumns.length > 0
      ? `T2.1 columns absent after apply: ${missingTenantColumns.map(({ table_name, column_name }) => `${table_name}.${column_name}`).join(', ')}`
      : undefined,
    publicTenantFunctions.length > 0
      ? `T2.1 functions executable by PUBLIC: ${publicTenantFunctions.map(({ name }) => name).join(', ')}`
      : undefined,
    unexpectedTenantDeletePrivileges.length > 0
      ? `T2.1 agentos_app has DELETE on: ${unexpectedTenantDeletePrivileges.join(', ')}`
      : undefined,
    auditSequenceProblem,
    auditSequenceConstraintProblem,
    identitySecurityProblem,
    testDataSecurityProblem,
    platformSecurityProblem,
    indexerSecurityProblem,
  ].filter((problem) => problem !== undefined);

  if (problems.length > 0) {
    throw new Error(`MIGRATION_VERIFICATION_FAILED: ${problems.join('; ')}.`);
  }
}

async function configureDedicatedLoginPassword(client, roleName, environmentName) {
  const { rows } = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = $1
     ) AS present`,
    [roleName],
  );
  if (rows[0]?.present !== true) return;

  const password = process.env[environmentName];
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error(
      `${environmentName}_REQUIRED: set the dedicated database login password in the migration bootstrap environment.`,
    );
  }

  const { rows: statements } = await client.query(
    `SELECT pg_catalog.format(
       'ALTER ROLE %I PASSWORD %L',
       $1::text,
       $2::text
     ) AS statement`,
    [roleName, password],
  );
  const statement = statements[0]?.statement;
  if (typeof statement !== 'string') {
    throw new Error(`${environmentName}_SETUP_FAILED: could not prepare the role credential update.`);
  }
  await client.query(statement);
}

async function main() {
  const connectionString = loadConnectionString();
  const files = readMigrations();
  const plan = migrationPlan(files);
  const schemaSql = [SCHEMA_FILE, ...files.filter((filename) => filename !== SCHEMA_FILE)]
    .map((filename) => readFileSync(join(migrationsDirectory, filename), 'utf8'))
    .join('\n');
  const Client = await loadDriver();
  const client = new Client({ connectionString });

  await client.connect();

  try {
    for (const group of plan) {
      await client.query('BEGIN');

      try {
        await client.query(`SET LOCAL search_path TO ${SEARCH_PATH}`);
        await ensureLedger(client);

        for (const filename of group) {
          await applyMigration(client, filename);
        }

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
    await configureDedicatedLoginPassword(client, 'agentos_platform_login', 'PLATFORM_ROLE_PASSWORD');
    await configureDedicatedLoginPassword(client, 'agentos_indexer_login', 'INDEXER_ROLE_PASSWORD');

    await assertAppliedSchema(client, schemaSql);
    console.log(
      `db:migrate:rehearse: OK - ${files.length} migration file(s) applied and verified against ${describeTarget(connectionString)}.`,
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(`db:migrate:rehearse: FAILED - ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
