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

/** Helpers the schema promises to a tenant-scoped session. */
const REQUIRED_FUNCTIONS = ['uuid_generate_v7', 'prevent_immutable_table_modification', 'current_tenant_id'];

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
 * @param schemaSql - Contents of `0000_agentos_schema.sql`.
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
 * @param schemaSql - Contents of `0000_agentos_schema.sql`.
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

  const present = new Set(relations.map((relation) => relation.name));
  const unforced = relations
    .filter((relation) => relation.kind !== 'v' && (relation.enabled !== true || relation.forced !== true))
    .map((relation) => relation.name);
  const absent = (kind, expected) => {
    const missing = expected.filter((name) => !present.has(name));

    return missing.length > 0 ? `${kind} absent after apply: ${missing.join(', ')}` : undefined;
  };
  const routineNames = new Set(routines.map((routine) => routine.name));
  const missingFunctions = REQUIRED_FUNCTIONS.filter((name) => !routineNames.has(name));
  const problems = [
    absent('tables', tables),
    absent('views', views),
    missingFunctions.length > 0 ? `functions absent after apply: ${missingFunctions.join(', ')}` : undefined,
    unforced.length > 0 ? `tables without ENABLE + FORCE ROW LEVEL SECURITY: ${unforced.join(', ')}` : undefined,
  ].filter((problem) => problem !== undefined);

  if (problems.length > 0) {
    throw new Error(`MIGRATION_VERIFICATION_FAILED: ${problems.join('; ')}.`);
  }
}

async function main() {
  const connectionString = loadConnectionString();
  const files = readMigrations();
  const plan = migrationPlan(files);
  const schemaSql = readFileSync(join(migrationsDirectory, SCHEMA_FILE), 'utf8');
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
