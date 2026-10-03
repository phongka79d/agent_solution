import { describe, expect, it, vi } from 'vitest';

import type {
  KnowledgeActor,
  KnowledgeDocumentRecord,
  KnowledgePage,
  KnowledgePageQuery,
} from '@agentos/database';

import {
  assertKnowledgeVectorClientConfigured,
  createKnowledgeIndexer,
  DEFAULT_KNOWLEDGE_INDEX_INTERVAL_MS,
  KNOWLEDGE_INDEX_BATCH_LIMIT,
  type KnowledgeIndexerRepository,
  type KnowledgeVectorClient,
} from './knowledge-indexer.js';

function documentFor(
  tenant_id: string,
  document_id: string,
  status: 'APPROVED' | 'ARCHIVED' = 'APPROVED',
): KnowledgeDocumentRecord {
  return {
    tenant_id,
    document_id,
    namespace: 'customer-care',
    type: 'RETURNS',
    slug: 'returns-policy',
    version: 3,
    title: 'Returns policy',
    body: 'Returns are accepted within 30 days.',
    content_sha256: 'a'.repeat(64),
    data_class: 'PRODUCTION',
    status,
    created_by: 'operator-1',
    created_at: '2026-10-01T10:00:00.000Z',
    updated_at: '2026-10-01T10:00:00.000Z',
  };
}

const EMPTY_PAGE: KnowledgePage = { items: [], next_cursor: null };


