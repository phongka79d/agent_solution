// Command Center boot: configuration checks and liveness only.
//
// The Command Center reaches tenant data exclusively through the /api/v1 gateway, so this
// process opens no data-store connection and reads no data-store credential: DATABASE_URL,
// REDIS_*, QDRANT_* and the ERP secrets are ignored even when the orchestrator injects them
// into the container.
//
// Consequences of that boundary, both deliberate:
// - `parseEnvironment` is NOT used here: it requires DATABASE_URL (and the rest of the
//   gateway's schema), which this process must not depend on.
// - `isPlaceholder` (pure, no environment in scope) and the profile/enum constants ARE reused
//   from the same module, so the APP_ENV/NODE_ENV mapping and the placeholder policy have one
//   definition across every process.
//
// `node apps/command-center/src/server.mjs` reads PORT (default 3000) and exits 1 when the
// configuration checks fail.

import http from 'node:http';
import { pathToFileURL } from 'node:url';

import {
  APP_ENVS,
  MANAGED_APP_ENVS,
  NODE_ENVS,
  PROFILE_NODE_ENV,
  isPlaceholder,
} from '../../../packages/core-engine/src/config/env.validator.mjs';

export const DEFAULT_PORT = 3000;
export const DEFAULT_HOST = '0.0.0.0';
export const MIN_NEXTAUTH_SECRET_LENGTH = 32;

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

/** Mirrors the validator's fail-closed report so every image fails the same way. */
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

/**
 * @param {unknown} value
 * @param {string} path
 * @param {{ originOnly?: boolean }} [opts] `originOnly` additionally refuses any path, query or
 *   fragment (NEXT_PUBLIC_API_URL is a gateway origin; clients append `/api/v1/**` themselves)
 * @returns {{ path: string, message: string } | null}
 */
