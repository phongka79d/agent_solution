import { randomUUID } from 'node:crypto';

import { KnowledgeRepository } from '@agentos/database';
import type {
  KnowledgeActor,
  KnowledgeDocumentRecord,
  KnowledgePage,
  KnowledgePageQuery,
} from '@agentos/database';

export const DEFAULT_KNOWLEDGE_INDEX_INTERVAL_MS = 15_000;
export const KNOWLEDGE_INDEX_BATCH_LIMIT = 200;

const INDEXER_ACTOR_ID = 'knowledge-indexer';

export interface KnowledgeIndexerRepository {
  listApproved(tenant_id: string, limit: number): Promise<readonly KnowledgeDocumentRecord[]>;
  list(tenant_id: string, query?: KnowledgePageQuery): Promise<KnowledgePage>;
  markAvailable(
    tenant_id: string,
    document_id: string,
    indexer: KnowledgeActor,
    expected_version: number,
  ): Promise<KnowledgeDocumentRecord>;
}

/**
 * Port for a configured vector store. Implementations split document bodies into chunks and
 * upsert those chunks; the indexer owns approval ordering and tenant-scoped archive removal.
 */
export interface KnowledgeVectorClient {
  upsertDocumentChunks(tenant_id: string, document: KnowledgeDocumentRecord): Promise<void>;
  removeDocument(tenant_id: string, document_id: string): Promise<void>;
}

export interface KnowledgeIndexerOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Raw WORKER_TENANT_IDS or a parsed tenant list for tests and embedding callers. */
  readonly tenantIds?: string | readonly string[];
  /** Dynamic scope; when present, it overrides the static tenant list. */
  readonly getTenantIds?: () => readonly string[] | Promise<readonly string[]>;
  readonly repository?: KnowledgeIndexerRepository;
  readonly vectorClient?: KnowledgeVectorClient;
  readonly intervalMs?: number;
  readonly setInterval?: (handler: () => void, timeout: number) => NodeJS.Timeout;
  readonly clearInterval?: (handle: NodeJS.Timeout) => void;
  readonly onError?: (tenant_id: string, error: unknown) => void;
  readonly autoStart?: boolean;
}

export interface KnowledgeIndexerHandle {
  readonly tenantIds: readonly string[];
  readonly intervalMs: number;
  readonly isRunning: boolean;
  start(): void;
  runOnce(): Promise<void>;
  stop(): Promise<void>;
}

function parseIntervalMs(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_KNOWLEDGE_INDEX_INTERVAL_MS;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error('KNOWLEDGE_INDEX_INTERVAL_MS_INVALID: interval must be a positive integer');
  }
  const intervalMs = Number(raw);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error('KNOWLEDGE_INDEX_INTERVAL_MS_INVALID: interval must be a positive integer');
  }
  return intervalMs;
}

function resolveTenantIds(raw: string | readonly string[] | undefined, env: NodeJS.ProcessEnv): readonly string[] {
  const configured = raw ?? env.WORKER_TENANT_IDS;
  const tenantIds = typeof configured === 'string'
    ? configured.split(',').map((tenant_id) => tenant_id.trim()).filter(Boolean)
    : configured === undefined
      ? []
      : [...configured];
  return Object.freeze([...new Set(tenantIds)]);
}

function qdrantIndexEnabled(env: NodeJS.ProcessEnv): boolean {
  const mode = env.KNOWLEDGE_VECTOR_INDEX;
  if (mode === undefined || mode === '') return false;
  if (mode !== 'qdrant') throw new Error('KNOWLEDGE_VECTOR_INDEX_INVALID: expected qdrant when configured');
  return true;
}

/** Fails before worker polling starts rather than silently skipping configured vector indexing. */
export function assertKnowledgeVectorClientConfigured(
  env: NodeJS.ProcessEnv,
  vectorClient?: KnowledgeVectorClient,
): void {
  if (qdrantIndexEnabled(env) && vectorClient === undefined) {
    throw new Error('KNOWLEDGE_VECTOR_CLIENT_REQUIRED: KNOWLEDGE_VECTOR_INDEX=qdrant requires a configured vector client');
  }
}

