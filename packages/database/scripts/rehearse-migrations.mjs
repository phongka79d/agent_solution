#!/usr/bin/env node
/**
 * Migration rehearsal gate for `packages/database`.
 *
 * P0 authorises no schema: `migrations/` is expected to hold no `.sql` file. This
 * script exits 0 for an empty migration directory and exits 1 as soon as any `.sql`
 * file appears, so a schema migration can never reach a pipeline unnoticed.
 */
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const migrationsDirectory = fileURLToPath(new URL('../migrations/', import.meta.url));

const sqlFiles = readdirSync(migrationsDirectory, { recursive: true })
  .map((entry) => String(entry).replaceAll('\\', '/'))
  .filter((entry) => entry.toLowerCase().endsWith('.sql'))
  .sort();

if (sqlFiles.length > 0) {
  console.error(
    `MIGRATION_SCHEMA_UNAUTHORIZED: ${sqlFiles.length} .sql file(s) found in migrations/ ` +
      `(${sqlFiles.join(', ')}). P0 authorises no SQL schema; remove them or land the schema ` +
      'under a task that owns DDL.',
  );
  process.exit(1);
}

console.log('db:migrate:rehearse: migrations/ holds no .sql file, schema creation stays unauthorized.');
process.exit(0);
