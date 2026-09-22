import { afterEach, describe, expect, it } from 'vitest';

import { assertTenantContext, withTenantContext } from './rls.js';

const originalDatabaseUrl = process.env.DATABASE_URL;

const TENANT_A = '01920000-0000-7000-8000-00000000000a';
const TENANT_B = '01920000-0000-7000-8000-00000000000b';

/**
 * Binder validation runs before `getPool()`, so every case below must hold with
 * no database configured at all. Removing `DATABASE_URL` makes a regression that
 * reaches for a connection fail loudly with `DATABASE_URL_REQUIRED` instead.
 */
const NON_UUID_TENANTS: readonly string[] = [
  'tenant-a',
  '0192-0000-7000-8000-00000000000a',
  '01920000-0000-7000-8000-00000000000g',
  '01920000-0000-7000-8000-00000000000a0',
  '  ',
  '',
];

afterEach(() => {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe('withTenantContext', () => {
  it('rejects an empty tenant id without opening a pool', async () => {
    delete process.env.DATABASE_URL;

    await expect(withTenantContext('', async () => 'unreachable')).rejects.toThrow(
      'TENANT_CONTEXT_REQUIRED',
    );
    await expect(withTenantContext('   ', async () => 'unreachable')).rejects.toThrow(
      'TENANT_CONTEXT_REQUIRED',
    );
  });

  it('rejects a non-UUID tenant id without opening a pool', async () => {
    delete process.env.DATABASE_URL;

    for (const tenantId of NON_UUID_TENANTS) {
      await expect(withTenantContext(tenantId, async () => 'unreachable')).rejects.toThrow(
        'TENANT_CONTEXT_REQUIRED',
      );
    }
  });

  it('rejects a comma-separated tenant id pair without opening a pool', async () => {
    delete process.env.DATABASE_URL;

    // The RLS predicate parses a comma-separated list, so the binder must refuse one
    // itself: accepting it here would let a caller widen its own read scope.
    for (const tenantId of [
      `${TENANT_A},${TENANT_B}`,
      `${TENANT_A}, ${TENANT_B}`,
      `${TENANT_A},`,
    ]) {
      await expect(withTenantContext(tenantId, async () => 'unreachable')).rejects.toThrow(
        'TENANT_CONTEXT_REQUIRED',
      );
    }
  });

  it('never invokes the callback for a refused tenant id', async () => {
    delete process.env.DATABASE_URL;

    let invoked = false;
    const callback = async (): Promise<string> => {
      invoked = true;
      return 'unreachable';
    };

    await expect(withTenantContext('', callback)).rejects.toThrow('TENANT_CONTEXT_REQUIRED');
    await expect(withTenantContext('not-a-uuid', callback)).rejects.toThrow(
      'TENANT_CONTEXT_REQUIRED',
    );
    await expect(
      withTenantContext(`${TENANT_A},${TENANT_B}`, callback),
    ).rejects.toThrow('TENANT_CONTEXT_REQUIRED');

    expect(invoked).toBe(false);
  });
});

describe('assertTenantContext', () => {
  it('accepts exactly one UUID and returns without touching the pool', () => {
    expect(() => assertTenantContext(TENANT_A)).not.toThrow();
    expect(() => assertTenantContext(TENANT_B)).not.toThrow();
  });

  it('refuses blank, non-UUID and comma-separated values', () => {
    for (const tenantId of [...NON_UUID_TENANTS, `${TENANT_A},${TENANT_B}`]) {
      expect(() => assertTenantContext(tenantId)).toThrow('TENANT_CONTEXT_REQUIRED');
    }
  });
});
