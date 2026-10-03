// Worker process entry (`node apps/worker/dist/index.js`).
//
// The health listener and bounded readiness gate start first; connectors and durable Care polling
// are constructed only after readiness succeeds. A tenant scope and authentic orchestrator factory
// are also required before polling; an unbound graph is logged and never consumes queued tasks.
//
// The boot module is JavaScript and is therefore imported at runtime: tsc has `rootDir: src` and
// never emits `src/server.mjs`, so the specifier is resolved from import.meta.url against the two
// layouts that actually occur (`src/index.ts` beside it, `dist/index.js` one directory below).
// Environment validation, /health, /ready, and the bounded readiness gate all stay in that module;
// this file adds no configuration logic of its own.

import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createRuntimeRedisClient } from '@agentos/core-engine';
import {
  ApprovalRepository,
  checkSchema,
  ConversationRepository,
  EvidenceRepository,
  DurableWorkflowRepository,
  getPool,
  KnowledgeRepository,
  PlatformDirectoryRepository,
  SkillCatalogRefusal,
  syncSkillCatalogAtBoot,
  withIndexerContext,
} from '@agentos/database';
import { PLATFORM_SKILL_ROWS, skillCatalogManifest } from '@agentos/skills';

import { startWorker, type WorkerHandle } from './worker.js';
import { createApprovalExpirySweeper } from './approval-expiry-sweeper.js';
import { createOutcomeWatchSweeper } from './outcome-watch-sweeper.js';
import { createTakeoverSweeper } from './takeover-sweeper.js';
import { createReconcileSweeper } from './reconcile-sweeper.js';
import { createRetryTimerSweeper } from './retry-timer-sweeper.js';
import type { KnowledgeIndexerHandle } from './knowledge-indexer.js';
import {
  assertKnowledgeVectorClientConfigured,
  createKnowledgeIndexer,
} from './knowledge-indexer.js';
import { nodeHmacSha256Hex } from './runtime/hmac.js';

/** Health server beside the TypeScript source or at `../src/server.mjs` from compiled `dist`. */
const HEALTH_MODULE_CANDIDATES: readonly string[] = ['./server.mjs', '../src/server.mjs'];
/** The worker image copies this shared probe module at its repo-relative API path. */
const API_PROBES_MODULE_CANDIDATES: readonly string[] = ['../../api/src/probes.mjs'];

interface HealthStartResult {
  readonly ok: boolean;
  readonly ready?: boolean | null;
  readonly failures?: readonly { readonly dependency: string; readonly reason: string }[];
  readonly server?: Server;
}

interface HealthModule {
  start(
    env: NodeJS.ProcessEnv,
    opts: {
      exitOnUnready: boolean;
      exitOnInvalid: boolean;
      probes?: Readonly<Record<string, unknown>>;
    },
  ): Promise<HealthStartResult>;
}

interface ProbesModule {
  readonly realProbes: Readonly<Record<string, unknown>>;
}

function resolveHealthModulePath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));

  for (const candidate of HEALTH_MODULE_CANDIDATES) {
    const candidatePath = resolve(moduleDir, candidate);
    if (existsSync(candidatePath)) return candidatePath;
  }

  throw new Error(`worker health module not found: no server.mjs relative to ${moduleDir}`);
}

function resolveApiProbesModulePath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));

  for (const candidate of API_PROBES_MODULE_CANDIDATES) {
    const candidatePath = resolve(moduleDir, candidate);
    if (existsSync(candidatePath)) return candidatePath;
  }

  throw new Error(`worker probes module not found: no probes.mjs relative to ${moduleDir}`);
}

/** Resolves once the listener is closed; idle keep-alive sockets are dropped so it cannot hang. */
function closeHealthServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return Promise.resolve();

  return new Promise<void>((closed) => {
    server.close(() => closed());
    server.closeIdleConnections();
  });
}

// Runtime-selected specifiers preserve the source/dist layouts used by local runs and Docker images.
const healthModule = (await import(pathToFileURL(resolveHealthModulePath()).href)) as HealthModule;
const probesModule = (await import(pathToFileURL(resolveApiProbesModulePath()).href)) as ProbesModule;
const health = await healthModule.start(process.env, {
  exitOnUnready: false,
  exitOnInvalid: false,
  probes: {
    ...probesModule.realProbes,
    schemaCheck: () => checkSchema(),
  },
});

