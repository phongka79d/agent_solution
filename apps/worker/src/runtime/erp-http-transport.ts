import type {
  ErpTransport,
  ErpTransportFailureClass,
  ErpTransportRequest,
  HmacSha256Hex,
} from '@agentos/adapters';

/**
 * The host half of the API-001 boundary (`06` §2).
 *
 * `Api001ErpConnector` names routes and refuses unobserved outcomes; it owns no socket. This module
 * is the wire it is pointed at: it builds the absolute URL, signs the exact bytes it sends, scopes
 * the call to one tenant, applies a deadline, and classifies what came back. The classification is
 * the load-bearing part — a caller that cannot tell "the provider refused" from "we do not know"
 * either retries an effect that already happened or drops one that did not.
 *
 * It lives in the worker, not in `@agentos/adapters`: that package declares connectors and stays
 * runtime-agnostic (no socket, no clock, no crypto), while the process that owns the provider
 * credential is the one allowed to open the connection.
 *
 * Nothing here reads the environment, and no secret is ever returned, logged or embedded in a
 * failure: a `PROVIDER_REJECTED` and an `UNKNOWN` carry a status and nothing else.
 */

/** Minimal response shape this transport needs. Kept structural so the package needs no DOM lib. */
export interface ErpHttpResponse {
  readonly status: number;
  text(): Promise<string>;
}

/** Minimal request shape; the injected fetch receives exactly the bytes that were signed. */
export interface ErpHttpRequestInit {
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

/** The fetch implementation the transport uses; injected so a test binds no socket. */
export type ErpFetchLike = (url: string, init: ErpHttpRequestInit) => Promise<ErpHttpResponse>;

export interface ErpHttpTransportOptions {
  /** Provider origin (and optional base path) taken from configuration, e.g. `http://localhost:8081/api/v1`. */
  readonly base_url: string;
  /** Shared secret for the provider signature; `[UNCONFIRMED][ASM-001]` which scheme the provider uses. */
  readonly hmac_secret: string;
  /** HMAC primitive supplied by the host, so this package never imports a crypto implementation. */
  readonly hmac: HmacSha256Hex;
  /** Deadline in milliseconds; an exceeded deadline is `TIMEOUT`, never a success. Defaults to 5000. */
  readonly timeout_ms?: number;
  /** Header carrying the tenant scope. Defaults to `x-tenant-id`. */
  readonly tenant_header?: string;
  /** Header carrying the hex signature. Defaults to `x-signature-sha256`. */
  readonly signature_header?: string;
  /** Constant provider headers a deployment needs (never credentials echoed back to a caller). */
  readonly extra_headers?: Readonly<Record<string, string>>;
  /** Transport implementation. Defaults to the global `fetch`. */
  readonly fetch?: ErpFetchLike;
}

const DEFAULT_TENANT_HEADER = 'x-tenant-id';
const DEFAULT_SIGNATURE_HEADER = 'x-signature-sha256';
const DEFAULT_TIMEOUT_MS = 5_000;

/**
 * Builds the API-001 host wire.
 *
 * @param options Provider location, signature material and transport.
 * @returns A transport that returns classified outcomes and never throws a provider failure.
 * @throws Error when the configuration cannot address a provider. Refusing at construction keeps a
 *   misconfigured deployment from starting and then reporting every read as unconfirmed.
 */
export function createErpHttpTransport(options: ErpHttpTransportOptions): ErpTransport {
  const base = parseBaseUrl(options.base_url);

  if (options.hmac_secret.length === 0) {
    throw new Error('ERP_HMAC_SECRET_REQUIRED: an unsigned API-001 call is refused at composition');
  }

  const timeout_ms = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeout_ms) || timeout_ms <= 0) {
    throw new Error('ERP_TIMEOUT_INVALID: the request deadline must be a positive integer');
  }

  const tenant_header = options.tenant_header ?? DEFAULT_TENANT_HEADER;
  const signature_header = options.signature_header ?? DEFAULT_SIGNATURE_HEADER;
  const extra_headers = options.extra_headers ?? {};
  const fetchImpl = options.fetch ?? (globalThis.fetch as unknown as ErpFetchLike);

  return {
    request: async (input: ErpTransportRequest) => {
      const body = input.body === undefined ? '' : JSON.stringify(input.body);

      let target: string;
      try {
        target = resolveRouteUrl(base, input.path);
      } catch {
        // The request never left the process, so the provider cannot have applied anything: a
        // confirmed no-effect is the truthful class, not an indeterminate one.
        return failure('PROVIDER_REJECTED', null);
      }

      const headers: Record<string, string> = {
        accept: 'application/json',
        [tenant_header]: input.tenant_id,
        [signature_header]: options.hmac(options.hmac_secret, body),
        ...extra_headers,
      };
      if (input.method === 'POST') {
        headers['content-type'] = 'application/json';
      }

      // A host-side deadline. It is passed to the transport rather than enforced by a timer here, so
      // a hung provider surfaces as an aborted call whose outcome is indeterminate — never as a
      // success and never as a refusal.
      const deadline = AbortSignal.timeout(timeout_ms);

      try {
        const response = await fetchImpl(target, {
          method: input.method,
          headers,
          ...(input.method === 'POST' ? { body } : {}),
          signal: deadline,
        });

        if (response.status >= 200 && response.status < 300) {
          return await confirmed(response);
        }

        return failure(classifyStatus(response.status), response.status);
      } catch {
        // An aborted deadline proves nothing about the provider; a network error before a response
        // proves just as little. Both are indeterminate, and neither is reported as a refusal.
        return failure(deadline.aborted ? 'TIMEOUT' : 'UNKNOWN', null);
      }
    },
  };
}