describe('createKnowledgeIndexer', () => {
  it('marks approved documents available once across repeated sweeps and leaves Qdrant disabled by default', async () => {
    const document = documentFor('tenant-a', 'document-a');
    let stillApproved = true;
    const markAvailable = vi.fn(async (
      _tenant_id: string,
      _document_id: string,
      _actor: KnowledgeActor,
      _expected_version: number,
    ): Promise<KnowledgeDocumentRecord> => {
      stillApproved = false;
      return { ...document, status: 'AVAILABLE' };
    });
    const repository: KnowledgeIndexerRepository = {
      listApproved: vi.fn(async () => stillApproved ? [document] : []),
      list: vi.fn(async () => EMPTY_PAGE),
      markAvailable,
    };
    const vectorClient: KnowledgeVectorClient = {
      upsertDocumentChunks: vi.fn(async () => undefined),
      removeDocument: vi.fn(async () => undefined),
    };
    const indexer = createKnowledgeIndexer({
      env: {},
      tenantIds: ['tenant-a'],
      repository,
      vectorClient,
      autoStart: false,
    });

    await indexer.runOnce();
    await indexer.runOnce();

    expect(markAvailable).toHaveBeenCalledTimes(1);
    expect(markAvailable).toHaveBeenCalledWith(
      'tenant-a',
      'document-a',
      expect.objectContaining({ actor_kind: 'INDEXER', actor_id: 'knowledge-indexer' }),
      3,
    );
    expect(vectorClient.upsertDocumentChunks).not.toHaveBeenCalled();
    expect(vectorClient.removeDocument).not.toHaveBeenCalled();
  });

  it('skips archived documents returned outside the approved repository contract', async () => {
    const archived = documentFor('tenant-a', 'archived-document', 'ARCHIVED');
    const markAvailable = vi.fn(async () => archived);
    const repository: KnowledgeIndexerRepository = {
      listApproved: vi.fn(async () => [archived]),
      list: vi.fn(async () => EMPTY_PAGE),
      markAvailable,
    };
    const indexer = createKnowledgeIndexer({
      env: {},
      tenantIds: ['tenant-a'],
      repository,
      autoStart: false,
    });

    await indexer.runOnce();

    expect(markAvailable).not.toHaveBeenCalled();
    expect(repository.list).not.toHaveBeenCalled();
  });

  it('upserts approved chunks and removes archived documents only in configured Qdrant mode', async () => {
    const approved = documentFor('tenant-a', 'approved-document');
    const archived = documentFor('tenant-a', 'archived-document', 'ARCHIVED');
    const events: string[] = [];
    const repository: KnowledgeIndexerRepository = {
      listApproved: vi.fn(async () => [approved]),
      list: vi.fn(async (_tenant_id: string, query?: KnowledgePageQuery) => query?.status === 'ARCHIVED'
        ? { items: [archived], next_cursor: null }
        : EMPTY_PAGE),
      markAvailable: vi.fn(async (
        _tenant_id: string,
        _document_id: string,
        _actor: KnowledgeActor,
        _expected_version: number,
      ): Promise<KnowledgeDocumentRecord> => {
        events.push('available');
        return { ...approved, status: 'AVAILABLE' };
      }),
    };
    const vectorClient: KnowledgeVectorClient = {
      upsertDocumentChunks: vi.fn(async (tenant_id: string, document: KnowledgeDocumentRecord) => {
        events.push(`upsert:${tenant_id}:${document.document_id}`);
      }),
      removeDocument: vi.fn(async (tenant_id: string, document_id: string) => {
        events.push(`remove:${tenant_id}:${document_id}`);
      }),
    };
    const indexer = createKnowledgeIndexer({
      env: { KNOWLEDGE_VECTOR_INDEX: 'qdrant' },
      tenantIds: ['tenant-a'],
      repository,
      vectorClient,
      autoStart: false,
    });

    await indexer.runOnce();

    expect(events).toEqual([
      'upsert:tenant-a:approved-document',
      'available',
      'remove:tenant-a:archived-document',
    ]);
    expect(repository.list).toHaveBeenCalledWith('tenant-a', {
      status: 'ARCHIVED',
      limit: KNOWLEDGE_INDEX_BATCH_LIMIT,
    });
  });

  it('isolates repository and status updates to the current active tenant set', async () => {
    const documents: Record<string, readonly KnowledgeDocumentRecord[]> = {
      'tenant-a': [documentFor('tenant-a', 'document-a')],
      'tenant-b': [documentFor('tenant-b', 'document-b')],
    };
    const tenants = ['tenant-a', 'tenant-b'];
    const listApproved = vi.fn(async (tenant_id: string) => documents[tenant_id] ?? []);
    const markAvailable = vi.fn(async (
      tenant_id: string,
      document_id: string,
      _actor: KnowledgeActor,
      _expected_version: number,
    ): Promise<KnowledgeDocumentRecord> => {
      const document = documents[tenant_id]?.find((item) => item.document_id === document_id);
      if (document === undefined) throw new Error('TEST_DOCUMENT_NOT_FOUND');
      return { ...document, status: 'AVAILABLE' };
    });
    const repository: KnowledgeIndexerRepository = {
      listApproved,
      list: vi.fn(async () => EMPTY_PAGE),
      markAvailable,
    };
    const indexer = createKnowledgeIndexer({
      env: {},
      getTenantIds: () => tenants,
      repository,
      autoStart: false,
    });

    await indexer.runOnce();

    expect(listApproved.mock.calls.map(([tenant_id]) => tenant_id)).toEqual(tenants);
    expect(listApproved).toHaveBeenNthCalledWith(1, 'tenant-a', KNOWLEDGE_INDEX_BATCH_LIMIT);
    expect(listApproved).toHaveBeenNthCalledWith(2, 'tenant-b', KNOWLEDGE_INDEX_BATCH_LIMIT);
    expect(markAvailable.mock.calls.map(([tenant_id, document_id]) => [tenant_id, document_id])).toEqual([
      ['tenant-a', 'document-a'],
      ['tenant-b', 'document-b'],
    ]);
    expect(markAvailable.mock.calls.map(([, , actor]) => actor.actor_kind)).toEqual(['INDEXER', 'INDEXER']);
    expect(markAvailable.mock.calls.map(([, , actor]) => actor.actor_id))
      .toEqual(['knowledge-indexer', 'knowledge-indexer']);
  });
  it('indexes approved documents for an asynchronously discovered provisioned tenant', async () => {
    const document = documentFor('tenant-shell', 'document-shell');
    const getTenantIds = vi.fn(async () => ['tenant-shell']);
    const listApproved = vi.fn(async (tenant_id: string) => tenant_id === 'tenant-shell' ? [document] : []);
    const markAvailable = vi.fn(async (
      _tenant_id: string,
      _document_id: string,
      _actor: KnowledgeActor,
      _expected_version: number,
    ): Promise<KnowledgeDocumentRecord> => ({ ...document, status: 'AVAILABLE' }));
    const repository: KnowledgeIndexerRepository = {
      listApproved,
      list: vi.fn(async () => EMPTY_PAGE),
      markAvailable,
    };
    const indexer = createKnowledgeIndexer({
      env: {},
      getTenantIds,
      repository,
      autoStart: false,
    });

    await indexer.runOnce();

    expect(indexer.tenantIds).toEqual(['tenant-shell']);
    expect(getTenantIds).toHaveBeenCalledTimes(1);
    expect(listApproved).toHaveBeenCalledWith('tenant-shell', KNOWLEDGE_INDEX_BATCH_LIMIT);
    expect(markAvailable).toHaveBeenCalledWith(
      'tenant-shell',
      'document-shell',
      expect.objectContaining({ actor_kind: 'INDEXER', actor_id: 'knowledge-indexer' }),
      3,
    );
  });

  it('rejects Qdrant mode without a configured vector client', () => {
    expect(() => assertKnowledgeVectorClientConfigured({ KNOWLEDGE_VECTOR_INDEX: 'qdrant' }))
      .toThrow('KNOWLEDGE_VECTOR_CLIENT_REQUIRED');
    expect(() => createKnowledgeIndexer({ env: { KNOWLEDGE_VECTOR_INDEX: 'qdrant' }, autoStart: false }))
      .toThrow('KNOWLEDGE_VECTOR_CLIENT_REQUIRED');
  });

  it('uses the 15-second default interval and validates the environment override', () => {
    const repository: KnowledgeIndexerRepository = {
      listApproved: vi.fn(async () => []),
      list: vi.fn(async () => EMPTY_PAGE),
      markAvailable: vi.fn(async () => documentFor('tenant-a', 'unused')),
    };
    const defaulted = createKnowledgeIndexer({ env: {}, repository, autoStart: false });
    expect(defaulted.intervalMs).toBe(DEFAULT_KNOWLEDGE_INDEX_INTERVAL_MS);

    const configured = createKnowledgeIndexer({
      env: { KNOWLEDGE_INDEX_INTERVAL_MS: '9000' },
      repository,
      autoStart: false,
    });
    expect(configured.intervalMs).toBe(9000);
    expect(() => createKnowledgeIndexer({
      env: { KNOWLEDGE_INDEX_INTERVAL_MS: '0' },
      repository,
      autoStart: false,
    })).toThrow('KNOWLEDGE_INDEX_INTERVAL_MS_INVALID');
  });
  it('schedules tenant indexing at the configured interval and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const listApproved = vi.fn(async () => []);
      const repository: KnowledgeIndexerRepository = {
        listApproved,
        list: vi.fn(async () => EMPTY_PAGE),
        markAvailable: vi.fn(async () => documentFor('tenant-a', 'unused')),
      };
      const indexer = createKnowledgeIndexer({
        env: { KNOWLEDGE_INDEX_INTERVAL_MS: '100' },
        tenantIds: ['tenant-a'],
        repository,
      });

      await vi.advanceTimersByTimeAsync(99);
      expect(listApproved).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(listApproved).toHaveBeenCalledWith('tenant-a', KNOWLEDGE_INDEX_BATCH_LIMIT);

      await indexer.stop();
      const callsAfterStop = listApproved.mock.calls.length;
      await vi.advanceTimersByTimeAsync(200);
      expect(listApproved).toHaveBeenCalledTimes(callsAfterStop);
      expect(indexer.isRunning).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
