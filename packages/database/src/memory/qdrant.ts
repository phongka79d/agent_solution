import type {
  CustomerKnowledgeFilterInput,
  KnowledgeDocumentStatus,
  KnowledgeNamespace,
  OrganizationalKnowledgeFilterInput,
  QdrantFieldCondition,
  QdrantFilter,
} from '../contracts/index.js';

/**
 * Qdrant collection holding the approved Second Brain knowledge base.
 */
export const SECOND_BRAIN_COLLECTION = 'second_brain_knowledge';

/**
 * The eight Second Brain namespaces a chunk can belong to.
 */
export const KNOWLEDGE_NAMESPACES: ReadonlyArray<KnowledgeNamespace> = [
  'company',
  'customer',
  'product',
  'brand',
  'marketing',
  'sales',
  'customer-care',
  'policy',
];

/**
 * Payload fields indexed in Qdrant so tenant isolation and approval filtering stay
 * sub-millisecond.
 */
export const KNOWLEDGE_PAYLOAD_INDEXES: ReadonlyArray<string> = [
  'tenant_id',
  'namespace',
  'document_status',
  'file_path',
];

/**
 * Only approved documents are retrievable by an agent: drafts and review copies stay
 * out of the retrieval context (anti-hallucination rule).
 */
export const APPROVED_DOCUMENT_STATUS: KnowledgeDocumentStatus = 'approved';

/**
 * Builds one `must` condition.
 */
function knowledgeCondition(key: string, value: string): QdrantFieldCondition {
  return { key, match: { value } };
}

/**
 * Refuses a filter that would search every tenant's knowledge.
 */
function assertTenantScope(tenantId: string): void {
  if (tenantId.trim().length === 0) {
    throw new Error(
      'TENANT_CONTEXT_REQUIRED: refusing to build a knowledge filter without a tenant id (NFR-006).',
    );
  }
}

/**
 * Refuses a customer-namespace filter that is not scoped to one customer.
 */
function assertCustomerScope(customerId: string): void {
  if (customerId.trim().length === 0) {
    throw new Error(
      'CUSTOMER_CONTEXT_REQUIRED: refusing to build a customer knowledge filter without a customer id.',
    );
  }
}

/**
 * Refuses a namespace outside the eight-folder hierarchy.
 */
function assertKnowledgeNamespace(namespace: KnowledgeNamespace): void {
  if (!KNOWLEDGE_NAMESPACES.includes(namespace)) {
    throw new Error(
      `KNOWLEDGE_NAMESPACE_INVALID: '${namespace}' is not one of the eight Second Brain namespaces (${KNOWLEDGE_NAMESPACES.join(', ')}).`,
    );
  }
}

/**
 * Builds the filter for organizational knowledge retrieval.
 *
 * Every condition is mandatory: the tenant must match, the namespace must match, and
 * only `approved` documents are returned, so an unapproved draft can never reach an
 * agent's context.
 *
 * @param input - Tenant and namespace being searched.
 * @param input.tenantId - Authenticated tenant UUID.
 * @param input.namespace - One of the eight Second Brain namespaces.
 * @returns The Qdrant filter, always including `tenant_id` and `document_status = approved`.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank.
 * @throws Error `KNOWLEDGE_NAMESPACE_INVALID` when `namespace` is not one of the eight folders.
 */
export function buildOrganizationalKnowledgeFilter(
  input: OrganizationalKnowledgeFilterInput,
): QdrantFilter {
  assertTenantScope(input.tenantId);
  assertKnowledgeNamespace(input.namespace);

  return {
    must: [
      knowledgeCondition('tenant_id', input.tenantId),
      knowledgeCondition('namespace', input.namespace),
      knowledgeCondition('document_status', APPROVED_DOCUMENT_STATUS),
    ],
  };
}

/**
 * Builds the filter for customer-scoped knowledge retrieval: the organizational
 * filter plus the `customer_id` binding, so one customer's chunks can never ground a
 * reply to another.
 *
 * @param input - Tenant, customer and namespace being searched.
 * @param input.tenantId - Authenticated tenant UUID.
 * @param input.customerId - Customer the knowledge belongs to.
 * @param input.namespace - One of the eight Second Brain namespaces.
 * @returns The Qdrant filter, always including `tenant_id`, `customer_id` and `document_status = approved`.
 * @throws Error `TENANT_CONTEXT_REQUIRED` when `tenantId` is blank.
 * @throws Error `CUSTOMER_CONTEXT_REQUIRED` when `customerId` is blank.
 * @throws Error `KNOWLEDGE_NAMESPACE_INVALID` when `namespace` is not one of the eight folders.
 */
export function buildCustomerKnowledgeFilter(
  input: CustomerKnowledgeFilterInput,
): QdrantFilter {
  assertTenantScope(input.tenantId);
  assertCustomerScope(input.customerId);
  assertKnowledgeNamespace(input.namespace);

  return {
    must: [
      knowledgeCondition('tenant_id', input.tenantId),
      knowledgeCondition('namespace', input.namespace),
      knowledgeCondition('document_status', APPROVED_DOCUMENT_STATUS),
      knowledgeCondition('customer_id', input.customerId),
    ],
  };
}
