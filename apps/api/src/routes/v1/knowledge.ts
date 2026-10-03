import type { FastifyInstance, FastifyRequest } from 'fastify';

import {
  KNOWLEDGE_NAMESPACES,
  KNOWLEDGE_TYPES,
  type KnowledgeActor,
  type KnowledgeDocumentInput,
  type KnowledgeDocumentNamespace,
  type KnowledgeRepository,
  type KnowledgeStatus,
  type KnowledgeType,
} from '@agentos/database';
import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import { correlationIdOf, fail } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';

const MAX_MARKDOWN_BYTES = 64 * 1024;
const STATUSES: readonly KnowledgeStatus[] = ['DRAFT', 'REVIEW', 'APPROVED', 'AVAILABLE', 'ARCHIVED'];
const REPOSITORY_VALIDATION_ERRORS: Readonly<Record<string, true>> = {
  KNOWLEDGE_DOCUMENT_INVALID: true,
  KNOWLEDGE_ACTOR_INVALID: true,
  KNOWLEDGE_LIMIT_INVALID: true,
  KNOWLEDGE_CURSOR_INVALID: true,
  KNOWLEDGE_NAMESPACE_INVALID: true,
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BODY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['namespace', 'type'],
  properties: {
    namespace: { type: 'string', enum: [...KNOWLEDGE_NAMESPACES] },
    type: { type: 'string', enum: [...KNOWLEDGE_TYPES] },
    slug: { type: 'string', minLength: 1, maxLength: 160 },
    title: { type: 'string', minLength: 1, maxLength: 240 },
    body: { type: 'string' },
    filename: { type: 'string', minLength: 1, maxLength: 255 },
    content: { type: 'string' },
  },
} as const;
const ID_PARAMS_SCHEMA = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;
const LIST_QUERY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    namespace: { type: 'string', enum: [...KNOWLEDGE_NAMESPACES] },
    status: { type: 'string', enum: [...STATUSES] },
    q: { type: 'string' },
    cursor: { type: 'string' },
    limit: { type: 'string', pattern: '^[1-9][0-9]*$' },
  },
} as const;

interface RouteDependencies {
  readonly runtime: GatewayRuntime;
  readonly credentials: CredentialStore;
  readonly knowledge: KnowledgeRepository;
}

interface IdParams { readonly id: string }
interface DocumentBody {
  readonly namespace?: unknown;
  readonly type?: unknown;
  readonly slug?: unknown;
  readonly title?: unknown;
  readonly body?: unknown;
  readonly filename?: unknown;
  readonly content?: unknown;
}
interface RejectBody { readonly reason?: unknown }
interface DocumentsQuery {
  readonly namespace?: unknown;
  readonly status?: unknown;
  readonly q?: unknown;
  readonly cursor?: unknown;
  readonly limit?: unknown;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function documentId(request: FastifyRequest<{ Params: IdParams }>): string {
  const id = request.params.id;
  if (!UUID.test(id)) fail('VALIDATION_FAILED', 'document id must be a UUID');
  return id;
}

function actor(request: FastifyRequest, runtime: GatewayRuntime): KnowledgeActor {
  const principal = requireOperator(request, 'knowledge:manage');
  return {
    actor_kind: 'OPERATOR',
    actor_id: principal.operator_id!,
    correlation_id: correlationIdOf(request, runtime),
  };
}

function mapRepositoryError(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (message === 'KNOWLEDGE_DOCUMENT_NOT_FOUND') fail('NOT_FOUND', 'knowledge document was not found');
  if (message === 'KNOWLEDGE_STATUS_TRANSITION_INVALID'
    || message === 'knowledge approval requires a distinct approver') {
    fail('VERSION_CONFLICT', message === 'knowledge approval requires a distinct approver'
      ? 'a different operator must approve this knowledge document'
      : 'knowledge document status no longer permits this transition');
  }
  if (REPOSITORY_VALIDATION_ERRORS[message] === true) {
    fail('VALIDATION_FAILED', 'knowledge document request is invalid');
  }
  throw error;
}

async function callRepository<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    mapRepositoryError(error);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail('VALIDATION_FAILED', `${field} is required`);
  return value;
}

