import { describe, expect, it } from 'vitest';

import { withTenantContext } from './rls.js';

describe('withTenantContext', () => {
  it('rejects an empty tenant id without opening a pool', async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;

    try {
      await expect(withTenantContext('', async () => 'unreachable')).rejects.toThrow(
        'TENANT_CONTEXT_REQUIRED',
      );
      await expect(withTenantContext('   ', async () => 'unreachable')).rejects.toThrow(
        'TENANT_CONTEXT_REQUIRED',
      );
    } finally {
      if (previousDatabaseUrl !== undefined) {
        process.env.DATABASE_URL = previousDatabaseUrl;
      }
    }
  });
});
