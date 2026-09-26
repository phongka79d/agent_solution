/**
 * @file R11 `POST /api/v1/storefront/stream` and R12 `POST /api/v1/storefront/events`
 * (implement/06 §8.1.2 R11, R12; `06` §3.0 canonical event contract, `04` §4.4).
 *
 * Both surfaces belong to the first-party storefront widget and to nothing else: the caller must
 * present a `WIDGET_SESSION` credential, and an operator token is refused `INSUFFICIENT_AUTHORITY`
 * rather than being served under the widget's tenant. The tenant is always the token's.
 *
 * R11 drives the same durable path as R02 — bind the conversation, claim the idempotency slot,
 * start the run, settle the receipt — and streams the turn as chunked text, because a widget turn
 * is long enough that the caller needs the durable receipt before the answer. R12 stores one event
 * envelope; the canonical-event derivation belongs to the connector layer (`packages/adapters`
 * API-002) and arrives through `deps.normalizer`, so this module holds no alias table. When that
 * binding is absent the envelope is stored under its raw `event_type` and reported `IGNORED`: a
 * gateway-side guess at a canonical name would silently mis-route every downstream signal.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type {
  AgentModule,
  EventIngestionResponse,
  EventIngestionStatus,
  GatewayPrincipal,
  TaskStoredState,
  TaskWireStatus,
} from '../../gateway/contracts.js';
import { IDEMPOTENCY_KEY_MAX_LENGTH, MESSAGE_MAX_LENGTH } from '../../gateway/contracts.js';
import { correlationIdOf, fail, mapError, replyFailure } from '../../gateway/http.js';
import {
  admitCareTurn,
  parseEnabledAgentModules,
  validateAdmissionEventType,
} from './care-turn.js';
import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requirePrincipal } from '../../gateway/principal.js';
import type { ConversationRecord, GatewayRuntime } from '../../gateway/ports.js';

/** Audit operation names; each route spells its own once. */
const STREAM_OPERATION = 'POST /api/v1/storefront/stream';
const EVENT_OPERATION = 'POST /api/v1/storefront/events';

/** The widget channel: a storefront turn and a storefront event are both Web Chat traffic. */
const WIDGET_CHANNEL = 'WEB_CHAT';


/** The four `AgentModule` values of `06` §1; any other value is not the declared body shape. */
const AGENT_MODULES: readonly AgentModule[] = Object.freeze(['marketing', 'sales', 'support', 'auto']);

/** How long the turn waits on a competing in-flight delivery, and how often it re-reads its run. */
const WAIT_ATTEMPTS = 10;
const WAIT_INTERVAL_MS = 250;


/** The canonical-event derivation owned by the connector layer; the gateway only consumes it. */
export interface StorefrontEventNormalizer {
  canonicalEventOf(event_type: string): {
    readonly canonical_event: string | null;
    readonly stored_event_name: string;
    readonly alias_table_version?: number;
  };
}

/** The storefront route dependencies; `normalizer` is optional so a missing binding degrades to R12's raw path. */
export interface StorefrontRouteDeps {
  readonly runtime: GatewayRuntime;
  readonly credentials: CredentialStore;
  /** Bound by the composition root once `packages/adapters` API-002 is available. */
  readonly normalizer?: StorefrontEventNormalizer;
  readonly enabledModules?: readonly string[];
  readonly salesSignalEventTypes?: readonly string[];
  readonly marketingSignalEventTypes?: readonly string[];
}

/** An ISO-8601 instant: a date, a time to the second, and an explicit UTC offset or `Z`. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Reads a non-empty string field without asserting the object's shape. */
function stringField(value: unknown, key: string): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const field: unknown = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

/** Reads a nested JSON object field, or `null` when it is absent or not an object. */
function recordField(value: unknown, key: string): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const field: unknown = (value as Record<string, unknown>)[key];
  if (typeof field !== 'object' || field === null || Array.isArray(field)) return null;
  return field as Record<string, unknown>;
}

/** The JSON object body, or a refusal: a widget turn and an event delivery are both object-shaped. */
function bodyRecord(request: FastifyRequest): Record<string, unknown> {
  const body: unknown = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    fail('VALIDATION_FAILED', 'a JSON object body is required');
  }
  return body as Record<string, unknown>;
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
 * The first-party storefront widget session, or a refusal.
 *
 * `requireOperator` is deliberately not used: it would refuse an operator for lacking widget
 * authority, which is true but states the wrong rule. This surface *is* the widget's, so the
 * refusal names the authority the caller does not hold.
 */