function contentFrom(body: DocumentBody): string {
  const hasBody = typeof body.body === 'string';
  const hasUpload = body.content !== undefined || body.filename !== undefined;
  if (hasBody === hasUpload) fail('VALIDATION_FAILED', 'provide either body or filename and content');
  let content: string;
  if (hasBody) {
    content = body.body as string;
  } else {
    const filename = requiredString(body.filename, 'filename');
    if (/[\\/]/.test(filename) || filename.includes('..') || !/\.(?:md|txt)$/i.test(filename)) {
      fail('VALIDATION_FAILED', 'filename must be a .md or .txt file name');
    }
    if (typeof body.content !== 'string') fail('VALIDATION_FAILED', 'content is required for an uploaded file');
    content = body.content;
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_MARKDOWN_BYTES) {
    fail('VALIDATION_FAILED', 'knowledge markdown content must not exceed 64 KB');
  }
  return content;
}

function filenameMetadata(filename: unknown): { slug: string; title: string } {
  if (typeof filename !== 'string') return { slug: '', title: '' };
  const name = filename.replace(/\.(?:md|txt)$/i, '');
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 160);
  const title = name.replace(/[-_]+/g, ' ').trim().slice(0, 240);
  return { slug, title };
}

function inputOf(body: DocumentBody, fallback?: { namespace: KnowledgeDocumentNamespace; type: KnowledgeType; slug: string; title: string }): Omit<KnowledgeDocumentInput, 'actor'> {
  if (!object(body)) fail('VALIDATION_FAILED', 'knowledge document body must be an object');
  const metadata = filenameMetadata(body.filename);
  const namespace = body.namespace ?? fallback?.namespace;
  const type = body.type ?? fallback?.type;
  const slug = body.slug ?? (metadata.slug || fallback?.slug);
  const title = body.title ?? (metadata.title || fallback?.title);
  if (typeof namespace !== 'string' || !KNOWLEDGE_NAMESPACES.includes(namespace as KnowledgeDocumentNamespace)) {
    fail('VALIDATION_FAILED', 'namespace is invalid');
  }
  if (typeof type !== 'string' || !KNOWLEDGE_TYPES.includes(type as KnowledgeType)) fail('VALIDATION_FAILED', 'type is invalid');
  return {
    namespace: namespace as KnowledgeDocumentNamespace,
    type: type as KnowledgeType,
    slug: requiredString(slug, 'slug'),
    title: requiredString(title, 'title'),
    body: contentFrom(body),
  };
}

function queryString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') fail('VALIDATION_FAILED', `${field} must be a single string`);
  return value;
}

function pageQuery(query: DocumentsQuery) {
  const namespace = queryString(query.namespace, 'namespace');
  const status = queryString(query.status, 'status');
  const q = queryString(query.q, 'q');
  const cursor = queryString(query.cursor, 'cursor');
  const limitText = queryString(query.limit, 'limit');
  if (namespace !== undefined && !KNOWLEDGE_NAMESPACES.includes(namespace as KnowledgeDocumentNamespace)) {
    fail('VALIDATION_FAILED', 'namespace filter is invalid');
  }
  if (status !== undefined && !STATUSES.includes(status as KnowledgeStatus)) fail('VALIDATION_FAILED', 'status filter is invalid');
  let limit: number | undefined;
  if (limitText !== undefined) {
    limit = Number(limitText);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail('VALIDATION_FAILED', 'limit must be between 1 and 200');
  }
  return {
    ...(namespace === undefined ? {} : { namespace: namespace as KnowledgeDocumentNamespace }),
    ...(status === undefined ? {} : { status: status as KnowledgeStatus }),
    ...(q === undefined ? {} : { q }),
    ...(cursor === undefined ? {} : { cursor }),
    ...(limit === undefined ? {} : { limit }),
  };
}

