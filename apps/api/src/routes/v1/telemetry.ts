/**
 * @file R09 `GET /api/v1/telemetry/stream` (SSE) and R17 `GET /api/v1/telemetry/kpi-snapshot`
 * (implement/06 §8.1.2 R09, §8.1.3 R17; §10.1 event names).
 *
 * Both operations are reads: each writes exactly one audit row and no evidence row (`06` §8.0).
 * The tenant is the authenticated principal's, never the query string's; the operator permission is
 * `telemetry:read`, so a session or widget token never opens either surface.
 *
 * R09 hijacks the reply: once a stream is open there is no JSON envelope left to write, so a
 * failure that happens after the first byte leaves as a `stream.error` frame followed by resume
 * guidance, exactly as §8.1.2 R09 requires — the alternative (a truncated 200 with no frame) would
 * tell the client nothing about why the stream stopped.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type {
  GatewayPrincipal,
  KpiSnapshotResponse,
  StreamChannel,
  TelemetryFrame,
} from '../../gateway/contracts.js';
import { correlationIdOf, fail, mapError, replyFailure } from '../../gateway/http.js';
import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator, requirePrincipal } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';

/** Audit operation names; each route spells its own once. */
const STREAM_OPERATION = 'GET /api/v1/telemetry/stream';
const KPI_OPERATION = 'GET /api/v1/telemetry/kpi-snapshot';

/** The two stream filters of `06` §8.1.2 R09; any other value is not the declared query shape. */
const STREAM_CHANNELS: readonly StreamChannel[] = Object.freeze(['run_updates', 'conversation_events']);

