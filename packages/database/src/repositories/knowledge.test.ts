import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import type { TenantTransactionRunner } from './effect-reservations.js';
import { KnowledgeRepository, type KnowledgeActor } from './knowledge.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const DOCUMENT = '22222222-2222-4222-8222-222222222222';
const ACTOR: KnowledgeActor = {
  actor_kind: 'OPERATOR',
  actor_id: 'operator-1',
  correlation_id: 'knowledge-test-1',
};
const CREATED_AT = new Date('2026-10-01T10:00:00.000Z');
const BODY = 'Returns are accepted within 30 days.';

function documentRow(content_sha256: string, overrides: Record<string, unknown> = {}) {
  return {
    tenant_id: TENANT,
    document_id: DOCUMENT,
    namespace: 'customer-care',
    document_type: 'RETURNS',
    slug: 'returns-policy',
    current_version: '1',
    title: 'Returns policy',
    body: BODY,
    content_sha256,
    data_class: 'PRODUCTION',
    status: 'DRAFT',
    created_by: ACTOR.actor_id,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  };
}

describe('KnowledgeRepository', () => {
  it('creates a tenant-bound immutable revision with a matching content digest and redacted audit projection', async () => {
    const content_sha256 = createHash('sha256').update(BODY, 'utf8').digest('hex');
    const query = vi.fn(async (sql: string, _values: readonly unknown[] = []) => {
      if (sql.startsWith('INSERT INTO agentos.knowledge_documents')) return { rows: [{ document_id: DOCUMENT }] };
      if (sql.startsWith('INSERT INTO agentos.knowledge_document_versions')) return { rows: [{ content_sha256 }] };
      if (sql.includes('FROM agentos.knowledge_documents AS d')) return { rows: [documentRow(content_sha256)] };
      if (sql.includes('platform_append_audit')) return { rows: [{ event_id: 'audit-1' }] };
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;
    const boundTenants: string[] = [];
    const tenantTransaction: TenantTransactionRunner = async (tenant_id, work) => {
      boundTenants.push(tenant_id);
      return work(client);
    };
    const repository = new KnowledgeRepository({ tenantTransaction });

    const created = await repository.create(TENANT, {
      namespace: 'customer-care',
      type: 'RETURNS',
      slug: 'returns-policy',
      title: 'Returns policy',
      body: BODY,
      actor: ACTOR,
    });

    expect(boundTenants).toEqual([TENANT]);
    expect(created).toMatchObject({
      tenant_id: TENANT,
      document_id: DOCUMENT,
      version: 1,
      status: 'DRAFT',
      data_class: 'PRODUCTION',
      content_sha256,
      body: BODY,
    });
    const versionWrite = query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO agentos.knowledge_document_versions'));
    expect(versionWrite?.[1]?.[8]).toBe(content_sha256);
    const auditWrite = query.mock.calls.find(([sql]) => sql.includes('platform_append_audit'));
    expect(auditWrite?.[1]?.[9]).toContain(content_sha256);
    expect(auditWrite?.[1]?.[9]).not.toContain(BODY);
  });

  it('stores edits as a new immutable version and resets an approved document to draft', async () => {
    const updatedBody = 'Returns are accepted within 45 days.';
    const content_sha256 = createHash('sha256').update(updatedBody, 'utf8').digest('hex');
    const before = documentRow('a'.repeat(64), { current_version: '3', status: 'APPROVED', body: 'previous body' });
    const after = documentRow(content_sha256, { current_version: '4', body: updatedBody });
    const query = vi.fn(async (sql: string, _values: readonly unknown[] = []) => {
      if (sql.includes('FOR UPDATE OF d')) return { rows: [before] };
      if (sql.startsWith('INSERT INTO agentos.knowledge_document_versions')) return { rows: [{ content_sha256 }] };
      if (sql.includes('FROM agentos.knowledge_documents AS d')) return { rows: [after] };
      if (sql.includes('platform_append_audit')) return { rows: [{ event_id: 'audit-2' }] };
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;
    const tenantTransaction: TenantTransactionRunner = async (_tenant_id, work) => work(client);
    const repository = new KnowledgeRepository({ tenantTransaction });

    const updated = await repository.update(TENANT, DOCUMENT, {
      namespace: 'customer-care',
      type: 'RETURNS',
      slug: 'returns-policy',
      title: 'Returns policy',
      body: updatedBody,
      actor: ACTOR,
    });

    expect(updated).toMatchObject({ version: 4, status: 'DRAFT', body: updatedBody, content_sha256 });
    const versionWrite = query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO agentos.knowledge_document_versions'));
    expect(versionWrite?.[1]).toEqual([
      TENANT, DOCUMENT, 4, 'customer-care', 'RETURNS', 'returns-policy', 'Returns policy',
      updatedBody, content_sha256, ACTOR.actor_id,
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SET namespace = $3, document_type = $4, slug = $5, current_version = $6"),
      [TENANT, DOCUMENT, 'customer-care', 'RETURNS', 'returns-policy', 4],
    );
  });

  it('refuses available-status requests unless they come through an indexer actor', async () => {
    const tenantTransaction = vi.fn(async () => {
      throw new Error('tenant transaction must not run');
    }) as unknown as TenantTransactionRunner;
    const indexerTransaction = vi.fn(async () => {
      throw new Error('indexer transaction must not run');
    }) as unknown as TenantTransactionRunner;
    const repository = new KnowledgeRepository({ tenantTransaction, indexerTransaction });

    await expect(repository.markAvailable(TENANT, DOCUMENT, ACTOR, 1)).rejects.toThrow('KNOWLEDGE_INDEXER_REQUIRED');
    expect(tenantTransaction).not.toHaveBeenCalled();
    expect(indexerTransaction).not.toHaveBeenCalled();
  });
  it('lists only approved records inside the requested tenant', async () => {
    const approved = documentRow('a'.repeat(64), { status: 'APPROVED' });
    const query = vi.fn(async () => ({ rows: [approved] }));
    const client = { query } as unknown as PoolClient;
    const boundTenants: string[] = [];
    const tenantTransaction: TenantTransactionRunner = async (tenant_id, work) => {
      boundTenants.push(tenant_id);
      return work(client);
    };
    const repository = new KnowledgeRepository({ tenantTransaction });

    const documents = await repository.listApproved(TENANT, 17);

    expect(boundTenants).toEqual([TENANT]);
    expect(documents).toMatchObject([{ tenant_id: TENANT, document_id: DOCUMENT, status: 'APPROVED' }]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("WHERE d.tenant_id = $1 AND d.status = 'APPROVED'"),
      [TENANT, 17],
    );
  });

  it('marks the expected approved version available once via the indexer runner', async () => {
    const indexer: KnowledgeActor = {
      actor_kind: 'INDEXER',
      actor_id: 'knowledge-indexer',
      correlation_id: 'knowledge-indexer-test',
    };
    let status = 'APPROVED';
    const query = vi.fn(async (sql: string, values: readonly unknown[] = []) => {
      if (sql.includes('FOR UPDATE OF d')) {
        return { rows: [documentRow('a'.repeat(64), { status })] };
      }
      if (sql.startsWith('UPDATE agentos.knowledge_documents')) {
        if (values[2] === 'AVAILABLE') status = 'AVAILABLE';
        return { rows: [] };
      }
      if (sql.includes('FROM agentos.knowledge_documents AS d')) {
        return { rows: [documentRow('a'.repeat(64), { status })] };
      }
      if (sql.includes('platform_append_audit')) return { rows: [{ event_id: 'audit-available' }] };
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;
    let tenantRuns = 0;
    let indexerRuns = 0;
    const tenantTransaction: TenantTransactionRunner = async () => {
      tenantRuns += 1;
      throw new Error('AVAILABLE transitions must not use the application runner');
    };
    const indexerTransaction: TenantTransactionRunner = async (_tenant_id, work) => {
      indexerRuns += 1;
      return work(client);
    };
    const repository = new KnowledgeRepository({ tenantTransaction, indexerTransaction });

    const first = await repository.markAvailable(TENANT, DOCUMENT, indexer, 1);
    const repeated = await repository.markAvailable(TENANT, DOCUMENT, indexer, 1);

    expect(first.status).toBe('AVAILABLE');
    expect(repeated.status).toBe('AVAILABLE');
    expect(query.mock.calls.filter(([sql]) => sql.startsWith('UPDATE agentos.knowledge_documents'))).toHaveLength(1);
    expect(tenantRuns).toBe(0);
    expect(indexerRuns).toBe(2);
    expect(query.mock.calls.filter(([sql]) => sql.includes('platform_append_audit'))).toHaveLength(1);
  });

  it('refuses to mark a different document version available', async () => {
    const indexer: KnowledgeActor = {
      actor_kind: 'INDEXER',
      actor_id: 'knowledge-indexer',
      correlation_id: 'knowledge-indexer-stale-test',
    };
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE OF d')) {
        return { rows: [documentRow('a'.repeat(64), { current_version: '2', status: 'APPROVED' })] };
      }
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;
    const indexerTransaction: TenantTransactionRunner = async (_tenant_id, work) => work(client);
    const repository = new KnowledgeRepository({ indexerTransaction });

    await expect(repository.markAvailable(TENANT, DOCUMENT, indexer, 1)).rejects.toThrow('KNOWLEDGE_VERSION_CONFLICT');
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE agentos.knowledge_documents'), expect.anything());
  });


  it('reports agents whose persisted response cites an immutable knowledge version', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('jsonb_array_elements(r.sources)')) return { rows: [{ agent_id: 'CARE-01' }] };
      return { rows: [] };
    });
    const client = { query } as unknown as PoolClient;
    const tenantTransaction: TenantTransactionRunner = async (_tenant_id, work) => work(client);
    const repository = new KnowledgeRepository({ tenantTransaction });

    const usage = await repository.usage(TENANT, DOCUMENT);

    expect(usage).toEqual({ document_id: DOCUMENT, agents: ['CARE-01'], skills: null });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("citation.value ->> 'source_version'"), [TENANT, DOCUMENT]);
  });
});