/** One classified failure. It carries no provider payload and no secret. */
function failure(
  failure_class: ErpTransportFailureClass,
  status: number | null,
): { readonly ok: false; readonly failure_class: ErpTransportFailureClass; readonly status: number | null } {
  return { ok: false, failure_class, status };
}

/**
 * Reads a 2xx body as the provider envelope.
 *
 * A 2xx whose body is not a JSON object is reported `UNKNOWN`: there is no envelope to copy an
 * observation timestamp or a document reference from, and inventing either would date a fact the
 * provider never stated.
 */
async function confirmed(
  response: ErpHttpResponse,
): Promise<
  | { readonly ok: true; readonly status: number; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly failure_class: ErpTransportFailureClass; readonly status: number | null }
> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return failure('UNKNOWN', response.status);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return failure('UNKNOWN', response.status);
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return failure('UNKNOWN', response.status);
  }

  return { ok: true, status: response.status, body: parsed as Record<string, unknown> };
}

/**
 * Maps an HTTP status to a retry class (`06` §8.1, R13).
 *
 * A 4xx proves the provider refused the call, so the effect did not happen and the action stays
 * retryable or terminally refused on its own terms. A 5xx, a 408 and a 429 leave the outcome open:
 * the provider may have applied the write before it failed, so the caller must reconcile by
 * `effect_key` rather than retry blind.
 */
function classifyStatus(status: number): ErpTransportFailureClass {
  if (status === 408 || status === 429) return 'TIMEOUT';
  if (status >= 400 && status < 500) return 'PROVIDER_REJECTED';
  return 'UNKNOWN';
}

/** A parsed provider location. Kept as plain strings so this package needs no URL global. */
interface ParsedBaseUrl {
  /** Scheme and authority, e.g. `http://localhost:8081`. */
  readonly origin: string;
  /** Configured base path without a trailing slash, or `''`. */
  readonly base_path: string;
}

/** `scheme://authority` plus an optional path; a query or fragment is refused. */
const BASE_URL_PATTERN = /^(https?):\/\/([^/?#]+)(\/[^?#]*)?$/;

/**
 * Parses and validates the configured provider origin.
 *
 * The authority is required to be non-empty, so `http:///api/v1` — a URL that would resolve to the
 * local host at runtime — is refused here instead of silently reaching whatever answers locally.
 */
function parseBaseUrl(base_url: string): ParsedBaseUrl {
  const match = BASE_URL_PATTERN.exec(base_url);
  const authority = match?.[2] ?? '';

  if (match === null || authority.length === 0) {
    throw new Error(
      'ERP_BASE_URL_INVALID: ERP_API_BASE_URL must be an absolute http(s) URL with a host',
    );
  }

  return {
    origin: `${match[1] ?? ''}://${authority}`,
    base_path: (match[3] ?? '').replace(/\/+$/, ''),
  };
}

/**
 * Resolves a connector route against the configured origin.
 *
 * The connector's routes are origin-absolute (`/api/v1/...`) while `ERP_API_BASE_URL` may itself
 * carry the API prefix. A configured base path therefore acts as an assertion: when it is present,
 * the route must sit inside it. A mismatch is refused instead of silently producing
 * `/api/v1/api/v1/...`, which a provider would answer with a 404 that reads like a data problem.
 *
 * @throws Error `ERP_BASE_PATH_MISMATCH` when the route falls outside the configured base path.
 */
function resolveRouteUrl(base: ParsedBaseUrl, path: string): string {
  const { base_path } = base;

  if (base_path !== '' && path !== base_path && !path.startsWith(`${base_path}/`)) {
    throw new Error(
      `ERP_BASE_PATH_MISMATCH: route '${path}' is outside the configured base path '${base_path}'`,
    );
  }

  return `${base.origin}${path}`;
}
