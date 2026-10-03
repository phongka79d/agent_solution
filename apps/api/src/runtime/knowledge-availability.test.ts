import { describe, expect, it, vi } from 'vitest';

import type { KnowledgeDocumentNamespace } from '@agentos/database';

import { knowledgeAvailable } from './knowledge-availability.js';

const TENANT = 'tenant-knowledge-availability';

describe('knowledgeAvailable', () => {
  it('requires a tenant-scoped AVAILABLE document in the requested namespace', async () => {
    const listAvailable = vi.fn(async (_tenant_id: string, namespace: KnowledgeDocumentNamespace) => [{
      document_id: 'document-1',
      version: 1,
      content_sha256: 'sha256',
      body: 'Approved content',
      slug: 'approved-content',
      namespace,
    }]);

    await expect(knowledgeAvailable({ listAvailable }, TENANT, 'customer-care')).resolves.toBe(true);
    expect(listAvailable).toHaveBeenCalledWith(TENANT, 'customer-care');
  });

  it('does not satisfy a prerequisite when no AVAILABLE documents exist', async () => {
    const listAvailable = vi.fn(async (_tenant_id: string, _namespace: KnowledgeDocumentNamespace) => []);

    await expect(knowledgeAvailable({ listAvailable }, TENANT, 'brand')).resolves.toBe(false);
  });

  it('fails closed when the repository is unavailable', async () => {
    const listAvailable = vi.fn(async (_tenant_id: string, _namespace: KnowledgeDocumentNamespace) => {
      throw new Error('repository unavailable');
    });

    await expect(knowledgeAvailable({ listAvailable }, TENANT, 'brand')).resolves.toBe(false);
    await expect(knowledgeAvailable(undefined, TENANT, 'brand')).resolves.toBe(false);
  });
});
