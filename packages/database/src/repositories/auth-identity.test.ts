import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { IdentityRepository } from './auth-identity.js';
import type { AuthTransactionRunner } from './auth-identity.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

const TENANT_ID = '01920000-0000-7000-8000-000000000001';
const USER_ID = '01920000-0000-7000-8000-000000000002';
const TOKEN_HASH = 'a'.repeat(64);

function clientReturning(rows: readonly Record<string, unknown>[]) {
  return {
    query: vi.fn(async () => ({ rows })),
  } as unknown as PoolClient;
}

describe('IdentityRepository', () => {
  it('maps global lookup credentials while normalizing email before invoking auth', async () => {
    const client = clientReturning([{
      user_id: USER_ID,
      email: 'person@example.com',
      password_hash: 'scrypt$stored-hash',
      failed_login_attempts: 4,
      locked_until: new Date('2026-10-01T12:15:00.000Z'),
    }]);
    const authTransaction: AuthTransactionRunner = async <T>(work: (client: PoolClient) => Promise<T>) => work(client);
    const repository = new IdentityRepository({ authTransaction });

    const user = await repository.findUserByEmail('  Person@Example.COM  ');

    expect(user).toEqual({
      user_id: USER_ID,
      email: 'person@example.com',
      password_hash: 'scrypt$stored-hash',
      failed_login_attempts: 4,
      locked_until: '2026-10-01T12:15:00.000Z',
    });
    expect(client.query).toHaveBeenCalledWith(
      'SELECT * FROM agentos.auth_find_user_by_email($1)',
      ['person@example.com'],
    );
  });

  it('returns durable session expiry bounds without exposing the token hash', async () => {
    const client = clientReturning([{
      session_id: 'session-1',
      user_id: USER_ID,
      created_at: new Date('2026-10-01T12:00:00.000Z'),
      last_seen_at: new Date('2026-10-01T12:00:00.000Z'),
      idle_expires_at: new Date('2026-10-01T12:30:00.000Z'),
      absolute_expires_at: new Date('2026-10-01T20:00:00.000Z'),
    }]);
    const repository = new IdentityRepository({
      authTransaction: async (work) => work(client),
    });

    const session = await repository.createSession({
      user_id: USER_ID,
      token_hash: TOKEN_HASH,
      idle_lifetime_seconds: 1800,
      absolute_lifetime_seconds: 28800,
    });

    expect(session).toEqual({
      session_id: 'session-1',
      user_id: USER_ID,
      created_at: '2026-10-01T12:00:00.000Z',
      last_seen_at: '2026-10-01T12:00:00.000Z',
      idle_expires_at: '2026-10-01T12:30:00.000Z',
      absolute_expires_at: '2026-10-01T20:00:00.000Z',
    });
    expect(session).not.toHaveProperty('token_hash');
    expect(client.query).toHaveBeenCalledWith(
      'SELECT * FROM agentos.auth_create_session($1::uuid, $2, $3, $4)',
      [USER_ID, TOKEN_HASH, 1800, 28800],
    );
  });

  it('reads membership projections only through the supplied tenant-scoped transaction', async () => {
    const client = clientReturning([{
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      role_bundle: 'COMPANY_ADMIN',
      status: 'ACTIVE',
      created_at: new Date('2026-10-01T12:00:00.000Z'),
      updated_at: new Date('2026-10-01T12:05:00.000Z'),
    }]);
    let transactionCalls = 0;
    const tenantTransaction: TenantTransactionRunner = async <T>(
      tenant_id: string,
      work: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      transactionCalls += 1;
      expect(tenant_id).toBe(TENANT_ID);
      return work(client);
    };
    const repository = new IdentityRepository({ tenantTransaction });

    const memberships = await repository.listMemberships(TENANT_ID, USER_ID);

    expect(memberships).toEqual([{
      tenant_id: TENANT_ID,
      user_id: USER_ID,
      role_bundle: 'COMPANY_ADMIN',
      status: 'ACTIVE',
      created_at: '2026-10-01T12:00:00.000Z',
      updated_at: '2026-10-01T12:05:00.000Z',
    }]);
    expect(transactionCalls).toBe(1);
  });

  it('maps display name and nullable last sign-in timestamps from the tenant-member projection', async () => {
    const client = clientReturning([
      {
        user_id: USER_ID,
        email: 'member@example.test',
        display_name: 'Ada Member',
        role_bundle: 'OPERATOR',
        status: 'ACTIVE',
        last_sign_in_at: new Date('2026-09-30T14:15:16.000Z'),
        created_at: new Date('2026-09-01T08:00:00.000Z'),
        updated_at: new Date('2026-09-20T09:00:00.000Z'),
      },
      {
        user_id: '01920000-0000-7000-8000-000000000003',
        email: 'new@example.test',
        display_name: null,
        role_bundle: 'VIEWER',
        status: 'INVITED',
        last_sign_in_at: null,
        created_at: new Date('2026-09-02T08:00:00.000Z'),
        updated_at: new Date('2026-09-02T08:00:00.000Z'),
      },
    ]);
    const repository = new IdentityRepository({
      authTransaction: async (work) => work(client),
    });

    const members = await repository.listTenantMembers(TENANT_ID);

    expect(members).toEqual([
      {
        user_id: USER_ID,
        email: 'member@example.test',
        display_name: 'Ada Member',
        role_bundle: 'OPERATOR',
        status: 'ACTIVE',
        last_sign_in_at: '2026-09-30T14:15:16.000Z',
        created_at: '2026-09-01T08:00:00.000Z',
        updated_at: '2026-09-20T09:00:00.000Z',
      },
      {
        user_id: '01920000-0000-7000-8000-000000000003',
        email: 'new@example.test',
        display_name: null,
        role_bundle: 'VIEWER',
        status: 'INVITED',
        last_sign_in_at: null,
        created_at: '2026-09-02T08:00:00.000Z',
        updated_at: '2026-09-02T08:00:00.000Z',
      },
    ]);
    expect(client.query).toHaveBeenCalledWith(
      'SELECT * FROM agentos.auth_list_tenant_members($1::uuid)',
      [TENANT_ID],
    );
  });

  it('refuses malformed session token hashes before opening a database transaction', async () => {
    let transactionCalls = 0;
    const authTransaction: AuthTransactionRunner = async <T>(
      _work: (client: PoolClient) => Promise<T>,
    ): Promise<T> => {
      transactionCalls += 1;
      throw new Error('Unexpected auth transaction');
    };
    const repository = new IdentityRepository({ authTransaction });

    await expect(repository.revokeSession('plaintext-token')).rejects.toThrow('AUTH_TOKEN_HASH_INVALID');
    expect(transactionCalls).toBe(0);
  });
});
