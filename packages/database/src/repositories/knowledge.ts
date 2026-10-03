import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';

import { withIndexerContext, withTenantContext } from '../rls.js';
import { appendConfigAudit } from './platform-audit.js';
import type { TenantTransactionRunner } from './effect-reservations.js';

export const KNOWLEDGE_NAMESPACES = ['company', 'product', 'brand', 'marketing', 'sales', 'customer-care', 'policy'] as const;
export const KNOWLEDGE_TYPES = ['FAQ', 'SHIPPING', 'RETURNS', 'WARRANTY', 'BRAND_VOICE', 'SALES_GUIDELINE', 'MARKETING_GUIDELINE', 'AUTHORITY_POLICY'] as const;
export type KnowledgeDocumentNamespace = typeof KNOWLEDGE_NAMESPACES[number];
export type KnowledgeType = typeof KNOWLEDGE_TYPES[number];
export type KnowledgeStatus = 'DRAFT' | 'REVIEW' | 'APPROVED' | 'AVAILABLE' | 'ARCHIVED';

export interface KnowledgeActor {
  readonly actor_kind: string;
  readonly actor_id: string;
  readonly correlation_id: string;
}

export interface KnowledgeDocumentInput {
  readonly namespace: KnowledgeDocumentNamespace;
  readonly type: KnowledgeType;
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly actor: KnowledgeActor;
}

export interface KnowledgeDocumentRecord {
  readonly tenant_id: string;
  readonly document_id: string;
  readonly namespace: KnowledgeDocumentNamespace;
  readonly type: KnowledgeType;
  readonly slug: string;
  readonly version: number;
  readonly title: string;
  readonly body: string;
  readonly content_sha256: string;
  readonly data_class: 'PRODUCTION' | 'DEMO' | 'TEST';
  readonly status: KnowledgeStatus;
  readonly created_by: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface KnowledgeVersionRecord {
  readonly document_id: string;
  readonly version: number;
  readonly namespace: KnowledgeDocumentNamespace;
  readonly type: KnowledgeType;
  readonly slug: string;
  readonly title: string;
  readonly body: string;
  readonly content_sha256: string;
  readonly data_class: 'PRODUCTION' | 'DEMO' | 'TEST';
  readonly created_by: string;
  readonly created_at: string;
}

export interface KnowledgePageQuery {
  readonly namespace?: KnowledgeDocumentNamespace;
  readonly status?: KnowledgeStatus;
  readonly q?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface KnowledgePage {
  readonly items: readonly KnowledgeDocumentRecord[];
  readonly next_cursor: string | null;
}
export interface KnowledgeUsageRecord {
  readonly document_id: string;
  readonly agents: readonly string[];
  /** Skills are not retained with terminal response citations. */
  readonly skills: null;
}

export interface KnowledgeRepositoryOptions {
  readonly tenantTransaction?: TenantTransactionRunner;
  /** A dedicated transaction runner that executes as agentos_indexer. */
  readonly indexerTransaction?: TenantTransactionRunner;
}

interface KnowledgeRow extends QueryResultRow {
  tenant_id: string;
  document_id: string;
  namespace: KnowledgeDocumentNamespace;
  document_type: KnowledgeType;
  slug: string;
  current_version: string | number;
  title: string;
  body: string;
  content_sha256: string;
  data_class: 'PRODUCTION' | 'DEMO' | 'TEST';
  status: KnowledgeStatus;
  created_by: string;
  created_at: Date | string;
  updated_at: Date | string;
}

interface VersionRow extends QueryResultRow {
  document_id: string;
  version: string | number;
  namespace: KnowledgeDocumentNamespace;
  document_type: KnowledgeType;
  slug: string;
  title: string;
  body: string;
  content_sha256: string;
  data_class: 'PRODUCTION' | 'DEMO' | 'TEST';
  created_by: string;
  created_at: Date | string;
}

const VERSION_SELECT = `v.document_id::text AS document_id, v.version::text AS version,
  v.namespace, v.document_type, v.slug, v.title, v.body, rtrim(v.content_sha256) AS content_sha256,
  v.data_class::text AS data_class, v.created_by, v.created_at`;
const DOCUMENT_SELECT = `d.tenant_id::text AS tenant_id, d.document_id::text AS document_id,
  v.namespace, v.document_type, v.slug, d.current_version::text AS current_version,
  v.title, v.body, rtrim(v.content_sha256) AS content_sha256, v.data_class::text AS data_class,
  d.status, v.created_by, d.created_at, d.updated_at`;
const JOIN_CURRENT_VERSION = `FROM agentos.knowledge_documents AS d
  JOIN agentos.knowledge_document_versions AS v
    ON v.tenant_id = d.tenant_id AND v.document_id = d.document_id AND v.version = d.current_version`;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function safeVersion(value: string | number): number {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('KNOWLEDGE_VERSION_INVALID');
  return version;
}

function toDocument(row: KnowledgeRow): KnowledgeDocumentRecord {
  return {
    tenant_id: row.tenant_id,
    document_id: row.document_id,
    namespace: row.namespace,
    type: row.document_type,
    slug: row.slug,
    version: safeVersion(row.current_version),
    title: row.title,
    body: row.body,
    content_sha256: row.content_sha256.trim(),
    data_class: row.data_class,
    status: row.status,
    created_by: row.created_by,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

function toVersion(row: VersionRow): KnowledgeVersionRecord {
  return {
    document_id: row.document_id,
    version: safeVersion(row.version),
    namespace: row.namespace,
    type: row.document_type,
    slug: row.slug,
    title: row.title,
    body: row.body,
    content_sha256: row.content_sha256.trim(),
    data_class: row.data_class,
    created_by: row.created_by,
    created_at: toIso(row.created_at),
  };
}

function validateInput(input: KnowledgeDocumentInput): void {
  if (!KNOWLEDGE_NAMESPACES.includes(input.namespace) || !KNOWLEDGE_TYPES.includes(input.type)
    || typeof input.slug !== 'string' || input.slug.trim() !== input.slug || input.slug.length === 0
    || typeof input.title !== 'string' || input.title.trim() !== input.title || input.title.length === 0
    || typeof input.body !== 'string') {
    throw new TypeError('KNOWLEDGE_DOCUMENT_INVALID');
  }
  validateActor(input.actor);
}

function validateActor(actor: KnowledgeActor): void {
  if (!actor || typeof actor.actor_kind !== 'string' || actor.actor_kind.length === 0
    || typeof actor.actor_id !== 'string' || actor.actor_id.length === 0
    || typeof actor.correlation_id !== 'string' || actor.correlation_id.length === 0) {
    throw new TypeError('KNOWLEDGE_ACTOR_INVALID');
  }
}

function parseLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) throw new TypeError(`KNOWLEDGE_LIMIT_INVALID: limit must be between 1 and ${MAX_LIMIT}.`);
  return value;
}

function encodeCursor(row: KnowledgeRow): string {
  return Buffer.from(JSON.stringify([toIso(row.created_at), row.document_id])).toString('base64url');
}

function decodeCursor(cursor: string | undefined): { created_at: string; document_id: string } | null {
  if (cursor === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || typeof parsed[0] !== 'string' || typeof parsed[1] !== 'string'
      || Number.isNaN(Date.parse(parsed[0])) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parsed[1])) {
      throw new Error();
    }
    return { created_at: new Date(parsed[0]).toISOString(), document_id: parsed[1] };
  } catch {
    throw new TypeError('KNOWLEDGE_CURSOR_INVALID');
  }
}

