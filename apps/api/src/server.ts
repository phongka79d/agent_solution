import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { packageName as adaptersPackageName } from '@agentos/adapters';
import { packageName as coreEnginePackageName } from '@agentos/core-engine';
import { packageName as databasePackageName } from '@agentos/database';
import { packageName as skillsPackageName } from '@agentos/skills';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerRoutes, type RouteDependencies } from './routes/index.js';
import { createGatewayComposition } from './runtime/composition.js';
import {
  GatewayFailureError,
  correlationIdOf,
  failureFor,
  replyFailure,
  toErrorResponse,
} from './gateway/http.js';
import type { GatewayFailure } from './gateway/contracts.js';
import { installRawBodyPreservation } from './gateway/raw-body.js';
import { registerWebSocketStream } from './gateway/websocket.js';

export const DEFAULT_PORT = 4000;

/** Bind address: a container has to be reachable from outside its network namespace. */
export const DEFAULT_HOST = '0.0.0.0';

export const DEFAULT_READINESS_ATTEMPTS = 5;
export const DEFAULT_READINESS_INTERVAL_MS = 1000;

/**
 * Workspace packages this gateway is allowed to depend on (02 §2 dependency DAG).
 * Exported so the health payload can prove the binding without calling into them.
 */
export const DEPENDENCIES: readonly string[] = [
  coreEnginePackageName,
  skillsPackageName,
  adaptersPackageName,
  databasePackageName,
];

/**
 * Builds the HTTP surface.
 *
 * The route groups are registered with the injected runtime, credential store and canonical-event
 * normaliser rather than with ambient state, so a server can only be built once the durable
 * bindings exist — a missing binding fails here, at composition, and never at request time.
 *
 * @param deps The gateway composition: runtime, credentials and the connector-layer derivation.
 * @returns A Fastify instance answering `/health` and the `/api/v1` surface.
 */
export function buildServer(deps: RouteDependencies): FastifyInstance {
  const app = Fastify({ logger: false });

  if (deps.close !== undefined) {
    app.addHook('onClose', async () => {
      await deps.close?.();
    });
  }

  // A refusal raised before a handler runs — the authentication hook, a request parser — must leave
  // in the same envelope as one raised inside a handler. Without this, a thrown `preHandler` would
  // be answered with Fastify's own error body and an unauthenticated delivery would read as a
  // server fault instead of a 401.
  app.setErrorHandler((error, request, reply) => {
    const correlation_id = correlationIdOf(request, deps.runtime);
    const client_error = clientFailure(error);

    if (client_error !== undefined) {
      return reply
        .status(client_error.http_status)
        .header('content-type', 'application/json; charset=utf-8')
        .send(toErrorResponse(client_error, correlation_id));
    }

    return replyFailure(reply, error, correlation_id);
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'api',
    dependencies: [...DEPENDENCIES],
  }));

  // R04 verifies the signature over the bytes the caller actually sent, so the preserving parser is
  // installed by the composition root before any route can read a delivery (`06` §8.1.1).
  installRawBodyPreservation(app);

  // R10 is a WebSocket operation (`06` §1.1, §8.1.2) and therefore never a Fastify route: its
  // handshake rides the HTTP server Fastify already owns, so it is mounted here beside the routes.
  registerWebSocketStream(app, { runtime: deps.runtime, credentials: deps.credentials });

  registerRoutes(app, deps);

  return app;
}

/**
 * Maps an error the framework raised for a malformed delivery onto the gateway's vocabulary.
 *
 * Fastify reports an unparseable JSON body, an oversized delivery and similar transport-level
 * problems as its own 4xx errors. They belong to the caller, so they are answered
 * `VALIDATION_FAILED` with the reason kept in `details` — never as a server fault, and never with
 * the parser's raw text.
 *
 * @param error The thrown value.
 * @returns The refusal to answer with, or `undefined` when the error is not a framework client error.
 */
function clientFailure(error: unknown): GatewayFailure | undefined {
  if (error instanceof GatewayFailureError) return undefined;

  const status = (error as { readonly statusCode?: unknown }).statusCode;
  if (typeof status !== 'number' || status < 400 || status >= 500) return undefined;

  // A delivery rejected for its size is one condition, whether the gateway's own parser caught it or
  // the framework's body limit did, so both are named the same in `details`.
  const oversized =
    status === 413 ||
    (error instanceof Error && error.message === 'RAW_BODY_TOO_LARGE') ||
    (error as { readonly code?: unknown }).code === 'FST_ERR_CTP_BODY_TOO_LONG';

  return failureFor('VALIDATION_FAILED', 'the delivery could not be read as a request', {
    reason: oversized ? 'RAW_BODY_TOO_LARGE' : 'MALFORMED_REQUEST',
  });
}

