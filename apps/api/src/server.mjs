// API gateway boot: environment validation, liveness, and the dependency readiness gate.
//
// Boot scaffolding only — this process deliberately serves no business routes, so every path
// other than /health and /ready is 404 until the /api/v1 slice lands. Startup order is fixed:
//
//   1. parseEnvironment      (no socket, no probe)
//   2. listen                (/health answers while dependencies are still unproven)
//   3. bounded readiness loop (READINESS_ATTEMPTS x READINESS_INTERVAL_MS, then exit 1)
//
// `start(env, opts)` is the testable entry point: probes and the two exit policies are
// injectable, so a test never needs a live postgres/redis/qdrant/mock-ERP, and a test that
// sets `exitOnUnready: false` keeps the returned server listening.
//
// The worker image reuses this module (`apps/worker/src/server.mjs` passes its own port
// variable), so it is the single implementation of the validation/readiness handshake.

import http from 'node:http';
import { pathToFileURL } from 'node:url';

import { parseEnvironment, validateEnvironment } from '../../../packages/core-engine/src/config/env.validator.mjs';
import { checkReadiness, requiredDependencies } from '../../../packages/core-engine/src/config/readiness.mjs';
import { realProbes } from './probes.mjs';

export const DEFAULT_PORT = 4000;
export const DEFAULT_HOST = '0.0.0.0';
export const DEFAULT_READINESS_ATTEMPTS = 5;
export const DEFAULT_READINESS_INTERVAL_MS = 1000;

const DEFAULT_PORT_ENV = 'PORT';