function requireWidgetSession(request: FastifyRequest): GatewayPrincipal {
  const principal = requirePrincipal(request);
  if (principal.kind !== 'WIDGET_SESSION') {
    fail(
      'INSUFFICIENT_AUTHORITY',
      'the storefront surface is served to a first-party widget session only; an operator credential is not a storefront caller',
    );
  }
  return principal;
}

/**
 * Writes the refusal's audit row and its canonical envelope.
 *
 * A request that never resolved a principal has no tenant to attribute, so no row is written: an
 * audit row under a caller-supplied tenant would be the cross-tenant write the isolation rules
 * forbid. The status comes from the frozen `FAILURE_STATUS` table through `replyFailure`.
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

/** One validated storefront turn. */
interface StorefrontTurn {
  readonly message: string;
  readonly idempotency_key: string;
  readonly module: AgentModule;
  readonly event_type: string;
  readonly attachments?: readonly string[];
  /** The binding of the turn: the body's `session_id`, else the one the widget token carries. */
  readonly session_id: string;
}

/** One validated storefront event delivery. */
interface StorefrontEvent {
  readonly event_id: string;
  readonly event_type: string;
  readonly occurred_at: string;
  readonly payload: Record<string, unknown>;
  /** The body's `session_id` when present, else the token's, else the event id (R12 binding). */
  readonly session_id: string;
}

/** Uses the authenticated widget session as the only session identity. */
function boundWidgetSessionId(principal: GatewayPrincipal, requested: string | null): string {
  const session_id = principal.session_id;
  if (session_id === undefined || session_id.length === 0) {
    fail('AUTHENTICATION_FAILED', 'the widget credential has no bound session identity');
  }
  if (requested !== null && requested !== session_id) {
    fail('AUTHENTICATION_FAILED', 'the widget session does not own the requested session identity');
  }
  return session_id;
}

/** Reads `attachments`: an array of strings, or absent. Anything else is not the declared shape. */
function attachmentsOf(body: Record<string, unknown>): readonly string[] | undefined {
  const raw: unknown = body['attachments'];
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.some((item) => typeof item !== 'string')) {
    fail('VALIDATION_FAILED', 'attachments must be an array of strings');
  }
  return raw as readonly string[];
}

/**
 * Validates the R11 body (`StorefrontStreamRequest` = `PostMessageRequest` plus `session_id`) and
 * binds the turn to a session. Message and idempotency key lengths are the frozen contract's.
 */
