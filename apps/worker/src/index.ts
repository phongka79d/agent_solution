// Worker process entry (`node apps/worker/dist/index.js`).
//
// The durable worker starts first and stays the reason this process exists; the health listener
// from apps/worker/src/server.mjs runs alongside it on WORKER_HEALTH_PORT (default 4001) so an
// orchestrator can probe the container. Both are closed on SIGINT/SIGTERM.
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

import { startWorker, type WorkerHandle } from './worker.js';

/** `./server.mjs` beside the TypeScript source, `../src/server.mjs` from the compiled `dist`. */
const HEALTH_MODULE_CANDIDATES: readonly string[] = ['./server.mjs', '../src/server.mjs'];

interface HealthStartResult {
  readonly ok: boolean;
  readonly server?: Server;
}

interface HealthModule {
  start(env: NodeJS.ProcessEnv, opts: { exitOnUnready: boolean }): Promise<HealthStartResult>;
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

const worker: WorkerHandle = startWorker();

process.stdout.write(`worker started [${worker.dependencies.join(', ')}]\n`);

// Runtime-selected specifier, so a static import cannot express it: tsc must not emit or copy
// `src/server.mjs`, and the file is not at the same relative path in `dist/index.js`.
const healthModule = (await import(pathToFileURL(resolveHealthModulePath()).href)) as HealthModule;
const health = await healthModule.start(process.env, { exitOnUnready: true });

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  await closeHealthServer(health.server);
  await worker.close();
  process.exit(0);
}

process.once('SIGINT', () => {
  void shutdown();
});
process.once('SIGTERM', () => {
  void shutdown();
});

// The boot module exits on its own; this keeps a non-exiting return from reporting success.
if (!health.ok) process.exitCode = 1;
