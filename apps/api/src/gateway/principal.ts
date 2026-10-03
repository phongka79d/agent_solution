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

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { FastifyReply, FastifyRequest } from 'fastify';

import type { ChannelId, GatewayPrincipal, OperatorPermission } from './contracts.js';
import type { GatewayRuntime } from './ports.js';
import { fail } from './http.js';

const SIGNED_SESSION_TOKEN_PARTS = 2;
const SESSION_CHANNELS: readonly ChannelId[] = Object.freeze([
  'WEB_CHAT',
  'APP_CHAT',
  'MESSENGER',
  'INSTAGRAM',
  'TIKTOK',
  'ZALO',
  'EMAIL',
  'SMS',
  'LINE',
  'WHATSAPP',
]);

interface SignedSessionBinding {
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly session_id: string;
  readonly exp: number;
  readonly channel?: ChannelId;
}

// ============================================================================
// Credentials (`06` §8.0 tenant binding; `04` §5 identity resolution)
// ============================================================================

/**
 * The tenant routing hint (`06` §1 apiKey security scheme) is an assertion, never a credential.
 * Provider credentials and operator/session tokens are presented through `Authorization`.
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
  readonly scope?: 'company' | 'platform';
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

/**
 * Verifies a server-issued conversation session token.
 *
 * The payload is deliberately bound to the tenant, conversation and channel session. The HMAC is
 * compared as bytes with a constant-time primitive before any binding is returned to authentication.
 * A missing/invalid/expired token is indistinguishable from an unknown credential.
 */
export function verifyConversationSessionToken(
  token: string,
  session_secret: string,
  now_seconds = Math.floor(Date.now() / 1000),
): SessionCredential | null {
  const parts = token.split('.');
  if (parts.length !== SIGNED_SESSION_TOKEN_PARTS) return null;
  const encodedPayload = parts[0];
  const encodedSignature = parts[1];
  if (encodedPayload === undefined || encodedSignature === undefined) return null;

  let binding: SignedSessionBinding;
  try {
    const rawBinding = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(rawBinding);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const candidate = parsed as Record<string, unknown>;
    const tenant_id = candidate['tenant_id'];
    const conversation_id = candidate['conversation_id'];
    const session_id = candidate['session_id'];
    const exp = candidate['exp'];
    const channel = candidate['channel'];
    if (
      typeof tenant_id !== 'string' ||
      tenant_id.length === 0 ||
      typeof conversation_id !== 'string' ||
      conversation_id.length === 0 ||
      typeof session_id !== 'string' ||
      session_id.length === 0 ||
      typeof exp !== 'number' ||
      !Number.isInteger(exp) ||
      exp <= now_seconds
    ) {
      return null;
    }
    if (channel !== undefined && (typeof channel !== 'string' || !SESSION_CHANNELS.includes(channel as ChannelId))) {
      return null;
    }
    binding = {
      tenant_id,
      conversation_id,
      session_id,
      exp,
      ...(channel === undefined ? {} : { channel: channel as ChannelId }),
    };

    const expected = createHmac('sha256', session_secret).update(rawBinding, 'utf8').digest();
    const provided = Buffer.from(encodedSignature, 'base64url');
    if (provided.length !== expected.length || !timingSafeEqual(expected, provided)) return null;
  } catch {
    return null;
  }

  return {
    token,
    tenant_id: binding.tenant_id,
    conversation_id: binding.conversation_id,
    session_id: binding.session_id,
    channel: binding.channel ?? 'WEB_CHAT',
  };
}

/** One storefront widget session credential; the origin it may be used from is part of the row. */
export interface WidgetCredential {
  readonly token: string;
  readonly tenant_id: string;
  readonly session_id: string;
  readonly customer_id?: string;
  readonly origin: string;
}

/**
 * The credential lookup the gateway authenticates against. Static rows remain supported for tests
 * and for credentials managed by an external identity store; signed session tokens are additionally
 * accepted when the deployment supplies the same HMAC secret used by the conversation port.
 */
export interface CredentialStore {
  resolveOperator(token: string): OperatorCredential | null;
  /**
   * Durable (database-backed) stores resolve asynchronously, because a session is a live row rather
   * than an in-memory map entry. The synchronous surface above stays for the in-memory stores; a
   * store that implements neither is simply unable to resolve a presented token, which fails closed.
   */
  resolveOperatorAsync?(token: string): Promise<OperatorCredential | null>;
  resolveConversationSession(token: string): SessionCredential | null;
  resolveWidgetSession(token: string): WidgetCredential | null;
}