function urlIssue(value, path, opts = {}) {
  const raw = String(value ?? '').trim();
  if (raw === '') return { path, message: 'is required' };

  let url;
  try {
    url = new URL(raw);
  } catch {
    return { path, message: 'must be an absolute URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { path, message: 'must use http or https' };
  if (url.hostname === '') return { path, message: 'must include a host' };
  if (url.username !== '' || url.password !== '') return { path, message: 'must not embed credentials' };

  if (opts.originOnly) {
    if (url.pathname.toLowerCase().includes('/api/v1')) {
      return { path, message: 'must be the gateway origin only (no /api/v1 suffix)' };
    }
    if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      return { path, message: 'must be an origin only (no path, query or fragment)' };
    }
  }

  return null;
}

/**
 * The checks this process owns: profile + runtime mode, the NextAuth secret, and the two
 * browser-facing URLs. No data-store variable is read, and no issue message contains a value.
 *
 * @param {Record<string, unknown>} [env]
 * @returns {{ ok: true, data: { appEnv: string, nodeEnv: string, nextAuthUrl: string, nextPublicApiUrl: string, port: number } } | { ok: false, issues: Array<{ path: string, message: string }> }}
 */
export function parseCommandCenterEnv(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  /** @type {Array<{ path: string, message: string }>} */
  const issues = [];

  const appEnv = String(readEnv(source, 'APP_ENV') ?? '').trim();
  const requiredNodeEnv = PROFILE_NODE_ENV[appEnv];
  if (appEnv === '') issues.push({ path: 'APP_ENV', message: 'is required' });
  else if (!APP_ENVS.includes(appEnv)) {
    issues.push({ path: 'APP_ENV', message: `must be one of ${APP_ENVS.join(' | ')}` });
  }

  const nodeEnv = String(readEnv(source, 'NODE_ENV') ?? '').trim();
  if (nodeEnv === '') issues.push({ path: 'NODE_ENV', message: 'is required' });
  else if (!NODE_ENVS.includes(nodeEnv)) {
    issues.push({ path: 'NODE_ENV', message: `must be one of ${NODE_ENVS.join(' | ')}` });
  } else if (requiredNodeEnv && nodeEnv !== requiredNodeEnv) {
    issues.push({ path: 'NODE_ENV', message: `must be "${requiredNodeEnv}" when APP_ENV is "${appEnv}"` });
  }

  const secret = String(readEnv(source, 'NEXTAUTH_SECRET') ?? '');
  if (secret === '') issues.push({ path: 'NEXTAUTH_SECRET', message: 'is required' });
  else if (secret.length < MIN_NEXTAUTH_SECRET_LENGTH) {
    issues.push({ path: 'NEXTAUTH_SECRET', message: `must be at least ${MIN_NEXTAUTH_SECRET_LENGTH} characters` });
  } else if (MANAGED_APP_ENVS.includes(appEnv) && isPlaceholder(secret)) {
    issues.push({ path: 'NEXTAUTH_SECRET', message: `must not be a placeholder value when APP_ENV is "${appEnv}"` });
  }

  const nextAuthIssue = urlIssue(readEnv(source, 'NEXTAUTH_URL'), 'NEXTAUTH_URL');
  if (nextAuthIssue) issues.push(nextAuthIssue);

  const apiUrlIssue = urlIssue(readEnv(source, 'NEXT_PUBLIC_API_URL'), 'NEXT_PUBLIC_API_URL', { originOnly: true });
  if (apiUrlIssue) issues.push(apiUrlIssue);

  if (issues.length > 0) return { ok: false, issues };

  return {
    ok: true,
    data: {
      appEnv,
      nodeEnv,
      nextAuthUrl: String(readEnv(source, 'NEXTAUTH_URL')).trim(),
      nextPublicApiUrl: String(readEnv(source, 'NEXT_PUBLIC_API_URL')).trim(),
      port: nonNegativeInt(readEnv(source, 'PORT'), DEFAULT_PORT),
    },
  };
}

function pathnameOf(requestUrl) {
  try {
    return new URL(requestUrl ?? '/', 'http://localhost').pathname;
  } catch {
    return '/';
  }
}

function createRequestHandler(env) {
  return (request, response) => {
    const pathname = pathnameOf(request.url);
    const method = request.method ?? 'GET';

    if (method === 'GET' && pathname === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (method === 'GET' && pathname === '/ready') {
      // Re-checked per request so a config regression cannot report ready; no network call is
      // made and no secret value is ever placed in the payload.
      const parsed = parseCommandCenterEnv(env);
      if (parsed.ok) sendJson(response, 200, { status: 'ready' });
      else {
        sendJson(response, 503, {
          status: 'not_ready',
          failures: parsed.issues.map((issue) => ({ dependency: issue.path, reason: issue.message })),
        });
      }
      return;
    }

    sendJson(response, 404, { status: 'not_found' });
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

/**
 * Validate the Command Center's own configuration, then serve /health and /ready. There is no
 * readiness gate: the checks are local, so a process that got this far is ready when they pass.
 *
 * @param {Record<string, unknown>} [env]
 * @param {{ host?: string, port?: number }} [opts]
 */
export async function start(env = process.env, opts = {}) {
  const source = env ?? {};
  const host = opts.host ?? DEFAULT_HOST;

  const parsed = parseCommandCenterEnv(source);
  if (!parsed.ok) {
    printFatal(parsed.issues);
    return { ok: false, listening: false, ready: false, issues: parsed.issues };
  }

  const port = Number.isInteger(opts.port) ? opts.port : parsed.data.port;
  const server = http.createServer(createRequestHandler(source));

  try {
    await listen(server, host, port);
  } catch (error) {
    try {
      server.close();
    } catch {
      // Never listening in the first place.
    }
    process.stderr.write(`FATAL: cannot listen on ${host}:${port} (${error?.code ?? 'listen failed'})\n`);
    return { ok: false, listening: false, ready: false, server, error };
  }

  const address = server.address();
  const boundPort = address && typeof address === 'object' ? address.port : port;
  logLine(`listening on ${host}:${boundPort}`);

  return { ok: true, listening: true, ready: true, server, port: boundPort, data: parsed.data };
}

const isCli = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const result = await start(process.env);
  if (!result.ok || result.ready !== true) process.exitCode = 1;
}