/** Periodically publishes approved knowledge and records its audited AVAILABLE transition. */
export function createKnowledgeIndexer(options: KnowledgeIndexerOptions = {}): KnowledgeIndexerHandle {
  const env = options.env ?? process.env;
  const vectorEnabled = qdrantIndexEnabled(env);
  assertKnowledgeVectorClientConfigured(env, options.vectorClient);

  const tenantIds = resolveTenantIds(options.tenantIds, env);
  const intervalMs = options.intervalMs ?? parseIntervalMs(env.KNOWLEDGE_INDEX_INTERVAL_MS);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error('KNOWLEDGE_INDEX_INTERVAL_MS_INVALID: interval must be a positive integer');
  }

  const repository = options.repository ?? new KnowledgeRepository();
  const vectorClient = vectorEnabled ? options.vectorClient : undefined;
  const schedule = options.setInterval ?? ((handler, timeout) => setInterval(handler, timeout));
  const cancel = options.clearInterval ?? ((handle) => clearInterval(handle));
  const onError = options.onError ?? ((tenant_id, error) => {
    process.stderr.write(
      `knowledge index failed for tenant ${tenant_id}: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  });

  const reportError = (tenant_id: string, error: unknown): void => {
    try {
      onError(tenant_id, error);
    } catch {
      // A logger failure must not stop other documents or tenants from being indexed.
    }
  };

  const indexApproved = async (tenant_id: string): Promise<void> => {
    const documents = await repository.listApproved(tenant_id, KNOWLEDGE_INDEX_BATCH_LIMIT);
    for (const document of documents) {
      if (document.status !== 'APPROVED') continue;
      try {
        if (vectorClient !== undefined) {
          await vectorClient.upsertDocumentChunks(tenant_id, document);
        }
        const indexer: KnowledgeActor = {
          actor_kind: 'INDEXER',
          actor_id: INDEXER_ACTOR_ID,
          correlation_id: randomUUID(),
        };
        await repository.markAvailable(tenant_id, document.document_id, indexer, document.version);
      } catch (error) {
        reportError(tenant_id, error);
      }
    }
  };

  const removeArchived = async (tenant_id: string): Promise<void> => {
    if (vectorClient === undefined) return;
    let cursor: string | null = null;
    do {
      const pageQuery: KnowledgePageQuery = {
        status: 'ARCHIVED',
        limit: KNOWLEDGE_INDEX_BATCH_LIMIT,
        ...(cursor === null ? {} : { cursor }),
      };
      const page = await repository.list(tenant_id, pageQuery);
      for (const document of page.items) {
        try {
          await vectorClient.removeDocument(tenant_id, document.document_id);
        } catch (error) {
          reportError(tenant_id, error);
        }
      }
      cursor = page.next_cursor;
    } while (cursor !== null);
  };


  let timer: NodeJS.Timeout | null = null;
  let activeRun: Promise<void> | null = null;
  let resolvedTenantIds = tenantIds;
  const runOnce = (): Promise<void> => {
    if (activeRun !== null) return activeRun;
    const run = (async () => {
      const tenantIdsToIndex = options.getTenantIds === undefined
        ? tenantIds
        : await options.getTenantIds();
      resolvedTenantIds = tenantIdsToIndex;
      for (const tenant_id of tenantIdsToIndex) {
        try {
          await indexApproved(tenant_id);
          await removeArchived(tenant_id);
        } catch (error) {
          reportError(tenant_id, error);
        }
      }
    })();
    activeRun = run;
    void run.then(
      () => {
        if (activeRun === run) activeRun = null;
      },
      () => {
        if (activeRun === run) activeRun = null;
      },
    );
    return run;
  };

  const start = (): void => {
    if (timer !== null) return;
    timer = schedule(() => {
      void runOnce().catch(() => undefined);
    }, intervalMs);
  };

  const stop = async (): Promise<void> => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    if (activeRun !== null) await activeRun;
  };

  const handle: KnowledgeIndexerHandle = {
    get tenantIds() {
      return resolvedTenantIds;
    },
    intervalMs,
    get isRunning() {
      return timer !== null;
    },
    start,
    runOnce,
    stop,
  };

  if (options.autoStart !== false) start();
  return handle;
}

export { parseIntervalMs as parseKnowledgeIndexIntervalMs };
