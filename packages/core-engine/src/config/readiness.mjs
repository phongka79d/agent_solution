/**
 * AgentOS startup readiness gate.
 *
 * Runtime implementation for `packages/core-engine/src/config/readiness.mjs`. Dependency-free
 * plain JavaScript on purpose: the Gate P0 images run Node 20 without a compile step or
 * `node_modules`, and Node 20 cannot import TypeScript.
 *
 * Contract:
 * - `requiredDependencies(env)` returns the dependency names that must be probed, in order:
 *   `postgres`, `redis`; `qdrant` unless `KNOWLEDGE_ANSWERS_ENABLED` is exactly `"false"`;
 *   `sor` (the mock ERP boundary) only when `MOCK_ERP_ENABLED` parses true; `temporal` only
 *   when `TEMPORAL_ADDRESS` is non-empty.
 * - `checkReadiness(env, probes, opts)` calls only the required probes, in that order, and
 *   collects every failure instead of short-circuiting. Injected probes keep tests off the
 *   network; the default probes are TCP reachability checks.
 * - `assertStartup(env, probes, opts)` validates configuration first and calls no probe when
 *   configuration is invalid. It never listens on a socket.
 * - Failure reasons name the dependency and never echo an environment secret value.
 */

import net from 'node:net';

import { parseEnvironment, parseBool, readValue, redact, secretValues } from './env.validator.mjs';

/** Default TCP probe timeout; overridable per call through `opts.timeoutMs`. */
const DEFAULT_PROBE_TIMEOUT_MS = 2000;
/** Fallback ports for the default TCP probes when the URL/port is absent. */
const DEFAULT_PORTS = { postgres: 5432, redis: 6379, qdrant: 6333, sor: 80, temporal: 7233 };

/**
 * @typedef {{ ok: boolean, reason?: string }} ProbeOutcome
 * @typedef {(env: Record<string, unknown>) => ProbeOutcome | Promise<ProbeOutcome>} Probe
 * @typedef {{ postgres?: Probe, redis?: Probe, qdrant?: Probe, sor?: Probe, temporal?: Probe }} Probes
 * @typedef {{ timeoutMs?: number, requireNodeEnv?: boolean }} ReadinessOptions
 * @typedef {{ dependency: string, reason: string }} ReadinessFailure
 * @typedef {{ ready: boolean, failures: ReadinessFailure[] }} ReadinessResult
 * @typedef {{ ready: boolean, failures: ReadinessFailure[], configIssues: Array<{ path: string, message: string }> }} StartupResult
 */

/**
 * Names of the dependencies that must be probed for this environment, in probe order.
 *
 * @param {Record<string, unknown>} [env]
 * @returns {string[]}
 */
export function requiredDependencies(env = process.env) {
  const source = env && typeof env === 'object' ? env : {};
  const read = (key) => readValue(source[key]);

  const appEnv = read('APP_ENV') ?? '';
  const isLocalOrCi = appEnv === 'local' || appEnv === 'ci';

  const dependencies = ['postgres', 'redis'];

  if (read('KNOWLEDGE_ANSWERS_ENABLED') !== 'false') dependencies.push('qdrant');

  const mockErpRaw = read('MOCK_ERP_ENABLED');
  const mockErpEnabled = mockErpRaw === undefined || mockErpRaw === '' ? isLocalOrCi : parseBool(mockErpRaw) === true;
  if (mockErpEnabled) dependencies.push('sor');

  const temporalAddress = read('TEMPORAL_ADDRESS');
  if (temporalAddress !== undefined && temporalAddress !== '') dependencies.push('temporal');

  return dependencies;
}

/**
 * Probes every required dependency in order and reports the aggregate readiness.
 * Calls no probe for a disabled dependency and never throws.
 *
 * @param {Record<string, unknown>} [env]
 * @param {Probes} [probes] injected probes; any omitted dependency falls back to the default TCP probe
 * @param {ReadinessOptions} [opts]
 * @returns {Promise<ReadinessResult>}
 */
export async function checkReadiness(env = process.env, probes = undefined, opts = {}) {
  const source = env && typeof env === 'object' ? env : {};
  const secrets = secretValues(source);
  const defaults = createDefaultProbes(opts);

  /** @type {ReadinessFailure[]} */
  const failures = [];

  for (const dependency of requiredDependencies(source)) {
    const probe = pickProbe(probes, dependency) ?? defaults[dependency];
    if (typeof probe !== 'function') {
      failures.push({ dependency, reason: 'no probe configured' });
      continue;
    }

    let outcome;
    try {
      outcome = await probe(source);
    } catch (error) {
      failures.push({ dependency, reason: redact(`probe threw: ${errorMessage(error)}`, secrets) });
      continue;
    }

    if (!outcome || outcome.ok !== true) {
      const reason = outcome && outcome.reason !== undefined && outcome.reason !== null ? String(outcome.reason) : 'not ready';
      failures.push({ dependency, reason: redact(reason, secrets) });
    }
  }

  return { ready: failures.length === 0, failures };
}