/** Reads a single-valued header, ignoring a repeated one rather than guessing between values. */
function headerValue(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Reads a non-empty string field without asserting the object's shape. */
function stringField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

/** Reads a positive integer query parameter; a non-integer is refused, never coerced to a default. */
function limitField(value: unknown, key: string): number | null {
  const raw = stringField(value, key);
  if (raw === null) return null;
  if (!/^\d+$/.test(raw) || raw === '0') {
    fail('VALIDATION_FAILED', `${key} must be a positive integer`);
  }
  return Number.parseInt(raw, 10);
}

/** The authenticated principal, or `null` when none was resolved. */
function principalOrNull(request: FastifyRequest): GatewayPrincipal | null {
  try {
    return requirePrincipal(request);
  } catch {
    return null;
  }
}

/**
 * Writes the refusal's audit row and its canonical envelope.
 *
 * The row carries the principal's tenant, so a request that never resolved a principal has no
 * tenant to attribute and no row is written: an audit row under a caller-supplied tenant would be
 * exactly the cross-tenant write the isolation rules forbid. The status always comes from the
 * frozen {@link FAILURE_STATUS} table through `replyFailure`, never from this module.
 */
async function refuseOperation(input: {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly runtime: GatewayRuntime;
  readonly operation: string;
  readonly error: unknown;
}): Promise<void> {
  const correlation_id = correlationIdOf(input.request, input.runtime);
  const principal = principalOrNull(input.request);

  if (principal !== null) {
    await input.runtime.audit.record({
      tenant_id: principal.tenant_id,
      correlation_id,
      operation: input.operation,
      principal_kind: principal.kind,
      outcome: 'REFUSED',
      error_code: mapError(input.error, correlation_id).error_code,
      ...(principal.operator_id !== undefined ? { operator_id: principal.operator_id } : {}),
    });
  }

  replyFailure(input.reply, input.error, correlation_id);
}

/**
 * One SSE frame. `JSON.stringify` escapes CR/LF inside values, so `data` is single-line by
 * construction; `id` and `event` are flattened because a newline there would smuggle an extra
 * field into the frame and desynchronise the client's `Last-Event-ID` resume.
 */
function sseFrame(frame: TelemetryFrame): string {
  const id = frame.id.replace(/[\r\n]+/g, ' ');
  const event = frame.event.replace(/[\r\n]+/g, ' ');
  return `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}

/** The resolved R09 subscription filter; `cursor` already reflects the `Last-Event-ID` fallback. */
interface StreamFilter {
  readonly metric?: string;
  readonly channel?: StreamChannel;
  readonly cursor?: string;
  readonly resumed_from_header: boolean;
}

/**
 * Reads the R09 query. `Last-Event-ID` is the resume cursor only when no explicit `cursor` was
 * sent: the query parameter is the caller's deliberate choice, the header is what a reconnecting
 * `EventSource` replays automatically, and merging the two would resume from neither.
 */
function streamFilter(request: FastifyRequest): StreamFilter {
  const metric = stringField(request.query, 'metric');
  const channel = stringField(request.query, 'channel');
  const cursor = stringField(request.query, 'cursor');
  const last_event_id = headerValue(request, 'last-event-id');

  if (channel !== null && !STREAM_CHANNELS.some((member) => member === channel)) {
    fail(
      'VALIDATION_FAILED',
      'channel must be one of the declared telemetry stream channels (06 §8.1.2 R09)',
    );
  }

  const effective = cursor ?? last_event_id;

  return {
    ...(metric !== null ? { metric } : {}),
    ...(channel !== null ? { channel: channel as StreamChannel } : {}),
    ...(effective !== null ? { cursor: effective } : {}),
    resumed_from_header: cursor === null && last_event_id !== null,
  };
}

/**
 * R09. Subscribes the operator's tenant to the frame stream and writes one SSE frame per
 * {@link TelemetryFrame}. The subscription is aborted when the socket closes, so a dropped client
 * does not leave a producer running for the lifetime of the process.
 */
async function handleStream(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: { readonly runtime: GatewayRuntime; readonly credentials: CredentialStore },
): Promise<void> {
  const runtime = deps.runtime;
  const correlation_id = correlationIdOf(request, runtime);

  let operator: GatewayPrincipal;
  let filter: StreamFilter;
  try {
    operator = requireOperator(request, 'telemetry:read');
    filter = streamFilter(request);
  } catch (error) {
    await refuseOperation({ request, reply, runtime, operation: STREAM_OPERATION, error });
    return;
  }

  const controller = new AbortController();
  request.raw.on('close', () => {
    controller.abort();
  });

  // The audit row records the subscription itself, before the first frame: a stream refused only
  // after it opened would otherwise leave no trace of the attempt. No evidence row — R09 is a read.
  await runtime.audit.record({
    tenant_id: operator.tenant_id,
    correlation_id,
    operation: STREAM_OPERATION,
    principal_kind: operator.kind,
    outcome: 'ACCEPTED',
    ...(operator.operator_id !== undefined ? { operator_id: operator.operator_id } : {}),
    detail: {
      metric: filter.metric ?? null,
      channel: filter.channel ?? null,
      resume_cursor: filter.cursor ?? null,
      resumed_from_last_event_id: filter.resumed_from_header,
    },
  });

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  raw.flushHeaders();

  try {
    const frames = runtime.streams.subscribe({
      tenant_id: operator.tenant_id,
      ...(filter.metric !== undefined ? { metric: filter.metric } : {}),
      ...(filter.channel !== undefined ? { channel: filter.channel } : {}),
      ...(filter.cursor !== undefined ? { cursor: filter.cursor } : {}),
      signal: controller.signal,
    });

    for await (const frame of frames) {
      if (controller.signal.aborted || raw.writableEnded) break;
      raw.write(sseFrame(frame));
    }

    raw.end();
  } catch (error) {
    // Headers are already sent, so the refusal leaves as a frame. The envelope is the same one
    // `replyFailure` would have written, plus the resume instruction §8.1.2 R09 requires.
    const envelope = mapError(error, correlation_id);
    raw.write(
      sseFrame({
        id: runtime.ids(),
        event: 'stream.error',
        data: {
          error_code: envelope.error_code,
          message: envelope.message,
          retryable: envelope.retryable,
          correlation_id,
          reconnect: 'resume with Last-Event-ID set to the last acknowledged frame id',
        },
      }),
    );
    raw.end();
  }
}

/** The resolved R17 snapshot query; every field is the caller's or absent. */
interface SnapshotQuery {
  readonly window?: string;
  readonly timezone?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

/** Reads the R17 query verbatim; the port, not this route, decides what a window or zone means. */
function snapshotQuery(request: FastifyRequest): SnapshotQuery {
  const window = stringField(request.query, 'window');
  const timezone = stringField(request.query, 'timezone');
  const cursor = stringField(request.query, 'cursor');
  const limit = limitField(request.query, 'limit');

  return {
    ...(window !== null ? { window } : {}),
    ...(timezone !== null ? { timezone } : {}),
    ...(cursor !== null ? { cursor } : {}),
    ...(limit !== null ? { limit } : {}),
  };
}

/**
 * R17. Returns the SCR-001 snapshot exactly as the KPI projection reports it. `source_status` is
 * never computed here: a metric with no upstream source is labelled `NOT_INSTRUMENTED` by the port,
 * and re-deriving it in the gateway would turn a labelled gap into an invented zero.
 */
async function handleKpiSnapshot(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: { readonly runtime: GatewayRuntime; readonly credentials: CredentialStore },
): Promise<void> {
  const runtime = deps.runtime;
  const correlation_id = correlationIdOf(request, runtime);

  let operator: GatewayPrincipal;
  let query: SnapshotQuery;
  try {
    operator = requireOperator(request, 'telemetry:read');
    query = snapshotQuery(request);
  } catch (error) {
    await refuseOperation({ request, reply, runtime, operation: KPI_OPERATION, error });
    return;
  }

  let snapshot: KpiSnapshotResponse;
  try {
    snapshot = await runtime.kpi.snapshot({ tenant_id: operator.tenant_id, ...query });
  } catch (error) {
    await refuseOperation({ request, reply, runtime, operation: KPI_OPERATION, error });
    return;
  }

  await runtime.audit.record({
    tenant_id: operator.tenant_id,
    correlation_id,
    operation: KPI_OPERATION,
    principal_kind: operator.kind,
    outcome: 'ACCEPTED',
    ...(operator.operator_id !== undefined ? { operator_id: operator.operator_id } : {}),
    detail: {
      window: snapshot.window,
      timezone: snapshot.timezone,
      observed_at: snapshot.observed_at,
      metric_count: snapshot.metrics.length,
    },
  });

  reply.code(200).send(snapshot);
}

/**
 * Registers the R09 and R17 telemetry operations on the `/api/v1` instance.
 *
 * @param app The Fastify instance the routes are attached to.
 * @param deps The runtime bundle plus the credential store the authentication hook resolves against.
 */
export function registerTelemetryRoutes(
  app: FastifyInstance,
  deps: { readonly runtime: GatewayRuntime; readonly credentials: CredentialStore },
): void {
  app.get('/telemetry/stream', { preHandler: authenticate(deps) }, (request, reply) =>
    handleStream(request, reply, deps),
  );

  app.get('/telemetry/kpi-snapshot', { preHandler: authenticate(deps) }, (request, reply) =>
    handleKpiSnapshot(request, reply, deps),
  );
}
