/**
 * @file Server-side authentication and tenant binding for the `/api/v1` gateway
 * (implement/06 §8.0 "Tenant binding", §9.1; `03` §6 isolation matrix, NFR-006).
 *
 * The gateway resolves identity itself, and only from the injected credential store: there is no
 * token format it parses, no claim it trusts, no environment fallback and no default credential. A
 * request whose credential does not resolve is refused `AUTHENTICATION_FAILED` before any handler
 * runs; a protected route that somehow runs without a principal is refused the same way instead of
 * being served with an anonymous identity.
 *
 * The resolved principal's `tenant_id` is the isolation factor. A `tenant_id` in the body, the
 * query string or the `X-Tenant-ID` header is at most a routing hint: it is compared with the
 * principal's tenant, and a difference is `TENANT_BINDING_MISMATCH`. It never selects the tenant —
 * merging a caller-asserted tenant into the binding is the cross-tenant read the isolation matrix
 * forbids — and the refusal repeats neither value, so a probe cannot use it to confirm which tenant
 * a token belongs to.
 *
 * Authority comes from the stored credential alone. A permission the payload claims is not a
 * permission the operator holds, and the operator id a route acts on is never one the caller sent.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ChannelId, GatewayPrincipal, OperatorPermission } from './contracts.js';
import type { GatewayRuntime } from './ports.js';
import { fail } from './http.js';

// ============================================================================
// Credentials (`06` §8.0 tenant binding; `04` §5 identity resolution)
// ============================================================================

/**
 * The tenant routing hint (`06` §1 apiKey security scheme). A provider delivery presents its
 * opaque credential here; on a bearer-authenticated request the same header is only an assertion
 * that has to agree with the resolved principal.
 */
export const TENANT_HEADER = 'x-tenant-id';

/** The bearer presentation of an opaque token; the scheme is the only structure the gateway reads. */
export const AUTHORIZATION_HEADER = 'authorization';

/**
 * One operator credential. Authority is stored, not requested: `permissions` is what the operator
 * was granted, independent of anything a request body asserts.
 */
export interface OperatorCredential {
  readonly token: string;
  readonly tenant_id: string;
  readonly operator_id: string;
  readonly permissions: readonly OperatorPermission[];
}

/** One channel-bound session credential; it is bound to the conversation it was issued for. */
export interface SessionCredential {
  readonly token: string;
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly session_id: string;
  readonly channel: ChannelId;
}

/** One storefront widget session credential; the origin it may be used from is part of the row. */
export interface WidgetCredential {
  readonly token: string;
  readonly tenant_id: string;
  readonly session_id: string;
  readonly origin: string;
}

/**
 * The credential lookup the gateway authenticates against. Tokens are opaque: the only operation
 * is an exact lookup, so a credential the store does not hold authenticates nothing.
 */
export interface CredentialStore {
  resolveOperator(token: string): OperatorCredential | null;
  resolveConversationSession(token: string): SessionCredential | null;
  resolveWidgetSession(token: string): WidgetCredential | null;
}

/**
 * Builds a credential store over injected rows. It is a pure factory: no environment variable, no
 * file and no secret is read here, so a deployment (and a test) supplies exactly the credentials
 * it means to trust.
 *
 * A token belongs to one row. A token present in more than one set resolves by the lookup order
 * documented on {@link resolvePrincipal}, and rows are matched by exact string equality — never by
 * prefix, pattern or decoded structure.
 *
 * @param config The operator, session and widget rows this store resolves.
 * @returns A store whose lookups are `null` for every token it does not hold.
 */
export function createCredentialStore(config: {
  readonly operators: readonly OperatorCredential[];
  readonly sessions: readonly SessionCredential[];
  readonly widgets: readonly WidgetCredential[];
}): CredentialStore {
  const operators = new Map<string, OperatorCredential>(
    config.operators.map((credential) => [credential.token, credential]),
  );
  const sessions = new Map<string, SessionCredential>(
    config.sessions.map((credential) => [credential.token, credential]),
  );
  const widgets = new Map<string, WidgetCredential>(
    config.widgets.map((credential) => [credential.token, credential]),
  );

  return {
    resolveOperator: (token) => operators.get(token) ?? null,
    resolveConversationSession: (token) => sessions.get(token) ?? null,
    resolveWidgetSession: (token) => widgets.get(token) ?? null,
  };
}

