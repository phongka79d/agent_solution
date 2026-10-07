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
import type { Server } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ApprovalRepository } from '@agentos/database';

import { startWorker, type WorkerHandle } from './worker.js';
import { createApprovalExpirySweeper } from './approval-expiry-sweeper.js';
import { nodeHmacSha256Hex } from './runtime/hmac.js';

/** `./server.mjs` beside the TypeScript source, `../src/server.mjs` from the compiled `dist`. */
const HEALTH_MODULE_CANDIDATES: readonly string[] = ['./server.mjs', '../src/server.mjs'];

interface HealthStartResult {
  readonly ok: boolean;
  readonly ready?: boolean | null;
  readonly failures?: readonly { readonly dependency: string; readonly reason: string }[];
  readonly server?: Server;
}

interface HealthModule {
  start(env: NodeJS.ProcessEnv, opts: { exitOnUnready: boolean; exitOnInvalid: boolean }): Promise<HealthStartResult>;
}

function resolveHealthModulePath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));

  for (const candidate of HEALTH_MODULE_CANDIDATES) {
    const candidatePath = resolve(moduleDir, candidate);
    if (existsSync(candidatePath)) return candidatePath;
  }

  throw new Error(`worker health module not found: no server.mjs relative to ${moduleDir}`);
}

/** Resolves once the listener is closed; idle keep-alive sockets are dropped so it cannot hang. */
function closeHealthServer(server: Server | undefined): Promise<void> {
  if (server === undefined || !server.listening) return Promise.resolve();

  return new Promise<void>((closed) => {
    server.close(() => closed());
    server.closeIdleConnections();
  });
}

// Runtime-selected specifier, so a static import cannot express it: tsc must not emit or copy
// `src/server.mjs`, and the file is not at the same relative path in `dist/index.js`.
const healthModule = (await import(pathToFileURL(resolveHealthModulePath()).href)) as HealthModule;
const health = await healthModule.start(process.env, { exitOnUnready: false, exitOnInvalid: false });

if (!health.ok || health.ready !== true) {
  const dependencies = [...new Set((health.failures ?? []).map((failure) => failure.dependency))];
  process.stdout.write(
    `worker: blocker: WORKER_READINESS_FAILED: polling disabled${
      dependencies.length > 0 ? ` (${dependencies.join(', ')})` : ''
    }\n`,
  );
  await closeHealthServer(health.server);
  process.exitCode = 1;
} else {
  const tenantIds: readonly string[] = typeof process.env.WORKER_TENANT_IDS === 'string'
    ? Object.freeze([...new Set(process.env.WORKER_TENANT_IDS.split(',').map((id) => id.trim()).filter(Boolean))])
    : Object.freeze([]);

  // Readiness must complete before connectors, durable bindings, and the background poller are
  // constructed. A failed gate never creates a worker or consumes queued tasks.
  const worker: WorkerHandle = startWorker(process.env, {
    hmac: nodeHmacSha256Hex,
    readiness: true,
    tenantIds,
  });
  const approvalExpirySweeper = createApprovalExpirySweeper({
    env: process.env,
    tenantIds,
    repository: new ApprovalRepository(),
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
    shuttingDown = true;

    await approvalExpirySweeper.stop();
    const drainResult = await worker.close();
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