export function registerKnowledgeRoutes(app: FastifyInstance, deps: RouteDependencies): void {
  const preHandler = authenticate(deps);
  const base = '/knowledge/documents';

  app.get<{ Querystring: DocumentsQuery }>(base, {
    preHandler,
    schema: { tags: ['Knowledge'], summary: 'List knowledge documents', querystring: LIST_QUERY_SCHEMA },
  }, async (request) => {
    const principal = requireOperator(request, 'knowledge:manage');
    return callRepository(() => deps.knowledge.list(principal.tenant_id, pageQuery(request.query)));
  });

  app.post<{ Body: DocumentBody }>(base, {
    preHandler,
    schema: { tags: ['Knowledge'], summary: 'Create a draft knowledge document', body: BODY_SCHEMA },
  }, async (request, reply) => {
    const principal = requireOperator(request, 'knowledge:manage');
    const data = inputOf(request.body, undefined);
    const result = await callRepository(() => deps.knowledge.create(principal.tenant_id, { ...data, actor: actor(request, deps.runtime) }));
    return reply.code(201).send(result);
  });

  app.get<{ Params: IdParams }>(`${base}/:id`, {
    preHandler,
    schema: { tags: ['Knowledge'], summary: 'Get a knowledge document', params: ID_PARAMS_SCHEMA },
  }, async (request) => {
    const principal = requireOperator(request, 'knowledge:manage');
    const record = await callRepository(() => deps.knowledge.get(principal.tenant_id, documentId(request)));
    if (record === null) fail('NOT_FOUND', 'knowledge document was not found');
    return record;
  });

  app.put<{ Params: IdParams; Body: DocumentBody }>(`${base}/:id`, {
    preHandler,
    schema: { tags: ['Knowledge'], summary: 'Create a new knowledge document version', params: ID_PARAMS_SCHEMA, body: BODY_SCHEMA },
  }, async (request) => {
    const principal = requireOperator(request, 'knowledge:manage');
    const id = documentId(request);
    const current = await callRepository(() => deps.knowledge.get(principal.tenant_id, id));
    if (current === null) fail('NOT_FOUND', 'knowledge document was not found');
    const data = inputOf(request.body, current);
    return callRepository(() => deps.knowledge.update(principal.tenant_id, id, { ...data, actor: actor(request, deps.runtime) }));
  });

  app.post<{ Params: IdParams }>(`${base}/:id/submit`, {
    preHandler,
    schema: { tags: ['Knowledge'], summary: 'Submit a knowledge document for review', params: ID_PARAMS_SCHEMA },
  }, async (request) => {
    const principal = requireOperator(request, 'knowledge:manage');
    return callRepository(() => deps.knowledge.submit(principal.tenant_id, documentId(request), actor(request, deps.runtime)));
  });

  app.post<{ Params: IdParams }>(`${base}/:id/approve`, {
    preHandler,
    schema: { tags: ['Knowledge'], summary: 'Approve a knowledge document', params: ID_PARAMS_SCHEMA },
  }, async (request) => {
    const principal = requireOperator(request, 'knowledge:approve');
    const knowledgeActor: KnowledgeActor = {
      actor_kind: 'OPERATOR',
      actor_id: principal.operator_id!,
      correlation_id: correlationIdOf(request, deps.runtime),
    };
    return callRepository(() => deps.knowledge.approve(principal.tenant_id, documentId(request), knowledgeActor));
  });

  app.post<{ Params: IdParams; Body: RejectBody }>(`${base}/:id/reject`, {
    preHandler,
    schema: { tags: ['Knowledge'], summary: 'Reject a knowledge document', params: ID_PARAMS_SCHEMA },
  }, async (request) => {
    const principal = requireOperator(request, 'knowledge:manage');
    const reason = request.body?.reason;
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 1000)) {
      fail('VALIDATION_FAILED', 'reason must be a string no longer than 1000 characters');
    }
    return callRepository(() => deps.knowledge.reject(
      principal.tenant_id,
      documentId(request),
      actor(request, deps.runtime),
      reason as string | undefined,
    ));
  });

  app.post<{ Params: IdParams }>(`${base}/:id/archive`, {
    preHandler,
    schema: { tags: ['Knowledge'], summary: 'Archive a knowledge document', params: ID_PARAMS_SCHEMA },
  }, async (request) => {
    const principal = requireOperator(request, 'knowledge:manage');
    return callRepository(() => deps.knowledge.archive(principal.tenant_id, documentId(request), actor(request, deps.runtime)));
  });

  app.get<{ Params: IdParams }>(`${base}/:id/versions`, {
    preHandler,
    schema: { tags: ['Knowledge'], summary: 'List knowledge document versions', params: ID_PARAMS_SCHEMA },
  }, async (request) => {
    const principal = requireOperator(request, 'knowledge:manage');
    const id = documentId(request);
    const record = await callRepository(() => deps.knowledge.get(principal.tenant_id, id));
    if (record === null) fail('NOT_FOUND', 'knowledge document was not found');
    return callRepository(() => deps.knowledge.versions(principal.tenant_id, id));
  });

  app.get<{ Params: IdParams }>(`${base}/:id/usage`, {
    preHandler,
    schema: { tags: ['Knowledge'], summary: 'Get knowledge document usage', params: ID_PARAMS_SCHEMA },
  }, async (request) => {
    const principal = requireOperator(request, 'knowledge:manage');
    const id = documentId(request);
    const record = await callRepository(() => deps.knowledge.get(principal.tenant_id, id));
    if (record === null) fail('NOT_FOUND', 'knowledge document was not found');
    return callRepository(() => deps.knowledge.usage(principal.tenant_id, id));
  });
}