// ============================================================================
// Credential presentation
// ============================================================================

/** Where the opaque token was presented. It decides what a header carries, never who the caller is. */
type CredentialSource = 'AUTHORIZATION' | 'TENANT_HEADER';

interface PresentedToken {
  readonly token: string;
  readonly source: CredentialSource;
}

/** The bearer scheme prefix; compared case-insensitively, as RFC 7235 requires. */
const BEARER_PREFIX = 'bearer ';

/** Reads a single-valued header, ignoring a repeated header rather than guessing between values. */
function headerValue(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Extracts the credential the request presented.
 *
 * An `Authorization` header, when present, IS the presentation: a malformed one is refused rather
 * than quietly falling back to another header, because a caller must not be able to probe which
 * of two credentials the gateway would honour. Without it, the `X-Tenant-ID` header carries the
 * provider delivery's opaque credential.
 */
function presentedToken(request: FastifyRequest): PresentedToken | null {
  const authorization = headerValue(request, AUTHORIZATION_HEADER);

  if (authorization !== null) {
    if (authorization.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) return null;
    const token = authorization.slice(BEARER_PREFIX.length).trim();
    return token.length === 0 ? null : { token, source: 'AUTHORIZATION' };
  }

  const provider = headerValue(request, TENANT_HEADER);
  return provider === null ? null : { token: provider, source: 'TENANT_HEADER' };
}

// ============================================================================
// Principal resolution
// ============================================================================

/**
 * Resolves the principal for a presented token, or `null` when nothing in the store holds it.
 *
 * The lookup order is operator, conversation session, widget session, and the principal kind
 * follows the credential that resolved — not the header it arrived in, so re-presenting the same
 * token elsewhere cannot change what the caller is. No branch synthesizes a principal: an unknown
 * token stays unknown, which is what keeps an unknown connector or a disabled capability failing
 * closed rather than being admitted as an anonymous caller.
 */
function resolvePrincipal(
  credentials: CredentialStore,
  presented: PresentedToken,
): GatewayPrincipal | null {
  const operator = credentials.resolveOperator(presented.token);
  if (operator !== null) {
    return {
      kind: 'OPERATOR',
      tenant_id: operator.tenant_id,
      operator_id: operator.operator_id,
      permissions: operator.permissions,
    };
  }

  const session = credentials.resolveConversationSession(presented.token);
  if (session !== null) {
    return {
      kind: 'CHANNEL_SESSION',
      tenant_id: session.tenant_id,
      conversation_id: session.conversation_id,
      session_id: session.session_id,
      // A session-bound caller holds no operator permission; authority is never implied by a session.
      permissions: [],
    };
  }

  const widget = credentials.resolveWidgetSession(presented.token);
  if (widget !== null) {
    return {
      kind: 'WIDGET_SESSION',
      tenant_id: widget.tenant_id,
      session_id: widget.session_id,
      permissions: [],
    };
  }

  return null;
}

// ============================================================================
// Tenant binding
// ============================================================================

/** The `tenant_id` a JSON object asserts, or `undefined` when the field is absent or `null`. */
function assertedTenant(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const asserted: unknown = (value as Record<string, unknown>)['tenant_id'];
  return asserted === undefined || asserted === null ? undefined : asserted;
}

/**
 * Every tenant the request asserts: the body's and the query's `tenant_id`, plus the `X-Tenant-ID`
 * header when it is not already the credential itself.
 *
 * The set is collected, never merged: each assertion has to agree with the resolved principal on
 * its own, so a matching hint cannot be used to carry a mismatching one past the check.
 */
function tenantAssertions(request: FastifyRequest, presented: PresentedToken): readonly unknown[] {
  const assertions: unknown[] = [];
  const fromBody = assertedTenant(request.body);
  if (fromBody !== undefined) assertions.push(fromBody);
  const fromQuery = assertedTenant(request.query);
  if (fromQuery !== undefined) assertions.push(fromQuery);

  if (presented.source === 'AUTHORIZATION') {
    const fromHeader = headerValue(request, TENANT_HEADER);
    if (fromHeader !== null) assertions.push(fromHeader);
  }

  return assertions;
}

/**
 * Refuses a request whose tenant assertion differs from the authenticated principal's tenant.
 *
 * The resolved principal always wins and the values are never echoed: the caller learns only that
 * the binding did not hold, which is what stops the refusal from being used to test whether some
 * other tenant's identifier exists.
 */
function enforceTenantBinding(principal: GatewayPrincipal, assertions: readonly unknown[]): void {
  for (const asserted of assertions) {
    if (asserted !== principal.tenant_id) {
      fail(
        'TENANT_BINDING_MISMATCH',
        'the request asserts a tenant that is not the authenticated principal\u2019s tenant; the resolved principal is the only isolation factor',
      );
    }
  }
}

// ============================================================================
// Hooks and guards
// ============================================================================

/**
 * Builds the Fastify `preHandler` that authenticates a request and binds it to its tenant.
 *
 * It is registered per route group by the composition root, so an unauthenticated request is
 * refused at the transport boundary and no handler observes a partially resolved identity.
 *
 * @param deps The credential store to resolve against and the runtime the gateway was built with.
 * @returns A `preHandler` that sets `request.gatewayPrincipal` or refuses the request.
 */
export function authenticate(deps: {
  readonly credentials: CredentialStore;
  readonly runtime: GatewayRuntime;
}): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  const { credentials } = deps;

  return async (request: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    const presented = presentedToken(request);
    const principal = presented === null ? null : resolvePrincipal(credentials, presented);

    if (presented === null || principal === null) {
      fail(
        'AUTHENTICATION_FAILED',
        'the presented credential did not resolve to a known principal; no unauthenticated request reaches a route handler',
      );
    }

    enforceTenantBinding(principal, tenantAssertions(request, presented));

    request.gatewayPrincipal = principal;
  };
}

