// Default network probes for the dependency readiness gate.
//
// Every probe resolves to `{ ok: true }` or `{ ok: false, reason }` where `reason` is one of the
// three tokens the readiness contract allows: `unreachable`, `auth_failed`, `unhealthy`.
// A reason may be surfaced by GET /ready and by the boot log, so it MUST stay value-free:
// response bodies, hosts, passwords and API keys are never copied into a result or a log line.
//
// Probes are injected into the boot module, so tests never open a socket and never need a live
// postgres/redis/qdrant/mock-ERP.

import net from 'node:net';

export const DEFAULT_TIMEOUT_MS = 2000;

export const REASONS = Object.freeze({
  UNREACHABLE: 'unreachable',
  AUTH_FAILED: 'auth_failed',
  UNHEALTHY: 'unhealthy',
});

const POSTGRES_DEFAULT_PORT = 5432;
const REDIS_DEFAULT_PORT = 6379;
const TEMPORAL_DEFAULT_PORT = 7233;

function timeoutOf(opts) {
  return Number.isInteger(opts?.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
}

function parseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    return new URL(value.trim());
  } catch {
    return null;
  }
}

function portOf(value, fallback) {
  const port = Number.parseInt(value ?? '', 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : fallback;
}

function splitHostPort(address, fallbackPort) {
  const value = String(address ?? '').trim();
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(value);
  if (bracketed) return { host: bracketed[1], port: portOf(bracketed[2], fallbackPort) };
  const separator = value.lastIndexOf(':');
  if (separator === -1) return { host: value, port: fallbackPort };
  return { host: value.slice(0, separator), port: portOf(value.slice(separator + 1), fallbackPort) };
}

// Resolves as soon as the TCP handshake completes. Nothing is written to the socket, so no
// credential material can travel on the connection or reach a log.
function tcpConnect(host, port, timeoutMs) {
  return new Promise((resolve) => {
    if (!host || !Number.isInteger(port)) {
      resolve({ ok: false, reason: REASONS.UNREACHABLE });
      return;
    }
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    // Registered with `on` (not `once`) so a late error after destroy() is still consumed.
    socket.on('connect', () => finish({ ok: true }));
    socket.on('timeout', () => finish({ ok: false, reason: REASONS.UNREACHABLE }));
    socket.on('error', () => finish({ ok: false, reason: REASONS.UNREACHABLE }));
  });
}

async function httpProbe(target, { headers = {}, timeoutMs } = {}) {
  try {
    const response = await fetch(target, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel?.();
      return { ok: false, reason: REASONS.AUTH_FAILED };
    }
    if (!response.ok) {
      await response.body?.cancel?.();
      return { ok: false, reason: REASONS.UNHEALTHY };
    }
    // The body is discarded on purpose: a health payload can echo the key it was called with.
    await response.body?.cancel?.();
    return { ok: true };
  } catch {
    return { ok: false, reason: REASONS.UNREACHABLE };
  }
}

// RESP: `*<argc>\r\n` then `$<len>\r\n<arg>\r\n` per argument.
function respCommand(args) {
  let out = `*${args.length}\r\n`;
  for (const arg of args) out += `$${Buffer.byteLength(arg)}\r\n${arg}\r\n`;
  return out;
}

/**
 * Postgres: a TCP handshake on the host/port parsed from DATABASE_URL. The URL itself is never
 * logged, and no authentication is attempted (the readiness gate is "is the listener up").
 */
export async function postgres(env = process.env, opts = {}) {
  const url = parseUrl(env?.DATABASE_URL);
  if (!url || !url.hostname) return { ok: false, reason: REASONS.UNREACHABLE };
  return tcpConnect(url.hostname, portOf(url.port, POSTGRES_DEFAULT_PORT), timeoutOf(opts));
}

/**
 * Redis: RESP AUTH (when REDIS_PASSWORD is set) followed by PING, expecting `+PONG`.
 * The password travels on the socket but is never logged.
 */
export function redis(env = process.env, opts = {}) {
  const host = String(env?.REDIS_HOST ?? '').trim();
  const port = portOf(env?.REDIS_PORT, REDIS_DEFAULT_PORT);
  const password = env?.REDIS_PASSWORD ?? '';
  const timeoutMs = timeoutOf(opts);
  if (!host) return Promise.resolve({ ok: false, reason: REASONS.UNREACHABLE });

  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    let buffer = '';
    let awaitingPing = true;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => {
      if (password) {
        awaitingPing = false;
        socket.write(respCommand(['AUTH', password]));
      } else {
        socket.write(respCommand(['PING']));
      }
    });
    socket.on('timeout', () => finish({ ok: false, reason: REASONS.UNREACHABLE }));
    socket.on('error', () => finish({ ok: false, reason: REASONS.UNREACHABLE }));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let index = buffer.indexOf('\r\n');
      while (index !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (line.startsWith('-')) {
          // e.g. `-WRONGPASS invalid username-password pair` / `-NOAUTH Authentication required`.
          const authFailure = /auth|pass/i.test(line);
          finish({ ok: false, reason: authFailure ? REASONS.AUTH_FAILED : REASONS.UNHEALTHY });
          return;
        }
        if (line === '+PONG') {
          finish({ ok: true });
          return;
        }
        if (line.startsWith('+')) {
          if (!awaitingPing) {
            awaitingPing = true;
            socket.write(respCommand(['PING']));
          }
          index = buffer.indexOf('\r\n');
          continue;
        }
        // A bulk/array reply to AUTH or PING is not a usable liveness answer.
        finish({ ok: false, reason: REASONS.UNHEALTHY });
        return;
      }
    });
  });
}

/** Qdrant: GET {QDRANT_URL origin}/healthz with the `api-key` header. The key is never logged. */
export async function qdrant(env = process.env, opts = {}) {
  const base = parseUrl(env?.QDRANT_URL);
  if (!base || !base.hostname) return { ok: false, reason: REASONS.UNREACHABLE };
  const apiKey = env?.QDRANT_API_KEY;
  return httpProbe(`${base.origin}/healthz`, {
    headers: apiKey ? { 'api-key': apiKey } : {},
    timeoutMs: timeoutOf(opts),
  });
}

/**
 * System of record: the mock-ERP health route, derived as the origin of ERP_API_BASE_URL plus
 * `/health` (the base URL itself carries the `/api/v1` prefix, the health route does not).
 */
export async function sor(env = process.env, opts = {}) {
  const base = parseUrl(env?.ERP_API_BASE_URL);
  if (!base || !base.hostname) return { ok: false, reason: REASONS.UNREACHABLE };
  return httpProbe(`${base.origin}/health`, { timeoutMs: timeoutOf(opts) });
}

/** Temporal: a TCP handshake on TEMPORAL_ADDRESS (`host:port`). Not required when it is empty. */
export async function temporal(env = process.env, opts = {}) {
  const address = String(env?.TEMPORAL_ADDRESS ?? '').trim();
  if (!address) return { ok: false, reason: REASONS.UNREACHABLE };
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(address) ? parseUrl(address) : null;
  const { host, port } = url
    ? { host: url.hostname, port: portOf(url.port, TEMPORAL_DEFAULT_PORT) }
    : splitHostPort(address, TEMPORAL_DEFAULT_PORT);
  return tcpConnect(host, port, timeoutOf(opts));
}

/** The default probe set injected into the boot module; tests inject their own. */
export const realProbes = Object.freeze({ postgres, redis, qdrant, sor, temporal });

export default realProbes;