function readEnv(env, key) {
  return env && typeof env === 'object' ? env[key] : undefined;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function logLine(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * Abort the boot with a single value-free line. The exit runs from the write callback (with a
 * short fallback) because `process.exit()` can drop output that has not reached a pipe yet.
 */
function fatalExit(line, code = 1) {
  process.stderr.write(`${line}\n`, () => process.exit(code));
  setTimeout(() => process.exit(code), 300).unref();
}

/**
 * The validator's own report, reproduced for callers that must not exit the process
 * (`exitOnInvalid: false`). Issue messages come from the validator and never contain a value.
 */
function printFatal(issues) {
  const lines = ['FATAL: Environment validation failed'];
  for (const issue of issues) lines.push(`[${issue.path}] ${issue.message}`);
  process.stderr.write(`${lines.join('\n')}\n`);
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  response.end(payload);
}

function normaliseFailures(failures) {
  if (!Array.isArray(failures)) return [];
  return failures.map((failure) => ({
    dependency: String(failure?.dependency ?? 'unknown'),
    reason: String(failure?.reason ?? 'unreachable'),
  }));
}

/** `checkReadiness` never throws; if it ever does, the gate still fails closed. */
async function readReadiness(env, probes) {
  try {
    const result = await checkReadiness(env, probes);
    return { ready: result?.ready === true, failures: normaliseFailures(result?.failures) };
  } catch {
    return { ready: false, failures: [{ dependency: 'readiness', reason: 'unreachable' }] };
  }
}

function pathnameOf(requestUrl) {
  try {
    return new URL(requestUrl ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

function createRequestHandler(env, probes) {
  return (request, response) => {
    const handle = async () => {
      const pathname = pathnameOf(request.url);
      const method = request.method ?? 'GET';

      if (method === 'GET' && pathname === '/health') {
        sendJson(response, 200, { status: 'ok' });
        return;
      }

      if (method === 'GET' && pathname === '/ready') {
        const readiness = await readReadiness(env, probes);
        if (readiness.ready) sendJson(response, 200, { status: 'ready' });
        else sendJson(response, 503, { status: 'not_ready', failures: readiness.failures });
        return;
      }

      sendJson(response, 404, { status: 'not_found' });
    };

    handle().catch(() => {
      if (response.headersSent) response.destroy();
      else sendJson(response, 500, { status: 'error' });
    });
  };
}

function listen(server, host, port) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Bounded readiness gate: `attempts` checks `intervalMs` apart, stopping early when ready,
 * when the last attempt fails, or when the caller closes the server mid-loop.
 */
async function readinessLoop(env, probes, { attempts, intervalMs, isClosed }) {
  let failures = [];
  let attempted = 0;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (isClosed()) break;
    attempted = attempt;
    const readiness = await readReadiness(env, probes);
    failures = readiness.failures;
    if (readiness.ready) return { ready: true, failures: [], attempted };
    if (attempt < attempts) await delay(intervalMs);
  }

  return { ready: false, failures, attempted };
}

/**
 * Validate, listen, then gate on readiness.
 *
 * @param {Record<string, unknown>} [env] the environment (validated as-is; never mutated)
 * @param {object} [opts]
 * @param {Record<string, Function>} [opts.probes] readiness probes; injected by tests
 * @param {number} [opts.port] bound port; `0` picks a free one
 * @param {string} [opts.host] bind address (defaults to 0.0.0.0 so a container is reachable)
 * @param {string} [opts.portEnv] environment variable holding the port (worker: WORKER_HEALTH_PORT)
 * @param {number} [opts.defaultPort]
 * @param {number} [opts.attempts] readiness attempts; `0` skips the gate and keeps serving
 * @param {number} [opts.intervalMs]
 * @param {boolean} [opts.exitOnInvalid] exit 1 through the validator's report (default true)
 * @param {boolean} [opts.exitOnUnready] exit 1 after the gate fails (default true)
 * @returns {Promise<{ ok: boolean, listening: boolean, ready: boolean|null, failures: Array<{dependency: string, reason: string}>, issues?: Array<{path: string, message: string}>, server?: import('node:http').Server, port?: number }>}
 */
export async function start(env = process.env, opts = {}) {
  const source = env ?? {};
  const portEnv = opts.portEnv ?? DEFAULT_PORT_ENV;
  const probes = opts.probes ?? realProbes;
  const host = opts.host ?? DEFAULT_HOST;
  const port = Number.isInteger(opts.port) ? opts.port : nonNegativeInt(readEnv(source, portEnv), opts.defaultPort ?? DEFAULT_PORT);
  const attempts = Number.isInteger(opts.attempts)
    ? opts.attempts
    : nonNegativeInt(readEnv(source, 'READINESS_ATTEMPTS'), DEFAULT_READINESS_ATTEMPTS);
  const intervalMs = Number.isInteger(opts.intervalMs)
    ? opts.intervalMs
    : nonNegativeInt(readEnv(source, 'READINESS_INTERVAL_MS'), DEFAULT_READINESS_INTERVAL_MS);
  const exitOnInvalid = opts.exitOnInvalid !== false;
  const exitOnUnready = opts.exitOnUnready !== false;

  // Phase 1 — configuration. Nothing listens and no probe runs while the environment is invalid.
  const parsed = parseEnvironment(source);
  if (!parsed.ok) {
    // validateEnvironment prints the fail-closed report and exits 1; it never returns.
    if (exitOnInvalid) validateEnvironment(source);
    printFatal(parsed.issues);
    return { ok: false, listening: false, ready: null, failures: [], issues: parsed.issues };
  }

  // Phase 2 — liveness. An orchestrator must be able to tell "not ready" from "not running",
  // so the listener comes up before the dependency gate.
  const server = http.createServer(createRequestHandler(source, probes));
  let closed = false;
  server.on('close', () => {
    closed = true;
  });

  try {
    await listen(server, host, port);
  } catch (error) {
    try {
      server.close();
    } catch {
      // Never listening in the first place.
    }
    fatalExit(`FATAL: cannot listen on ${host}:${port} (${error?.code ?? 'listen failed'})`);
    return { ok: false, listening: false, ready: null, failures: [], server, error };
  }

  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : port;
  logLine(`listening on ${host}:${boundPort}`);

  // Phase 3 — readiness gate.
  const gate =
    attempts > 0
      ? await readinessLoop(source, probes, { attempts, intervalMs, isClosed: () => closed })
      : { ready: null, failures: [], attempted: 0 };

  if (gate.ready === true) {
    logLine(`ready: ${requiredDependencies(source).join(', ')}`);
  } else if (gate.ready === false && exitOnUnready) {
    // Dependency names only: no reason, host, or credential material reaches the log.
    const names = [...new Set(gate.failures.map((failure) => failure.dependency))];
    fatalExit(`FATAL: startup aborted; dependencies not ready: ${names.length > 0 ? names.join(', ') : 'unknown'}`);
  }

  return {
    ok: true,
    listening: true,
    ready: gate.ready,
    failures: gate.failures,
    attempts: gate.attempted,
    server,
    port: boundPort,
  };
}

const isCli = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  // Real probes and all-or-nothing startup: an invalid environment exits through
  // validateEnvironment, an unready gate exits through fatalExit.
  const result = await start(process.env, { exitOnUnready: true });
  if (!result.ok) process.exitCode = 1;
}