/**
 * Validates the environment, then runs the readiness probes. Configuration issues are
 * reported as a `config` failure and no probe is called; the parsed configuration is not
 * required for probing, so the raw environment is passed through unchanged. Does not listen.
 *
 * @param {Record<string, unknown>} [env]
 * @param {Probes} [probes]
 * @param {ReadinessOptions} [opts]
 * @returns {Promise<StartupResult>}
 */
export async function assertStartup(env = process.env, probes = undefined, opts = {}) {
  const source = env && typeof env === 'object' ? env : {};
  const config = parseEnvironment(source, { requireNodeEnv: opts.requireNodeEnv !== false });

  if (!config.ok) {
    /** @type {ReadinessFailure[]} */
    const failures = [];
    const seen = new Set();
    for (const issue of config.issues) {
      if (seen.has(issue.path)) continue;
      seen.add(issue.path);
      failures.push({ dependency: 'config', reason: issue.path });
    }
    return { ready: false, failures, configIssues: config.issues };
  }

  const readiness = await checkReadiness(source, probes, opts);
  return { ready: readiness.ready, failures: readiness.failures, configIssues: [] };
}

/**
 * @param {Probes|undefined} probes
 * @param {string} dependency
 * @returns {Probe|undefined}
 */
function pickProbe(probes, dependency) {
  if (!probes || typeof probes !== 'object') return undefined;
  const probe = probes[dependency];
  return typeof probe === 'function' ? probe : undefined;
}

/**
 * Default TCP reachability probes used when no probe was injected (real boot, no test stubs).
 * They report reachability only and never include credentials or connection URIs.
 *
 * @param {ReadinessOptions} [opts]
 * @returns {Record<string, Probe>}
 */
function createDefaultProbes(opts = {}) {
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : DEFAULT_PROBE_TIMEOUT_MS;

  return {
    postgres: (env) => tcpProbe(targetFromUrl(readValue(env.DATABASE_URL), DEFAULT_PORTS.postgres), timeoutMs),
    redis: (env) =>
      tcpProbe({ host: readValue(env.REDIS_HOST), port: numericPort(readValue(env.REDIS_PORT), DEFAULT_PORTS.redis) }, timeoutMs),
    qdrant: (env) => tcpProbe(targetFromUrl(readValue(env.QDRANT_URL), DEFAULT_PORTS.qdrant), timeoutMs),
    sor: (env) => tcpProbe(targetFromUrl(readValue(env.ERP_API_BASE_URL), DEFAULT_PORTS.sor), timeoutMs),
    temporal: (env) => {
      const address = readValue(env.TEMPORAL_ADDRESS) ?? '';
      const separator = address.lastIndexOf(':');
      const host = separator === -1 ? address : address.slice(0, separator);
      const port = separator === -1 ? undefined : numericPort(address.slice(separator + 1), DEFAULT_PORTS.temporal);
      return tcpProbe({ host, port }, timeoutMs);
    },
  };
}

/**
 * @param {string|undefined} value
 * @param {number} fallbackPort
 * @returns {{ host: string|undefined, port: number }}
 */
function targetFromUrl(value, fallbackPort) {
  if (value === undefined || value === '') return { host: undefined, port: fallbackPort };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { host: undefined, port: fallbackPort };
  }
  const port = url.port !== '' ? Number(url.port) : url.protocol === 'https:' ? 443 : fallbackPort;
  return { host: url.hostname, port };
}

/**
 * @param {string|undefined} value
 * @param {number} fallbackPort
 * @returns {number}
 */
function numericPort(value, fallbackPort) {
  const parsed = value === undefined ? undefined : Number(value);
  return parsed !== undefined && Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : fallbackPort;
}

/**
 * @param {{ host: string|undefined, port: number }} target
 * @param {number} timeoutMs
 * @returns {Promise<ProbeOutcome>}
 */
function tcpProbe(target, timeoutMs) {
  return new Promise((resolve) => {
    if (!target || !target.host || !Number.isInteger(target.port) || target.port < 1 || target.port > 65535) {
      resolve({ ok: false, reason: 'no probe target configured' });
      return;
    }

    const endpoint = `${target.host}:${target.port}`;
    let socket;
    try {
      socket = net.connect({ host: target.host, port: target.port });
    } catch (error) {
      resolve({ ok: false, reason: `unreachable (${errorMessage(error)}) at ${endpoint}` });
      return;
    }

    const finish = (outcome) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(outcome);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ ok: true }));
    socket.once('timeout', () => finish({ ok: false, reason: `unreachable (timeout) at ${endpoint}` }));
    socket.once('error', (error) => finish({ ok: false, reason: `unreachable (${errorMessage(error)}) at ${endpoint}` }));
  });
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorMessage(error) {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  if (error instanceof Error && error.message !== '') return error.message;
  return String(error);
}