function readTurn(
  request: FastifyRequest,
  principal: GatewayPrincipal,
  configuredModules?: readonly string[],
  configuredSalesEventTypes?: readonly string[],
  configuredMarketingEventTypes?: readonly string[],
): StorefrontTurn {
  const body = bodyRecord(request);

  const message = stringField(body, 'message');
  if (message === null || message.length > MESSAGE_MAX_LENGTH) {
    fail('VALIDATION_FAILED', `message is required and must not exceed ${MESSAGE_MAX_LENGTH} characters`);
  }

  const idempotency_key = stringField(body, 'idempotency_key');
  if (idempotency_key === null || idempotency_key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    fail(
      'VALIDATION_FAILED',
      `idempotency_key is required and must not exceed ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
    );
  }

  const requestedModule = stringField(body, 'module');
  if (requestedModule !== null && !AGENT_MODULES.some((member) => member === requestedModule)) {
    fail('VALIDATION_FAILED', 'module must be one of the declared agent modules (06 §1)');
  }
  const module = requestedModule === null || requestedModule === 'auto' ? 'support' : (requestedModule as AgentModule);
  const enabledModules = configuredModules ?? parseEnabledAgentModules(process.env.ENABLED_AGENT_MODULES);
  if (!enabledModules.includes(module)) {
    fail('CAPABILITY_NOT_ENABLED', 'only Customer Care support turns are enabled');
  }

  const rawEventType = body['event_type'];
  const eventTypeOptions = configuredSalesEventTypes !== undefined || configuredMarketingEventTypes !== undefined
    ? {
        ...(configuredSalesEventTypes === undefined ? {} : { salesSignalEventTypes: configuredSalesEventTypes }),
        ...(configuredMarketingEventTypes === undefined ? {} : { marketingSignalEventTypes: configuredMarketingEventTypes }),
      }
    : undefined;
  const event_type = validateAdmissionEventType(rawEventType, module, eventTypeOptions);

  const session_id = boundWidgetSessionId(principal, stringField(body, 'session_id'));

  const attachments = attachmentsOf(body);

  return {
    message,
    idempotency_key,
    module,
    event_type,
    ...(attachments !== undefined ? { attachments } : {}),
    session_id,
  };
}

/**
 * Validates the R12 body (`PlatformEventEnvelope` plus `session_id`).
 *
 * Only the three fields the ingestion actually needs are enforced: without an event id there is
 * nothing to deduplicate on, and without an instant the event has no place in the projection. A
 * missing `payload` is stored as an empty object rather than refused — the field carries data, not
 * identity — and `source` is recorded by the connector layer, which is the only layer that owns
 * canonical derivation.
 */
function readEvent(request: FastifyRequest, principal: GatewayPrincipal): StorefrontEvent {
  const body = bodyRecord(request);

  const event_id = stringField(body, 'event_id');
  if (event_id === null) {
    fail('VALIDATION_FAILED', 'event_id is required');
  }

  const event_type = stringField(body, 'event_type');
  if (event_type === null) {
    fail('VALIDATION_FAILED', 'event_type is required');
  }

  const occurred_at = stringField(body, 'occurred_at');
  if (occurred_at === null || !ISO_INSTANT.test(occurred_at) || Number.isNaN(Date.parse(occurred_at))) {
    fail('VALIDATION_FAILED', 'occurred_at is required and must be an ISO-8601 instant');
  }

  return {
    event_id,
    event_type,
    occurred_at,
    payload: recordField(body, 'payload') ?? {},
    session_id: boundWidgetSessionId(principal, stringField(body, 'session_id')),
  };
}

/**
 * The `06` §8.3 C-8 projection: stored `queued` is the wire's `accepted`, every other state is
 * returned verbatim. A turn's streamed status must never spell `queued`, which is why the mapping
 * lives beside the stream rather than in the receipt.
 */
function wireStatusOf(state: TaskStoredState): TaskWireStatus {
  return state === 'queued' ? 'accepted' : state;
}

/** The durable run a stored receipt refers to, when the receipt carries one. */
function runIdOf(receipt: Record<string, unknown>): string | null {
  const task_id: unknown = receipt['task_id'];
  return typeof task_id === 'string' && task_id.length > 0 ? task_id : null;
}

/**
 * A bounded wait between the turn's poll attempts. The wait exists because a durable run is
 * asynchronous: the gateway never blocks a widget's connection until an agent finishes, and never
 * claims an answer it has not read.
 */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}


/**
 * R11. Binds the conversation through the shared Care admission path, then streams the reply as
 * chunked text: the accepted (or cached) receipt first, then the run's answer once it reaches a
 * terminal state, or a truthful pending marker when it has not.
 *
 * The reply is hijacked because the receipt has to reach the widget before the run finishes; a
 * single `send()` could not emit the first chunk early. Every refusal therefore leaves `fail()`
 * before the hijack, and only the answer path writes to the raw socket afterwards.
 */
async function handleStream(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: StorefrontRouteDeps,
): Promise<void> {
  const runtime = deps.runtime;
  const correlation_id = correlationIdOf(request, runtime);

  let principal: GatewayPrincipal;
  let turn: StorefrontTurn;
  try {
    principal = requireWidgetSession(request);
    turn = readTurn(request, principal, deps.enabledModules, deps.salesSignalEventTypes, deps.marketingSignalEventTypes);
  } catch (error) {
    await refuseOperation({ request, reply, runtime, operation: STREAM_OPERATION, error });
    return;
  }

  let receipt: Record<string, unknown>;
  let conversation_id: string;
  let replayed = false;
  try {
    const resolution = await runtime.identity.resolveCustomer({
      tenant_id: principal.tenant_id,
      session_id: turn.session_id,
      channel_type: WIDGET_CHANNEL,
    });

    const conversation: ConversationRecord = await runtime.conversations.bindOrCreate({
      tenant_id: principal.tenant_id,
      channel: WIDGET_CHANNEL,
      external_thread_id: turn.session_id,
      customer_id: resolution.customer_id,
    });
    conversation_id = conversation.conversation_id;

    const admission = await admitCareTurn({
      runtime,
      principal,
      conversation,
      correlation_id,
      request_id: turn.idempotency_key,
      message: turn.message,
      module: turn.module,
      event_type: turn.event_type,
      ...(turn.attachments === undefined ? {} : { attachments: turn.attachments }),
      operation: STREAM_OPERATION,
    });
    receipt = admission.receipt;
    replayed = admission.replayed;
  } catch (error) {
    await refuseOperation({ request, reply, runtime, operation: STREAM_OPERATION, error });
    return;
  }

  await runtime.audit.record({
    tenant_id: principal.tenant_id,
    correlation_id,
    operation: STREAM_OPERATION,
    principal_kind: principal.kind,
    outcome: 'ACCEPTED',
    detail: {
      conversation_id,
      session_id: turn.session_id,
      request_id: turn.idempotency_key,
      run_id: runIdOf(receipt),
      replayed,
    },
  });

  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'transfer-encoding': 'chunked',
  });
  raw.flushHeaders();

  // The first chunk is the durable receipt: the widget learns `task_id` and `correlation_id` before
  // any answer exists, which is what makes the turn resumable rather than a hanging request.
  raw.write(`${JSON.stringify(receipt)}\n`);

  const run_id = runIdOf(receipt);
  if (run_id === null) {
    raw.write('\n[pending: unknown]\n');
    raw.end();
    return;
  }

  try {
    let answered = false;
    let last_state: TaskStoredState | null = null;

    for (let attempt = 0; attempt < WAIT_ATTEMPTS && !answered; attempt += 1) {
      if (attempt > 0) await delay(WAIT_INTERVAL_MS);
      const run = await runtime.runs.read({ tenant_id: principal.tenant_id, run_id });
      if (run === null) continue;

      const terminal =
        run.lifecycle_state === 'completed' ||
        run.lifecycle_state === 'stopped' ||
        run.lifecycle_state === 'failed';

      if (!terminal) {
        last_state = run.lifecycle_state;
        continue;
      }

      answered = true;
      raw.write(
        run.answer === undefined
          ? `\n[status: ${wireStatusOf(run.lifecycle_state)}]\n`
          : `\n${run.answer}\n`,
      );
    }

    // A truthful marker, never an invented answer: the run exists and is still moving (or could not
    // be read), and the widget re-reads it through R03 rather than being told it completed.
    if (!answered) {
      raw.write(`\n[pending: ${last_state === null ? 'unknown' : wireStatusOf(last_state)}]\n`);
    }

    raw.end();
  } catch {
    raw.write('\n[pending: unknown]\n');
    raw.end();
  }
}

/**
 * R12. Appends one storefront event envelope through the durable ingestion.
 *
 * Canonical derivation is not performed here by construction: the envelope is normalised by the
 * connector layer, and without that binding the raw `event_type` is stored and the delivery is
 * reported `IGNORED` — the frozen vocabulary's way of saying the event was accepted for storage
 * but did not resolve to a canonical event this platform routes on.
 */
async function handleEvent(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: StorefrontRouteDeps,
): Promise<void> {
  const runtime = deps.runtime;
  const correlation_id = correlationIdOf(request, runtime);

  let principal: GatewayPrincipal;
  let event: StorefrontEvent;
  try {
    principal = requireWidgetSession(request);
    event = readEvent(request, principal);
  } catch (error) {
    await refuseOperation({ request, reply, runtime, operation: EVENT_OPERATION, error });
    return;
  }

  let response: EventIngestionResponse;
  let detail: Record<string, unknown>;
  try {
    const derived =
      deps.normalizer === undefined
        ? null
        : deps.normalizer.canonicalEventOf(event.event_type);
    const stored_event_name = derived === null ? event.event_type : derived.stored_event_name;

    const appended = await runtime.events.append({
      tenant_id: principal.tenant_id,
      source_event_id: event.event_id,
      event_name: stored_event_name,
      session_id: event.session_id,
      channel: WIDGET_CHANNEL,
      customer_id: null,
      occurred_at: event.occurred_at,
      payload: event.payload,
    });

    const status: EventIngestionStatus =
      derived !== null && appended.inserted ? 'QUEUED' : 'IGNORED';

    response = { event_id: event.event_id, correlation_id, status };
    detail = {
      event_id: event.event_id,
      event_type: event.event_type,
      stored_event_name,
      canonical_event: derived === null ? null : derived.canonical_event,
      deduplicated: !appended.inserted,
      status,
    };
  } catch (error) {
    await refuseOperation({ request, reply, runtime, operation: EVENT_OPERATION, error });
    return;
  }

  await runtime.audit.record({
    tenant_id: principal.tenant_id,
    correlation_id,
    operation: EVENT_OPERATION,
    principal_kind: principal.kind,
    outcome: 'ACCEPTED',
    detail,
  });

  reply.code(202).send(response);
}

/**
 * Registers the two storefront operations on the `/api/v1` instance.
 *
 * @param app The Fastify instance the routes are attached to.
 * @param deps The runtime bundle, the credential store, and the optional connector-layer normalizer.
 */
export function registerStorefrontRoutes(app: FastifyInstance, deps: StorefrontRouteDeps): void {
  app.post('/storefront/stream', { preHandler: authenticate(deps) }, (request, reply) =>
    handleStream(request, reply, deps),
  );

  app.post('/storefront/events', { preHandler: authenticate(deps) }, (request, reply) =>
    handleEvent(request, reply, deps),
  );
}
