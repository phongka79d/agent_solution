/**
 * @file R15 `GET /api/v1/customers/{customer_id}/timeline` (implement/06 §8.1.3 R15; `03` §8
 * ten-stage projection, `04` §5 identity verdicts).
 *
 * The route is a read: it writes exactly one audit row and no evidence row (`06` §8.0). It carries
 * exactly one operation — the SCR-004 timeline — and no second telemetry read: R17 lives with the
 * other telemetry operations.
 *
 * The path identifier is a *claim*, not a binding. Before anything is projected, the injected
 * identity port has to confirm the customer resolves inside the authenticated tenant; a claim that
 * does not resolve is refused `CUSTOMER_UNVERIFIED` rather than answered with an empty page, because
 * an empty projection is the port's statement that the timeline is empty and must never be
 * manufactured by the gateway. Gaps inside a real timeline arrive as entries carrying `gap_reason`.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { CursorPage, GatewayPrincipal, TimelineEntry } from '../../gateway/contracts.js';
import { correlationIdOf, fail, mapError, replyFailure } from '../../gateway/http.js';
import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator, requirePrincipal } from '../../gateway/principal.js';
import type { GatewayRuntime } from '../../gateway/ports.js';

/** The one operation this module serves. */
const TIMELINE_OPERATION = 'GET /api/v1/customers/{customer_id}/timeline';

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

/** The R15 query, verbatim; ordering and window semantics belong to the projection. */
interface TimelineQuery {
  readonly cursor?: string;
  readonly limit?: number;
  readonly from?: string;
  readonly to?: string;
}

/** Reads the R15 query; absent parameters stay absent so the port applies its own defaults. */
function timelineQuery(request: FastifyRequest): TimelineQuery {
  const cursor = stringField(request.query, 'cursor');
  const limit = limitField(request.query, 'limit');
  const from = stringField(request.query, 'from');
  const to = stringField(request.query, 'to');

  return {
    ...(cursor !== null ? { cursor } : {}),
    ...(limit !== null ? { limit } : {}),
    ...(from !== null ? { from } : {}),
    ...(to !== null ? { to } : {}),
  };
}

/**
 * R15. Projects the ten-stage timeline of one verified customer.
 *
 * The identity port is asked with the authenticated operator's own subject: R15 admits operators
 * only, that subject is the credential the caller actually presented, and the customer id in the
 * path is passed as the *claim* to verify — never as the answer.
 */
async function handleTimeline(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: { readonly runtime: GatewayRuntime; readonly credentials: CredentialStore },
): Promise<void> {
  const runtime = deps.runtime;
  const correlation_id = correlationIdOf(request, runtime);

  let operator: GatewayPrincipal;
  let customer_id: string;
  let claimed_customer_id: string;
  let query: TimelineQuery;
  try {
    operator = requireOperator(request, 'customer:read');
    const claimed = stringField(request.params, 'customer_id');
    if (claimed === null) {
      fail('VALIDATION_FAILED', 'customer_id is required in the path');
    }
    claimed_customer_id = claimed;
    query = timelineQuery(request);
  } catch (error) {
    await refuseOperation({ request, reply, runtime, operation: TIMELINE_OPERATION, error });
    return;
  }

  let page: CursorPage<TimelineEntry>;
  try {
    const subject = operator.session_id ?? operator.operator_id ?? null;
    if (subject === null) {
      fail(
        'CUSTOMER_UNVERIFIED',
        'the request presents no authenticated subject to resolve a customer against; a private lookup needs a verified binding, not a claimed identifier',
      );
    }

    const resolution = await runtime.identity.resolveCustomer({
      tenant_id: operator.tenant_id,
      session_id: subject,
      channel_type: 'OPERATOR',
      claimed_customer_id,
    });

    const resolvedCustomerId = resolution.customer_id;
    if (resolvedCustomerId === null || resolution.verdict !== 'OPERATOR_VERIFIED') {
      fail(
        'CUSTOMER_UNVERIFIED',
        'no tenant-scoped operator customer resolution could be established; the timeline is refused rather than projected from a claimed identifier',
      );
    }

    if (resolvedCustomerId !== claimed_customer_id) {
      fail(
        'CUSTOMER_UNVERIFIED',
        'the verified identity bound to this request is not the requested customer; a cross-customer private lookup is refused',
      );
    }

    // The authenticated, tenant-scoped resolution is the only customer id allowed into the read.
    customer_id = resolvedCustomerId;

    page = await runtime.timeline.timeline({
      tenant_id: operator.tenant_id,
      customer_id,
      ...query,
    });
  } catch (error) {
    await refuseOperation({ request, reply, runtime, operation: TIMELINE_OPERATION, error });
    return;
  }

  // The audit row names the customer the projection actually rendered, and the page shape, so the
  // read is reconstructible without writing an evidence row (R15 is a read, `06` §8.0).
  await runtime.audit.record({
    tenant_id: operator.tenant_id,
    correlation_id,
    operation: TIMELINE_OPERATION,
    principal_kind: operator.kind,
    outcome: 'ACCEPTED',
    ...(operator.operator_id !== undefined ? { operator_id: operator.operator_id } : {}),
    detail: {
      customer_id,
      entry_count: page.items.length,
      next_cursor: page.next_cursor,
      gap_count: page.items.filter((entry) => entry.gap_reason !== undefined).length,
    },
  });

  reply.code(200).send(page);
}

/**
 * Registers the R15 timeline read on the `/api/v1` instance.
 *
 * @param app The Fastify instance the route is attached to.
 * @param deps The runtime bundle plus the credential store the authentication hook resolves against.
 */
export function registerAnalyticsRoutes(
  app: FastifyInstance,
  deps: { readonly runtime: GatewayRuntime; readonly credentials: CredentialStore },
): void {
  app.get('/customers/:customer_id/timeline', { preHandler: authenticate(deps) }, (request, reply) =>
    handleTimeline(request, reply, deps),
  );
}
