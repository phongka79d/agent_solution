import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { checkSchema } from './schema-check.js';

const migrationFiles = readdirSync(fileURLToPath(new URL('../migrations/', import.meta.url)))
  .filter((filename) => filename.toLowerCase().endsWith('.sql'))
  .sort();

function fakeQuery(appliedFiles: readonly string[], platformRoleCanSet = true) {
  return vi.fn(async (statement: string) => {
    if (statement.includes('agentos.schema_applied_migrations()')) {
      return { rows: appliedFiles.map((filename) => ({ filename })) };
    }
    return {
      rows: [{
        platform_function_present: true,
        platform_role_active: true,
        platform_role_can_set: platformRoleCanSet,
      }],
    };
  });
}

describe('checkSchema', () => {
  it('reports SCHEMA_BEHIND when the ledger lacks the newest bundled migration', async () => {
    const query = fakeQuery(migrationFiles.slice(0, -1));

    const result = await checkSchema(query);

    expect(result).toEqual({ ready: false, failures: ['SCHEMA_BEHIND'] });
  });

  it('reports PLATFORM_ROLE_MISSING when the dedicated login cannot set the platform role', async () => {
    const query = fakeQuery(migrationFiles, false);

    const result = await checkSchema(query);

    expect(result).toEqual({ ready: false, failures: ['PLATFORM_ROLE_MISSING'] });
  });

  it('is ready when every bundled migration and platform role check passes', async () => {
    const query = fakeQuery(migrationFiles);

    const result = await checkSchema(query);

    expect(result).toEqual({ ready: true, failures: [] });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("to_regprocedure('agentos.platform_list_tenants()')"));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("current_user = 'agentos_platform'"));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("pg_has_role(session_user, 'agentos_platform', 'SET')"));
  });
});