if (!health.ok || health.ready !== true) {
  const codes = ['SCHEMA_BEHIND', 'PLATFORM_ROLE_MISSING'];
  const blockers = [
    ...new Set(
      (health.failures ?? []).map((failure) =>
        codes.includes(failure.reason) ? failure.reason : failure.dependency,
      ),
    ),
  ];
  process.stdout.write(
    `worker: blocker: WORKER_READINESS_FAILED: polling disabled${blockers.length > 0 ? ` (${blockers.join(', ')})` : ''}\n`,
  );
  await closeHealthServer(health.server);
  process.exitCode = 1;
} else {

  // Readiness must complete before connectors, durable bindings, and the background poller are
  // constructed. A failed gate never creates a worker or consumes queued tasks.
  try {
    await syncSkillCatalogAtBoot(skillCatalogManifest(PLATFORM_SKILL_ROWS));
  } catch (error) {
    const refusal = error instanceof SkillCatalogRefusal ? ` (${error.code} ${error.skill_id})` : '';
    process.stderr.write(`worker: FATAL: skill catalog sync refused${refusal}\n`);
    await closeHealthServer(health.server);
    process.exitCode = 1;
    throw error;
  }
  const indexerEnabled = Boolean(process.env.INDEXER_DATABASE_URL?.trim());
  if (indexerEnabled) {
    try {
      assertKnowledgeVectorClientConfigured(process.env);
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      process.stderr.write(`worker: FATAL: knowledge indexer configuration refused (${details})\n`);
      await closeHealthServer(health.server);
      process.exitCode = 1;
      throw error;
    }
  } else {
    process.stdout.write('worker: knowledge indexer disabled: INDEXER_DATABASE_URL is unset\n');
  }
  const workerId = `worker_${randomUUID().slice(0, 8)}`;
  const worker: WorkerHandle = startWorker(process.env, {
    hmac: nodeHmacSha256Hex,
    readiness: true,
    workerId,
  });

  let knowledgeIndexer: KnowledgeIndexerHandle | undefined;
  if (indexerEnabled) {
    // Knowledge indexing runs before tenant capabilities are enabled, unlike run polling.
    const knowledgeTenantDirectory = new PlatformDirectoryRepository();
    knowledgeIndexer = createKnowledgeIndexer({
      env: process.env,
      getTenantIds: async () => {
        const tenants = await knowledgeTenantDirectory.listTenants();
        const tenantIds: string[] = [];
        for (const tenant of tenants) {
          if (tenant.status !== 'SUSPENDED' && tenant.status !== 'ARCHIVED') {
            tenantIds.push(tenant.tenant_id);
          }
        }
        return tenantIds;
      },
      repository: new KnowledgeRepository({ indexerTransaction: withIndexerContext }),
    });
  }
  const recordHeartbeat = async (): Promise<void> => {
    try {
      await getPool().query(
        'INSERT INTO agentos.worker_heartbeats (worker_id, heartbeat_at) VALUES ($1, clock_timestamp()) '
          + 'ON CONFLICT (worker_id) DO UPDATE SET heartbeat_at = clock_timestamp()',
        [workerId],
      );
    } catch {
      process.stderr.write('worker heartbeat write failed\n');
    }
  };
  void recordHeartbeat();
  const heartbeatTimer = setInterval(() => { void recordHeartbeat(); }, 15_000);
  heartbeatTimer.unref();
  const approvalExpirySweeper = createApprovalExpirySweeper({
    env: process.env,
    getTenantIds: worker.getTenantIds,
    repository: new ApprovalRepository(),
  });

  const outcomeWatchSweeper = createOutcomeWatchSweeper({
    env: process.env,
    getTenantIds: worker.getTenantIds,
    repository: new EvidenceRepository(),
  });

  const workflowRepository = new DurableWorkflowRepository();
  const reconcileSweeper = createReconcileSweeper({
    env: process.env,
    getTenantIds: worker.getTenantIds,
    repository: workflowRepository,
    reconcileAction: worker.reconcileEffect,
  });
  const retryTimerSweeper = createRetryTimerSweeper({
    env: process.env,
    getTenantIds: worker.getTenantIds,
    repository: workflowRepository,
  });

  const takeoverRedis = createRuntimeRedisClient({
    host: process.env.REDIS_HOST ?? '',
    port: Number.parseInt(process.env.REDIS_PORT ?? '6379', 10),
    password: process.env.REDIS_PASSWORD ?? '',
    db: Number.parseInt(process.env.REDIS_DB ?? '0', 10),
  });
  const takeoverSweeper = createTakeoverSweeper({
    getTenantIds: worker.getTenantIds,
    repository: new ConversationRepository(),
    redis: takeoverRedis,
  });

  process.stdout.write(`worker started [${worker.dependencies.join(', ')}]\n`);
  process.stdout.write(`worker connectors reachable: ${worker.connectors.bound.join(', ') || '(none)'}\n`);
  for (const capability of worker.connectors.unbound) {
    process.stdout.write(`worker: capability not bound in this build: ${capability}\n`);
  }
  for (const blocker of worker.blockers ?? []) {
    process.stdout.write(`worker: capability not bound in this build: ${blocker}\n`);
  }

  let shuttingDown = false;

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    clearInterval(heartbeatTimer);
    shuttingDown = true;

    await approvalExpirySweeper.stop();
    await knowledgeIndexer?.stop();
    await outcomeWatchSweeper.stop();
    await retryTimerSweeper.stop();
    await reconcileSweeper.stop();
    await takeoverSweeper.stop();
    const drainResult = await worker.close();
    await takeoverRedis.quit();
    await closeHealthServer(health.server);
    process.exit(drainResult.timedOut ? 1 : 0);
  }

  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}