function digest(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function auditState(document: Pick<KnowledgeDocumentRecord, 'document_id' | 'namespace' | 'type' | 'slug' | 'version' | 'content_sha256' | 'status'>): object {
  return {
    document_id: document.document_id,
    namespace: document.namespace,
    type: document.type,
    slug: document.slug,
    version: document.version,
    content_sha256: document.content_sha256,
    status: document.status,
  };
}

/** Tenant-scoped, immutable-version knowledge lifecycle and audited status transitions. */
export class KnowledgeRepository {
  private readonly runner: TenantTransactionRunner;
  private readonly indexerRunner: TenantTransactionRunner;

  constructor(options: KnowledgeRepositoryOptions = {}) {
    this.runner = options.tenantTransaction ?? withTenantContext;
    this.indexerRunner = options.indexerTransaction ?? withIndexerContext;
  }

  async create(tenant_id: string, input: KnowledgeDocumentInput): Promise<KnowledgeDocumentRecord> {
    validateInput(input);
    return this.runner(tenant_id, async (client) => {
      const inserted = await client.query<{ document_id: string }>(
        `INSERT INTO agentos.knowledge_documents (tenant_id, namespace, document_type, slug, current_version)
         VALUES ($1, $2, $3, $4, NULL) RETURNING document_id::text AS document_id`,
        [tenant_id, input.namespace, input.type, input.slug],
      );
      const document_id = inserted.rows[0]?.document_id;
      if (document_id === undefined) throw new Error('KNOWLEDGE_DOCUMENT_CREATE_FAILED');
      await this.insertVersion(client, tenant_id, document_id, 1, input);
      await client.query(
        `UPDATE agentos.knowledge_documents SET current_version = 1, updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $1 AND document_id = $2`,
        [tenant_id, document_id],
      );
      await this.insertEvent(client, tenant_id, document_id, 1, 'CREATE', null, 'DRAFT', input.actor);
      const record = await this.getInTransaction(client, tenant_id, document_id);
      if (record === null) throw new Error('KNOWLEDGE_DOCUMENT_CREATE_FAILED');
      await this.audit(client, tenant_id, 'knowledge.document.create', null, record, input.actor);
      return record;
    });
  }

  async update(tenant_id: string, document_id: string, input: KnowledgeDocumentInput): Promise<KnowledgeDocumentRecord> {
    validateInput(input);
    return this.runner(tenant_id, async (client) => {
      const current = await this.lockCurrent(client, tenant_id, document_id);
      const version = current.version + 1;
      if (!Number.isSafeInteger(version)) throw new Error('KNOWLEDGE_VERSION_EXHAUSTED');
      await this.insertVersion(client, tenant_id, document_id, version, input);
      await client.query(
        `UPDATE agentos.knowledge_documents
            SET namespace = $3, document_type = $4, slug = $5, current_version = $6,
                status = 'DRAFT', approved_by = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE tenant_id = $1 AND document_id = $2`,
        [tenant_id, document_id, input.namespace, input.type, input.slug, version],
      );
      await this.insertEvent(client, tenant_id, document_id, version, 'UPDATE', current.status, 'DRAFT', input.actor);
      const record = await this.getInTransaction(client, tenant_id, document_id);
      if (record === null) throw new Error('KNOWLEDGE_DOCUMENT_NOT_FOUND');
      await this.audit(client, tenant_id, 'knowledge.document.update', current, record, input.actor);
      return record;
    });
  }

  async submit(tenant_id: string, document_id: string, actor: KnowledgeActor): Promise<KnowledgeDocumentRecord> {
    return this.transition(tenant_id, document_id, actor, 'SUBMIT', 'REVIEW');
  }

  async approve(tenant_id: string, document_id: string, approver: KnowledgeActor): Promise<KnowledgeDocumentRecord> {
    return this.transition(tenant_id, document_id, approver, 'APPROVE', 'APPROVED');
  }

  async reject(tenant_id: string, document_id: string, actor: KnowledgeActor, reason?: string): Promise<KnowledgeDocumentRecord> {
    return this.transition(tenant_id, document_id, actor, 'REJECT', 'DRAFT', reason);
  }

  async archive(tenant_id: string, document_id: string, actor: KnowledgeActor): Promise<KnowledgeDocumentRecord> {
    return this.transition(tenant_id, document_id, actor, 'ARCHIVE', 'ARCHIVED');
  }

  async markAvailable(
    tenant_id: string,
    document_id: string,
    indexer: KnowledgeActor,
    expected_version: number,
  ): Promise<KnowledgeDocumentRecord> {
    validateActor(indexer);
    if (indexer.actor_kind !== 'INDEXER') throw new Error('KNOWLEDGE_INDEXER_REQUIRED');
    if (!Number.isSafeInteger(expected_version) || expected_version < 1) throw new Error('KNOWLEDGE_VERSION_INVALID');
    return this.transition(
      tenant_id,
      document_id,
      indexer,
      'MAKE_AVAILABLE',
      'AVAILABLE',
      null,
      this.indexerRunner,
      expected_version,
      true,
      'APPROVED',
    );
  }


  async get(tenant_id: string, document_id: string): Promise<KnowledgeDocumentRecord | null> {
    return this.runner(tenant_id, (client) => this.getInTransaction(client, tenant_id, document_id));
  }

  async versions(tenant_id: string, document_id: string): Promise<readonly KnowledgeVersionRecord[]> {
    return this.runner(tenant_id, async (client) => {
      const result = await client.query<VersionRow>(
        `SELECT ${VERSION_SELECT} FROM agentos.knowledge_document_versions AS v
          WHERE v.tenant_id = $1 AND v.document_id = $2 ORDER BY v.version DESC`,
        [tenant_id, document_id],
      );
      return result.rows.map(toVersion);
    });
  }
  async usage(tenant_id: string, document_id: string): Promise<KnowledgeUsageRecord> {
    return this.runner(tenant_id, async (client) => {
      const result = await client.query<{ agent_id: string }>(
        `SELECT DISTINCT m.sender_id AS agent_id
           FROM agentos.run_responses AS r
           JOIN agentos.conversation_messages AS m
             ON m.tenant_id = r.tenant_id AND m.id = r.message_id
           CROSS JOIN LATERAL jsonb_array_elements(r.sources) AS citation(value)
           JOIN agentos.knowledge_document_versions AS v
             ON v.tenant_id = r.tenant_id AND v.document_id = $2
            AND citation.value ->> 'source_file' = v.namespace || '/' || v.slug
            AND citation.value ->> 'source_version' = rtrim(v.content_sha256)
          WHERE r.tenant_id = $1 AND m.sender_type = 'agent'
          ORDER BY agent_id`,
        [tenant_id, document_id],
      );
      return {
        document_id,
        agents: result.rows.map((row) => row.agent_id),
        skills: null,
      };
    });
  }


  async list(tenant_id: string, query: KnowledgePageQuery = {}): Promise<KnowledgePage> {
    const limit = parseLimit(query.limit);
    const cursor = decodeCursor(query.cursor);
    return this.runner(tenant_id, async (client) => {
      const result = await client.query<KnowledgeRow>(
        `SELECT ${DOCUMENT_SELECT} ${JOIN_CURRENT_VERSION}
          WHERE d.tenant_id = $1
            AND ($2::text IS NULL OR d.namespace = $2)
            AND ($3::text IS NULL OR d.status = $3)
            AND ($4::text IS NULL OR v.title ILIKE '%' || $4 || '%' OR v.body ILIKE '%' || $4 || '%' OR v.slug ILIKE '%' || $4 || '%')
            AND ($5::timestamptz IS NULL OR (d.created_at, d.document_id) < ($5::timestamptz, $6::uuid))
          ORDER BY d.created_at DESC, d.document_id DESC LIMIT $7`,
        [tenant_id, query.namespace ?? null, query.status ?? null, query.q?.trim() || null,
          cursor?.created_at ?? null, cursor?.document_id ?? null, limit + 1],
      );
      const hasMore = result.rows.length > limit;
      const rows = hasMore ? result.rows.slice(0, limit) : result.rows;
      return {
        items: rows.map(toDocument),
        next_cursor: hasMore ? encodeCursor(rows[rows.length - 1]!) : null,
      };
    });
  }
  async listApproved(tenant_id: string, limit: number): Promise<readonly KnowledgeDocumentRecord[]> {
    const batchLimit = parseLimit(limit);
    return this.runner(tenant_id, async (client) => {
      const result = await client.query<KnowledgeRow>(
        `SELECT ${DOCUMENT_SELECT} ${JOIN_CURRENT_VERSION}
          WHERE d.tenant_id = $1 AND d.status = 'APPROVED'
          ORDER BY d.created_at ASC, d.document_id ASC LIMIT $2`,
        [tenant_id, batchLimit],
      );
      return result.rows.map(toDocument);
    });
  }


  async listAvailable(tenant_id: string, namespace: KnowledgeDocumentNamespace): Promise<readonly {
    readonly document_id: string;
    readonly version: number;
    readonly content_sha256: string;
    readonly body: string;
    readonly slug: string;
    readonly namespace: KnowledgeDocumentNamespace;
  }[]> {
    if (!KNOWLEDGE_NAMESPACES.includes(namespace)) throw new TypeError('KNOWLEDGE_NAMESPACE_INVALID');
    return this.runner(tenant_id, async (client) => {
      const result = await client.query<KnowledgeRow>(
        `SELECT ${DOCUMENT_SELECT} ${JOIN_CURRENT_VERSION}
          WHERE d.tenant_id = $1 AND d.namespace = $2 AND d.status = 'AVAILABLE'
          ORDER BY d.document_id`,
        [tenant_id, namespace],
      );
      return result.rows.map((row) => ({
        document_id: row.document_id,
        version: safeVersion(row.current_version),
        content_sha256: row.content_sha256.trim(),
        body: row.body,
        slug: row.slug,
        namespace: row.namespace,
      }));
    });
  }

  private async transition(
    tenant_id: string,
    document_id: string,
    actor: KnowledgeActor,
    action: 'SUBMIT' | 'APPROVE' | 'REJECT' | 'ARCHIVE' | 'MAKE_AVAILABLE',
    nextStatus: KnowledgeStatus,
    reason: string | null = null,
    runner: TenantTransactionRunner = this.runner,
    expectedVersion?: number,
    idempotent?: boolean,
    expectedFromStatus?: KnowledgeStatus,
  ): Promise<KnowledgeDocumentRecord> {
    validateActor(actor);
    return runner(tenant_id, async (client) => {
      const before = await this.lockCurrent(client, tenant_id, document_id);
      if (expectedVersion !== undefined && before.version !== expectedVersion) {
        throw new Error('KNOWLEDGE_VERSION_CONFLICT');
      }
      if (idempotent && before.status === nextStatus) return before;
      if (expectedFromStatus !== undefined && before.status !== expectedFromStatus) {
        throw new Error('KNOWLEDGE_STATUS_TRANSITION_INVALID');
      }
      if (before.status === nextStatus) throw new Error('KNOWLEDGE_STATUS_TRANSITION_INVALID');
      if (nextStatus === 'APPROVED') {
        await client.query(
          `UPDATE agentos.knowledge_documents
              SET status = $3, approved_by = $4, updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id = $1 AND document_id = $2`,
          [tenant_id, document_id, nextStatus, actor.actor_id],
        );
      } else {
        await client.query(
          `UPDATE agentos.knowledge_documents
              SET status = $3, updated_at = CURRENT_TIMESTAMP
            WHERE tenant_id = $1 AND document_id = $2`,
          [tenant_id, document_id, nextStatus],
        );
      }
      const after = await this.getInTransaction(client, tenant_id, document_id);
      if (after === null) throw new Error('KNOWLEDGE_DOCUMENT_NOT_FOUND');
      await this.insertEvent(client, tenant_id, document_id, after.version, action, before.status, nextStatus, actor);
      await this.audit(client, tenant_id, `knowledge.document.${action.toLowerCase()}`, before, after, actor, reason);
      return after;
    });
  }

  private async insertVersion(client: PoolClient, tenant_id: string, document_id: string, version: number, input: KnowledgeDocumentInput): Promise<void> {
    const result = await client.query<{ readonly content_sha256: string }>(
      `INSERT INTO agentos.knowledge_document_versions (
         tenant_id, document_id, version, namespace, document_type, slug, title, body,
         content_sha256, data_class, created_by
       )
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, t.data_class, $10
         FROM agentos.tenants AS t WHERE t.tenant_id = $1
       RETURNING rtrim(content_sha256) AS content_sha256`,
      [tenant_id, document_id, version, input.namespace, input.type, input.slug, input.title,
        input.body, digest(input.body), input.actor.actor_id],
    );
    if (result.rows[0] === undefined) throw new Error('KNOWLEDGE_TENANT_NOT_FOUND');
  }

  private async lockCurrent(client: PoolClient, tenant_id: string, document_id: string): Promise<KnowledgeDocumentRecord> {
    const result = await client.query<KnowledgeRow>(
      `SELECT ${DOCUMENT_SELECT} ${JOIN_CURRENT_VERSION}
        WHERE d.tenant_id = $1 AND d.document_id = $2 FOR UPDATE OF d`,
      [tenant_id, document_id],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('KNOWLEDGE_DOCUMENT_NOT_FOUND');
    return toDocument(row);
  }

  private async getInTransaction(client: PoolClient, tenant_id: string, document_id: string): Promise<KnowledgeDocumentRecord | null> {
    const result = await client.query<KnowledgeRow>(
      `SELECT ${DOCUMENT_SELECT} ${JOIN_CURRENT_VERSION}
        WHERE d.tenant_id = $1 AND d.document_id = $2`,
      [tenant_id, document_id],
    );
    const row = result.rows[0];
    return row === undefined ? null : toDocument(row);
  }


  private async insertEvent(
    client: PoolClient,
    tenant_id: string,
    document_id: string,
    version: number,
    action: 'CREATE' | 'UPDATE' | 'SUBMIT' | 'APPROVE' | 'REJECT' | 'ARCHIVE' | 'MAKE_AVAILABLE',
    fromStatus: KnowledgeStatus | null,
    toStatus: KnowledgeStatus,
    actor: KnowledgeActor,
  ): Promise<void> {
    await client.query(
      `INSERT INTO agentos.knowledge_document_events (
         tenant_id, document_id, version, action, from_status, to_status,
         actor_kind, actor_id, correlation_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [tenant_id, document_id, version, action, fromStatus, toStatus,
        actor.actor_kind, actor.actor_id, actor.correlation_id],
    );
  }

  private async audit(
    client: PoolClient,
    tenant_id: string,
    action: string,
    before: KnowledgeDocumentRecord | null,
    after: KnowledgeDocumentRecord,
    actor: KnowledgeActor,
    reason: string | null = null,
  ): Promise<void> {
    await appendConfigAudit(client, {
      actor_kind: actor.actor_kind,
      actor_id: actor.actor_id,
      scope: 'COMPANY',
      action,
      target_tenant: tenant_id,
      target: `knowledge_documents/${after.document_id}`,
      outcome: 'ACCEPTED',
      reason,
      before: before === null ? null : auditState(before),
      after: auditState(after),
      correlation_id: actor.correlation_id,
    });
  }
}
