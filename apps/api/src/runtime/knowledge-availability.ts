import type { KnowledgeRepository } from '@agentos/database';

export type KnowledgeNamespace = 'customer-care' | 'brand';
export type KnowledgeAvailabilityRepository = Pick<KnowledgeRepository, 'listAvailable'>;

/**
 * An AI domain is ready only when the tenant has an indexed document in that domain's namespace.
 * The repository enforces tenant scope and selects only documents whose status is AVAILABLE.
 */
export async function knowledgeAvailable(
  repository: KnowledgeAvailabilityRepository | undefined,
  tenant_id: string,
  namespace: KnowledgeNamespace,
): Promise<boolean> {
  if (repository === undefined || tenant_id.trim().length === 0) return false;
  try {
    return (await repository.listAvailable(tenant_id, namespace)).length > 0;
  } catch {
    return false;
  }
}
