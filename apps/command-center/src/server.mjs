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

import { parseCommandCenterEnv } from './env.mjs';

export { parseCommandCenterEnv } from './env.mjs';

export const DEFAULT_HOST = '0.0.0.0';
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
