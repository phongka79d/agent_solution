// Worker boot: the same configuration validation and readiness gate as the gateway, bound to
// its own health port. The validation/probe/listen handshake lives in apps/api/src/server.mjs
// so both processes share one implementation instead of drifting apart.
//
// Compose declares no healthcheck for the worker yet; the port is bound so one can be added
// without touching the image. SERVICE_NAME is not forced here: it stays whatever the
// orchestrator injects (the validator owns its default).
//
// `node apps/worker/src/server.mjs` reads WORKER_HEALTH_PORT (default 4001) and exits 1 on an
// invalid environment or when the readiness gate is still failing after READINESS_ATTEMPTS.

import { pathToFileURL } from 'node:url';

import { start as startServer } from '../../api/src/server.mjs';

export const WORKER_PORT_ENV = 'WORKER_HEALTH_PORT';
export const DEFAULT_WORKER_PORT = 4001;

/**
 * @param {Record<string, unknown>} [env]
 * @param {object} [opts] see apps/api/src/server.mjs `start`; `portEnv`/`defaultPort` may be overridden
 */
export function start(env = process.env, opts = {}) {
  return startServer(env, {
    portEnv: WORKER_PORT_ENV,
    defaultPort: DEFAULT_WORKER_PORT,
    ...opts,
  });
}

const isCli = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const result = await start(process.env, { exitOnUnready: true });
  if (!result.ok) process.exitCode = 1;
}