/**
 * Container boot (`node apps/api/dist/index.js`, 01 §8). The startup order matches
 * `apps/api/src/server.mjs`, the other implementation of this handshake:
 *
 *   1. parseEnvironment      (no socket, no probe)
 *   2. listen                (/health answers while dependencies are still unproven)
 *   3. bounded readiness loop (READINESS_ATTEMPTS x READINESS_INTERVAL_MS, then exit 1)
 *
 * The validator, the readiness gate and the probes are plain `.mjs` modules shared with the
 * worker sidecar. They live outside this package's TypeScript program and have no package export,
 * so the boot loads them as JavaScript through `new URL(...)` + dynamic `import()`.
 */

/** One configuration issue. `parseEnvironment` messages never contain a variable's value. */
interface EnvironmentIssue {
  path: string;
  message: string;
}

/** Mirrors the `ParseResult` typedef of `env.validator.mjs`. */
type EnvironmentParse =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; issues: EnvironmentIssue[] };

interface EnvironmentValidatorModule {
  parseEnvironment(env: Record<string, unknown>): EnvironmentParse;
  /** Prints the validator's fail-closed report and exits 1; it never returns. */
  validateEnvironment(env: Record<string, unknown>): Record<string, unknown>;
}

/** A readiness failure; `reason` is always one of {@link REASON_TOKENS}. */
interface ReadinessFailure {
  dependency: string;
  reason: string;
}

interface ReadinessResult {
  ready: boolean;
  failures: ReadinessFailure[];
}

interface ReadinessGate {
  /** `null` when the gate is disabled (`READINESS_ATTEMPTS=0`). */
  ready: boolean | null;
  failures: ReadinessFailure[];
}

/** `checkReadiness(env, probes)` from `packages/core-engine/src/config/readiness.mjs`. */
type ReadinessCheck = (
  env: Record<string, unknown>,
  probes: Readonly<Record<string, unknown>>,
) => Promise<ReadinessResult | undefined>;

interface ReadinessModule {
  checkReadiness: ReadinessCheck;
}

/** `apps/api/src/probes.mjs`; only the default probe set is used here. */
interface ProbesModule {
  realProbes: Readonly<Record<string, unknown>>;
}

/**
 * The only reason tokens the readiness contract allows. A reason reaches the GET /ready body and
 * the boot log, so anything else — a probe that threw, for instance — is replaced: a raw message
 * could carry a host or a credential.
 */
const REASON_TOKENS: readonly string[] = ['unreachable', 'auth_failed', 'unhealthy'];
const DEFAULT_REASON = 'unreachable';

/**
 * `apps/api/src/server.ts` and the compiled `apps/api/dist/server.js` are both three levels below
 * the repository root, so one specifier resolves from either. The image ships `packages/` and
 * `apps/api/` unchanged, which is what keeps this path valid in the container.
 */
const CORE_ENGINE_CONFIG_DIR = '../../../packages/core-engine/src/config/';

/**
 * A static import cannot be used here: these `.mjs` files sit outside this package's TypeScript
 * program and are reached through a specifier that is only assembled at runtime. The cast is the
 * boundary where the JavaScript module's shape is asserted once.
 */
async function loadModule<T>(specifier: URL): Promise<T> {
  return (await import(specifier.href)) as T;
}

/**
 * `./probes.mjs` sits next to this source file, `../src/probes.mjs` next to the compiled one; the
 * build copies no `.mjs` into `dist/`, so whichever path exists wins.
 */
const PROBES_CANDIDATES = ['./probes.mjs', '../src/probes.mjs'] as const;

function probesUrl(): URL {
  for (const candidate of PROBES_CANDIDATES) {
    const url = new URL(candidate, import.meta.url);
    if (existsSync(fileURLToPath(url))) return url;
  }
  return new URL(PROBES_CANDIDATES[0], import.meta.url);
}

function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Abort the boot with a single value-free line. The exit runs from the write callback (with a
 * short fallback), because `process.exit()` can drop output that has not reached a pipe yet.
 */
function fatalExit(line: string, code = 1): void {
  process.stderr.write(`${line}\n`, () => process.exit(code));
  setTimeout(() => process.exit(code), 300).unref();
}

function errorCode(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    if (typeof code === 'string' && code !== '') return code;
  }
  return 'listen failed';
}

