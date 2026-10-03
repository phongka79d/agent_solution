import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { SecretRepository, type EncryptedSecret } from './secrets.js';

const TENANT = '10000000-0000-4000-8000-000000000001';
const SECRET_ID = '20000000-0000-4000-8000-000000000002';
const PLAINTEXT = 'private-token-value';

function harness(rows: readonly QueryResultRow[] = []) {
  const queries: Array<{ sql: string; params: readonly unknown[] }> = [];
  const client = {
    query: async <Row extends QueryResultRow>(sql: string, params: readonly unknown[] = []) => {
      queries.push({ sql, params });
      const resultRows = sql.includes('agentos.platform_append_audit')
        ? [{ event_id: 'audit-event' }]
        : rows;
      return { rows: resultRows as Row[], rowCount: resultRows.length } as QueryResult<Row>;
    },
  } as unknown as PoolClient;
  const tenants: string[] = [];
  const runInTenantTransaction = async <T>(tenant_id: string, work: (db: PoolClient) => Promise<T>) => {
    tenants.push(tenant_id);
    return work(client);
  };
  const encrypted: EncryptedSecret = {
    nonce: Buffer.alloc(12, 1),
    ciphertext: Buffer.alloc(28, 2),
    keyVersion: 'a1b2c3d4',
    fingerprint: 'f'.repeat(64),
  };
  const encrypt = vi.fn(async (): Promise<EncryptedSecret> => encrypted);
  const repository = new SecretRepository({ encrypt }, runInTenantTransaction);
  return { repository, queries, tenants, encrypt };
}

describe('SecretRepository', () => {
  it('encrypts with tenant-bound AAD and writes ciphertext without issuing plaintext to SQL', async () => {
    const { repository, encrypt, queries, tenants } = harness([{
      secret_id: SECRET_ID,
      fingerprint: 'f'.repeat(64),
      last4: 'alue',
      created_at: new Date('2026-09-30T00:00:00Z'),
    }]);

    const result = await repository.put(TENANT, {
      purpose: 'llm:openai',
      plaintext: PLAINTEXT,
      actor_kind: 'OPERATOR',
      actor_id: 'user-1',
      correlation_id: 'corr-1',
    });

    expect(encrypt).toHaveBeenCalledWith({
      plaintext: PLAINTEXT,
      aad: expect.stringMatching(new RegExp(`^${TENANT}\\|[0-9a-f-]+\\|llm:openai$`)),
    });
    expect(tenants).toEqual([TENANT]);
    expect(queries[0]?.sql).toContain('INSERT INTO agentos.tenant_secrets');
    expect(queries[0]?.params).not.toContain(PLAINTEXT);
    expect(queries[0]?.params).toContainEqual(Buffer.alloc(28, 2));
    expect(queries[1]?.sql).toContain('agentos.platform_append_audit');
    expect(queries[1]?.params).not.toContain(PLAINTEXT);
    expect(queries[1]?.params).toContain(JSON.stringify({
      purpose: 'llm:openai',
      fingerprint: 'f'.repeat(64),
      last4: 'alue',
    }));
    expect(result).toEqual({
      secret_id: SECRET_ID,
      purpose: 'llm:openai',
      fingerprint: 'f'.repeat(64),
      last4: 'alue',
      created_at: '2026-09-30T00:00:00.000Z',
      revoked_at: null,
    });
  });

  it('describe returns an explicit metadata projection and never plaintext', async () => {
    const { repository, queries } = harness([{
      secret_id: SECRET_ID,
      purpose: 'llm:openai',
      fingerprint: 'f'.repeat(64),
      last4: 'alue',
      created_at: new Date('2026-09-30T00:00:00Z'),
      revoked_at: null,
      plaintext: PLAINTEXT,
      ciphertext: Buffer.from(PLAINTEXT),
    }]);

    const result = await repository.describe(TENANT, SECRET_ID);

    expect(queries[0]?.sql).not.toContain('plaintext');
    expect(result).toEqual({
      secret_id: SECRET_ID,
      purpose: 'llm:openai',
      fingerprint: 'f'.repeat(64),
      last4: 'alue',
      created_at: '2026-09-30T00:00:00.000Z',
      revoked_at: null,
    });
    expect(JSON.stringify(result)).not.toContain(PLAINTEXT);
    expect(result && 'ciphertext' in result).toBe(false);
  });

  it('runtime reads exclude revoked rows and revoke is an audited update, not deletion', async () => {
    const { repository, queries } = harness();

    await expect(repository.getEncrypted(TENANT, SECRET_ID)).resolves.toBeNull();
    await expect(repository.revoke(TENANT, SECRET_ID, {
      actor_kind: 'OPERATOR',
      actor_id: 'user-1',
      correlation_id: 'corr-2',
    })).resolves.toBe(false);

    expect(queries[0]?.sql).toContain('revoked_at IS NULL');
    expect(queries[1]?.sql).toContain('UPDATE agentos.tenant_secrets');
    expect(queries[1]?.sql).not.toContain('DELETE');
    expect(queries[2]?.sql).toContain('agentos.platform_append_audit');
  });

  it('audits successful revocation using metadata only in the same tenant transaction', async () => {
    const { repository, queries, tenants } = harness([{
      secret_id: SECRET_ID,
      purpose: 'llm:openai',
      fingerprint: 'f'.repeat(64),
      last4: 'alue',
      created_at: new Date('2026-09-30T00:00:00Z'),
      revoked_at: new Date('2026-09-30T01:00:00Z'),
    }]);

    await expect(repository.revoke(TENANT, SECRET_ID, {
      actor_kind: 'OPERATOR',
      actor_id: 'user-1',
      correlation_id: 'corr-3',
    })).resolves.toBe(true);

    expect(tenants).toEqual([TENANT]);
    expect(queries).toHaveLength(2);
    expect(queries[0]?.sql).toContain('UPDATE agentos.tenant_secrets');
    expect(queries[1]?.sql).toContain('agentos.platform_append_audit');
    expect(queries[1]?.params).toContain(JSON.stringify({
      purpose: 'llm:openai',
      fingerprint: 'f'.repeat(64),
      last4: 'alue',
      revoked: true,
    }));
  });
});