/**
 * The authenticated principal of this request.
 *
 * A protected route calls this first, so a missing principal is a refusal and never a fall-through
 * to a handler that would have to invent one.
 *
 * @throws {GatewayFailureError} `AUTHENTICATION_FAILED` when nothing authenticated this request.
 */
export function requirePrincipal(request: FastifyRequest): GatewayPrincipal {
  const principal = request.gatewayPrincipal;
  if (principal === undefined) {
    fail(
      'AUTHENTICATION_FAILED',
      'this operation requires an authenticated principal and this request carries none',
    );
  }
  return principal;
}

/**
 * The authenticated operator, with every listed permission.
 *
 * Both the identity and the authority come from the resolved credential: a non-operator principal
 * is refused even when it lists the permission, and the returned `operator_id` is the stored one,
 * so a payload-supplied operator id can never become the principal a decision is attributed to.
 *
 * @param request The request whose principal is being authorized.
 * @param permissions The permissions the operation requires; all of them must be held.
 * @throws {GatewayFailureError} `INSUFFICIENT_AUTHORITY` for a non-operator principal or a missing
 *   permission.
 */
export function requireOperator(
  request: FastifyRequest,
  ...permissions: readonly OperatorPermission[]
): GatewayPrincipal {
  const principal = requirePrincipal(request);

  if (principal.kind !== 'OPERATOR') {
    fail(
      'INSUFFICIENT_AUTHORITY',
      'this operation requires an authenticated operator principal; a session-bound or widget principal is not an operator',
    );
  }

  const missing = permissions.filter((permission) => !principal.permissions.includes(permission));
  if (missing.length > 0) {
    fail(
      'INSUFFICIENT_AUTHORITY',
      'the authenticated operator does not hold every permission this operation requires',
      { missing_permissions: missing },
    );
  }

  return principal;
}
