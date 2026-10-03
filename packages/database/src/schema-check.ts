import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getPool } from './client.js';
import { withPlatformRole } from './repositories/platform-directory.js';

const MIGRATIONS_DIRECTORY = fileURLToPath(new URL('../migrations/', import.meta.url));
const LEDGER_QUERY = 'SELECT filename FROM agentos.schema_applied_migrations()';
const PLATFORM_QUERY = `
  SELECT
    to_regprocedure('agentos.platform_list_tenants()') IS NOT NULL AS platform_function_present,
    current_user = 'agentos_platform' AS platform_role_active,
    pg_has_role(session_user, 'agentos_platform', 'SET') AS platform_role_can_set
`;

export type SchemaCheckCode = 'SCHEMA_BEHIND' | 'PLATFORM_ROLE_MISSING';

export interface SchemaCheckResult {
  readonly ready: boolean;
  readonly failures: readonly SchemaCheckCode[];
}

export type SchemaCheckQuery = (
  statement: string,
) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>;

/**
 * Compares the applied migration ledger with the SQL files shipped beside this package and checks
 * that the dedicated platform login can use the platform directory. Only stable, value-free failure
 * codes leave this function; database errors and paths are never returned.
 */
export async function checkSchema(query?: SchemaCheckQuery): Promise<SchemaCheckResult> {
  const failures: Record<SchemaCheckCode, boolean> = {
    SCHEMA_BEHIND: false,
    PLATFORM_ROLE_MISSING: false,
  };
  const execute = query ?? ((statement: string) => getPool().query(statement));
  const executePlatform =
    query ?? ((statement: string) => withPlatformRole((client) => client.query(statement)));
  let migrationFiles: string[] = [];

  try {
    migrationFiles = readdirSync(MIGRATIONS_DIRECTORY)
      .filter((filename) => filename.toLowerCase().endsWith('.sql'))
      .sort();
  } catch {
    failures.SCHEMA_BEHIND = true;
  }

  try {
    const { rows } = await execute(LEDGER_QUERY);
    const applied = new Set(
      rows
        .map((row) => row.filename)
        .filter((filename): filename is string => typeof filename === 'string'),
    );
    if (migrationFiles.length === 0 || migrationFiles.some((filename) => !applied.has(filename))) {
      failures.SCHEMA_BEHIND = true;
    }
  } catch {
    failures.SCHEMA_BEHIND = true;
  }

  try {
    const { rows } = await executePlatform(PLATFORM_QUERY);
    const platform = rows[0];
    if (platform?.platform_function_present !== true) failures.SCHEMA_BEHIND = true;
    if (platform?.platform_role_active !== true || platform?.platform_role_can_set !== true) {
      failures.PLATFORM_ROLE_MISSING = true;
    }
  } catch {
    failures.SCHEMA_BEHIND = true;
    failures.PLATFORM_ROLE_MISSING = true;
  }

  const codes = (Object.keys(failures) as SchemaCheckCode[]).filter((code) => failures[code]);
  return { ready: codes.length === 0, failures: codes };
}