/** `checkReadiness` never throws; if it ever does, the gate still fails closed. */
async function probeReadiness(
  checkReadiness: ReadinessCheck,
  env: Record<string, unknown>,
  probes: Readonly<Record<string, unknown>>,
): Promise<ReadinessGate> {
  try {
    const result = await checkReadiness(env, probes);
    const failures: ReadinessFailure[] = result?.failures ?? [];

    return {
      ready: result?.ready === true,
      failures: failures.map((failure) => ({
        dependency: failure.dependency,
        reason: REASON_TOKENS.includes(failure.reason) ? failure.reason : DEFAULT_REASON,
      })),
    };
  } catch {
    return { ready: false, failures: [{ dependency: 'readiness', reason: DEFAULT_REASON }] };
  }
}

/**
 * Bounded readiness gate: `attempts` checks `intervalMs` apart, stopping early on the first ready
 * result and skipping the wait after the last attempt.
 */
async function readinessGate(
  checkReadiness: ReadinessCheck,
  env: Record<string, unknown>,
  probes: Readonly<Record<string, unknown>>,
  attempts: number,
  intervalMs: number,
): Promise<ReadinessGate> {
  let failures: ReadinessFailure[] = [];

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const readiness = await probeReadiness(checkReadiness, env, probes);
    failures = readiness.failures;
    if (readiness.ready) return { ready: true, failures: [] };
    if (attempt === attempts) break;
    // `Promise.withResolvers()` is deliberately not used: the api image runs Node 20, where the
    // method does not exist.
    await new Promise((resolve) => {
      setTimeout(resolve, intervalMs);
    });
  }

  return { ready: false, failures };
}

async function closeOnSignal(app: FastifyInstance): Promise<void> {
  try {
    await app.close();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

/**
 * Validate, listen, then gate on readiness. An invalid environment and an unready gate both abort
 * the process: a container that cannot reach its dependencies must not report itself as started.
 */
export async function startServer(): Promise<FastifyInstance> {
  const env: Record<string, unknown> = process.env;

  // Phase 1 — configuration. Nothing listens and no probe runs while the environment is invalid.
  const { parseEnvironment, validateEnvironment } = await loadModule<EnvironmentValidatorModule>(
    new URL(`${CORE_ENGINE_CONFIG_DIR}env.validator.mjs`, import.meta.url),
  );

  const parsed = parseEnvironment(env);
  if (!parsed.ok) {
    // Prints the validator's own value-free report and exits 1; it never returns.
    validateEnvironment(env);
    throw new Error('FATAL: environment validation failed; the api gateway did not start');
  }

  // Phase 2 — liveness, ahead of the dependency gate: an orchestrator must be able to tell
  // "not ready" from "not running".
  const { checkReadiness } = await loadModule<ReadinessModule>(
    new URL(`${CORE_ENGINE_CONFIG_DIR}readiness.mjs`, import.meta.url),
  );
  const { realProbes } = await loadModule<ProbesModule>(probesUrl());

  const composition = createGatewayComposition(process.env);
  const app = buildServer(composition);

  // Every capability this build does not bind is named at boot rather than discovered by an
  // operator during an incident. A route that needs one answers 503 `UNBOUND_PORT`.
  for (const port of composition.unbound) {
    process.stdout.write(`api: capability not bound in this build: ${port}\n`);
  }
  const port = Number.parseInt(process.env.PORT ?? '', 10) || DEFAULT_PORT;

  app.get('/ready', async (_request, reply) => {
    const readiness = await probeReadiness(checkReadiness, env, realProbes);
    if (readiness.ready) return { status: 'ready' };

    reply.code(503);
    return { status: 'not_ready', failures: readiness.failures };
  });

  process.once('SIGINT', () => {
    void closeOnSignal(app);
  });
  process.once('SIGTERM', () => {
    void closeOnSignal(app);
  });

  try {
    await app.listen({ port, host: DEFAULT_HOST });
  } catch (error) {
    fatalExit(`FATAL: cannot listen on ${DEFAULT_HOST}:${port} (${errorCode(error)})`);
    throw error;
  }

  process.stdout.write(`listening on ${DEFAULT_HOST}:${port}\n`);

  // Phase 3 — the gate: a ready dependency set is what makes the container's "started" claim true.
  const attempts = nonNegativeInt(process.env.READINESS_ATTEMPTS, DEFAULT_READINESS_ATTEMPTS);
  const intervalMs = nonNegativeInt(process.env.READINESS_INTERVAL_MS, DEFAULT_READINESS_INTERVAL_MS);
  const gate: ReadinessGate =
    attempts > 0
      ? await readinessGate(checkReadiness, env, realProbes, attempts, intervalMs)
      : { ready: null, failures: [] };

  if (gate.ready === false) {
    // Dependency names only: no reason, host, or credential material reaches the log.
    const names = [...new Set(gate.failures.map((failure) => failure.dependency))];
    fatalExit(
      `FATAL: startup aborted; dependencies not ready: ${names.length > 0 ? names.join(', ') : 'unknown'}`,
    );
  }

  return app;
}
