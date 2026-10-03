import {
  KnowledgeRepository,
  type KnowledgeDocumentNamespace,
} from '@agentos/database';

export interface AvailableKnowledgeDocument {
  readonly document_id: string;
  readonly version: number;
  readonly content_sha256: string;
  readonly body: string;
  readonly slug: string;
  readonly namespace: KnowledgeDocumentNamespace;
}

/** Tenant-scoped view of the current, AVAILABLE knowledge revisions. */
export class KnowledgeStore {
  constructor(
    private readonly repository: Pick<KnowledgeRepository, 'listAvailable'> = new KnowledgeRepository(),
  ) {}

  listAvailable(
    tenant_id: string,
    namespace: KnowledgeDocumentNamespace,
  ): Promise<readonly AvailableKnowledgeDocument[]> {
    return this.repository.listAvailable(tenant_id, namespace);
  }
}