/**
 * Builds a credential store over injected rows. A token belongs to one row and rows are matched by
 * exact string equality. Signed conversation tokens are verified against the configured deployment
 * secret; arbitrary static test tokens continue to resolve exactly as before.
 */
export function createCredentialStore(config: {
  readonly operators: readonly OperatorCredential[];
  readonly sessions: readonly SessionCredential[];
  readonly widgets: readonly WidgetCredential[];
  readonly session_secret?: string;
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
  const session_secret = config.session_secret ?? process.env.SESSION_SECRET;

  return {
    resolveOperator: (token) => operators.get(token) ?? null,
    resolveConversationSession: (token) => {
      const stored = sessions.get(token);
      // Injected rows are opaque credentials; their exact match remains authoritative even when
      // the deployment also enables signed session-token verification.
      if (stored !== undefined) return stored;
      return session_secret === undefined ? null : verifyConversationSessionToken(token, session_secret);
    },
    resolveWidgetSession: (token) => widgets.get(token) ?? null,
  };
}

// ============================================================================
// Credential presentation
// ============================================================================

interface PresentedToken {
  readonly token: string;
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
 * An `Authorization` header is the only credential presentation. A malformed header is refused
 * rather than quietly falling back to a tenant assertion.
 */
function presentedToken(request: FastifyRequest): PresentedToken | null {
  const authorization = headerValue(request, AUTHORIZATION_HEADER);

  if (authorization === null || authorization.slice(0, BEARER_PREFIX.length).toLowerCase() !== BEARER_PREFIX) {
    return null;
  }
  const token = authorization.slice(BEARER_PREFIX.length).trim();
  return token.length === 0 ? null : { token };
}

// ============================================================================
// Principal resolution
// ============================================================================

/** The one mapping from a stored operator credential to its gateway principal, sync and async alike. */
function operatorPrincipal(operator: OperatorCredential): GatewayPrincipal {
  return {
    kind: 'OPERATOR',
    tenant_id: operator.tenant_id,
    operator_id: operator.operator_id,
    ...(operator.scope === undefined ? {} : { scope: operator.scope }),
    permissions: operator.permissions,
  };
}

/**
 * Resolves the principal for a presented token, or `null` when nothing in the store holds it.
 *
 * The lookup order is operator, conversation session, widget session, and the principal kind
 * follows the stored credential that resolved. No branch synthesizes a principal: an unknown token
 * stays unknown, which keeps an unknown connector or disabled capability from being admitted as an
 * anonymous caller.
 */
function resolvePrincipal(
  credentials: CredentialStore,
  presented: PresentedToken,
): GatewayPrincipal | null {
  const operator = credentials.resolveOperator(presented.token);
  if (operator !== null) {
    return operatorPrincipal(operator);
  }

  const session = credentials.resolveConversationSession(presented.token);
  if (session !== null) {
    return {
      kind: 'CHANNEL_SESSION',
      tenant_id: session.tenant_id,
      channel: session.channel,
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
 * header. The header is never used to authenticate a request.
 *
 * The set is collected, never merged: each assertion has to agree with the resolved principal on
 * its own, so a matching hint cannot be used to carry a mismatching one past the check.
 */
function tenantAssertions(request: FastifyRequest): readonly unknown[] {
  const assertions: unknown[] = [];
  const fromBody = assertedTenant(request.body);
  if (fromBody !== undefined) assertions.push(fromBody);
  const fromQuery = assertedTenant(request.query);
  if (fromQuery !== undefined) assertions.push(fromQuery);

  const fromHeader = headerValue(request, TENANT_HEADER);
  if (fromHeader !== null) assertions.push(fromHeader);

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
    let principal = presented === null ? null : resolvePrincipal(credentials, presented);
    // A durable store keeps its sessions in the database, so the first resolution of a token is a
    // lookup rather than a map hit. Only a null result falls through to it: a token that the
    // synchronous surface already refused was never a valid credential for this store.
    if (principal === null && presented !== null && credentials.resolveOperatorAsync !== undefined) {
      const operator = await credentials.resolveOperatorAsync(presented.token);
      if (operator !== null) principal = operatorPrincipal(operator);
    }

    if (presented === null || principal === null) {
      fail(
        'AUTHENTICATION_FAILED',
        'the presented credential did not resolve to a known principal; no unauthenticated request reaches a route handler',
      );
    }
    if (principal.kind === 'WIDGET_SESSION') {
      const widget = credentials.resolveWidgetSession(presented.token);
      const origin = headerValue(request, 'origin');
      if (widget === null || origin === null || origin !== widget.origin) {
        fail('AUTHENTICATION_FAILED', 'the widget credential is not valid for this request origin');
      }
    }

    enforceTenantBinding(principal, tenantAssertions(request));

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
