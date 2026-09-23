/**
 * @file The gateway's single refusal and correlation path (implement/06 §1 `ErrorResponse`,
 * §8.0 conventions; `08` §9 "all free-text errors sanitized").
 *
 * A route raises `fail(...)`; the transport layer maps it to the canonical envelope. No route
 * hand-rolls a status code, and no driver, provider or stack message reaches a response body —
 * the message is always a literal chosen by the raising site.
 *
 * The canonical code vocabulary belongs to `./contracts.ts`; this module owns only the mapping
 * from the engine's and the skill layer's typed refusals onto it.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { FAILURE_STATUS, type ErrorResponse, type GatewayErrorCode_, type GatewayFailure, type GatewayPrincipal } from './contracts.js';
import type { GatewayRuntime } from './ports.js';

/** Correlation header accepted from the caller; the gateway never trusts it as identity. */
export const CORRELATION_HEADER = 'x-correlation-id';

/** Internal carrier of a refusal. */
export class GatewayFailureError extends Error {
  public readonly failure: GatewayFailure;

  constructor(failure: GatewayFailure) {
    super(`${failure.error_code}: ${failure.message}`);
    this.name = 'GatewayFailureError';
    this.failure = failure;
  }
}

/** Builds a refusal with the canonical HTTP status for its code. */
export function failureFor(
  error_code: GatewayErrorCode_,
  message: string,
  details?: Record<string, unknown>,
): GatewayFailure {
  const http_status = FAILURE_STATUS[error_code];
  if (http_status === undefined) {
    throw new GatewayFailureError({
      error_code: 'INTERNAL_ERROR',
      http_status: 500,
      message: 'no status is declared for this refusal code',
      retryable: false,
    });
  }
  return {
    error_code,
    http_status,
    message,
    // A refusal that is safe to repeat is one the caller can correct by waiting; business-rule
    // refusals and conflicts are not retryable by construction.
    retryable: http_status === 429 || http_status === 503 || http_status === 500,
    ...(details === undefined ? {} : { details }),
  };
}

/** Raises a refusal; never returns. */
export function fail(
  error_code: GatewayErrorCode_,
  message: string,
  details?: Record<string, unknown>,
): never {
  throw new GatewayFailureError(failureFor(error_code, message, details));
}

/** Public envelope for a refusal (`06` §1). */
export function toErrorResponse(failure: GatewayFailure, correlation_id: string): ErrorResponse {
  return {
    error_code: failure.error_code,
    message: failure.message,
    retryable: failure.retryable,
    correlation_id,
    ...(failure.details === undefined ? {} : { details: failure.details }),
  };
}

// ============================================================================
// Typed refusals from the layers below
// ============================================================================

/**
 * Orchestrator codes (`04` §3.3) mapped onto the gateway vocabulary. A code with no mapping is an
 * `INTERNAL_ERROR`: an unmapped engine refusal must not be presented as one the caller can act on.
 */
const ORCHESTRATOR_CODE_MAP: Readonly<Record<string, GatewayErrorCode_>> = Object.freeze({
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  APPROVAL_BINDING_REQUIRED: 'APPROVAL_REQUIRED',
  APPROVAL_NOT_CLAIMABLE: 'APPROVAL_NOT_CLAIMABLE',
  AUTHORITY_DENIED: 'INSUFFICIENT_AUTHORITY',
  CONCURRENT_TASK_LOCK: 'RUN_LEASE_HELD',
  DISPATCH_TIMEOUT: 'PROVIDER_TIMEOUT',
  INVALID_SIGNAL: 'VALIDATION_FAILED',
  INVALID_TENANT_ID: 'VALIDATION_FAILED',
  INVALID_STAGE_TRANSITION: 'VALIDATION_FAILED',
  INVALID_TASK_STATE: 'VALIDATION_FAILED',
  CANONICAL_JSON_INVALID: 'VALIDATION_FAILED',
  MODIFICATION_REQUIRED: 'VALIDATION_FAILED',
  RECONCILIATION_BINDING_REQUIRED: 'RUN_NOT_RECONCILABLE',
  SECURITY_VIOLATION: 'PROMPT_INJECTION_BLOCKED',
});

/** Skill refusal codes (`05` §8.1) mapped onto the gateway vocabulary. */
const SKILL_CODE_MAP: Readonly<Record<string, GatewayErrorCode_>> = Object.freeze({
  SKILL_NOT_FOUND: 'UNKNOWN_SKILL',
  SKILL_DISABLED: 'SKILL_DISABLED',
  UNBROKERED_INVOCATION: 'INTERNAL_ERROR',
  MISSING_DISPATCH_CONTEXT: 'INTERNAL_ERROR',
  UNAUTHORIZED_AGENT: 'INSUFFICIENT_AUTHORITY',
  CLEARANCE_REQUIRED: 'INSUFFICIENT_AUTHORITY',
  INVALID_CLEARANCE: 'INVALID_CLEARANCE',
  INVALID_AUTHORITY_REQUIREMENT: 'INVALID_CLEARANCE',
  INSUFFICIENT_AUTHORITY: 'INSUFFICIENT_AUTHORITY',
  PROHIBITED_ACTION: 'PROHIBITED_ACTION',
  APPROVAL_REQUIRED: 'APPROVAL_REQUIRED',
  REQUIRE_HUMAN_APPROVAL: 'APPROVAL_REQUIRED',
  APPROVAL_PAYLOAD_MISMATCH: 'APPROVAL_STALE_PAYLOAD',
  SCHEMA_VALIDATION_ERROR: 'VALIDATION_FAILED',
  OUTPUT_SCHEMA_VALIDATION_ERROR: 'PROVIDER_REJECTED',
  EFFECT_KEY_REQUIRED: 'EFFECT_KEY_REQUIRED',
  EFFECT_KEY_NOT_DETERMINISTIC: 'EFFECT_KEY_REQUIRED',
  CIRCUIT_BREAKER_OPEN: 'PROVIDER_TIMEOUT',
  TIMEOUT: 'PROVIDER_TIMEOUT',
  EFFECT_UNKNOWN: 'PROVIDER_TIMEOUT',
  SKILL_EXECUTION_FAILED: 'PROVIDER_REJECTED',
});

/** Connector refusals from `packages/adapters` (API-001..003) mapped onto the gateway vocabulary. */
const CONNECTOR_CODE_MAP: Readonly<Record<string, GatewayErrorCode_>> = Object.freeze({
  CONNECTOR_NOT_FOUND: 'CONNECTOR_NOT_FOUND',
  CONNECTOR_NOT_ENABLED: 'CAPABILITY_NOT_ENABLED',
  CAPABILITY_NOT_ENABLED: 'CAPABILITY_NOT_ENABLED',
  CONNECTOR_UNAVAILABLE: 'AUTHORITATIVE_SOURCE_UNAVAILABLE',
  SIGNATURE_INVALID: 'SIGNATURE_INVALID',
  SIGNATURE_TIMESTAMP_OUT_OF_WINDOW: 'SIGNATURE_INVALID',
  WEBHOOK_SCHEMA_INVALID: 'VALIDATION_FAILED',
  REPLAY_WINDOW_EXCEEDED: 'SIGNATURE_INVALID',
});

/** Plain repository errors carry their stable code as the prefix of a sanitized internal message. */
const REPOSITORY_CODE_MAP: Readonly<Record<string, GatewayErrorCode_>> = Object.freeze({
  PORT_UNBOUND: 'CAPABILITY_NOT_ENABLED',
  APPROVAL_STALE_PAYLOAD: 'APPROVAL_STALE_PAYLOAD',
  APPROVAL_NOT_CLAIMABLE: 'APPROVAL_NOT_CLAIMABLE',
  APPROVAL_NOT_FOUND: 'NOT_FOUND',
  DURABLE_TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_NOT_FOUND: 'TASK_NOT_FOUND',
  TASK_REQUEUE_NOT_FAILED: 'RUN_NOT_RETRYABLE',
  TASK_VERSION_CONFLICT: 'RUN_NOT_RETRYABLE',
  RUN_RECONCILIATION_REQUIRED: 'RUN_NOT_RECONCILABLE',
  TASK_LIST_CURSOR_INVALID: 'VALIDATION_FAILED',
  TASK_LIST_LIMIT_INVALID: 'VALIDATION_FAILED',
  TASK_LIST_RANGE_INVALID: 'VALIDATION_FAILED',
  TASK_AGENT_ID_INVALID: 'VALIDATION_FAILED',
  APPROVAL_CURSOR_INVALID: 'VALIDATION_FAILED',
  APPROVAL_LIMIT_INVALID: 'VALIDATION_FAILED',
  SESSION_TAKEOVER_WINDOW_INVALID: 'VALIDATION_FAILED',
  SESSION_ID_REQUIRED: 'VALIDATION_FAILED',
  OPERATOR_ID_REQUIRED: 'VALIDATION_FAILED',
  TENANT_CONTEXT_REQUIRED: 'VALIDATION_FAILED',
});

function messageCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const separator = error.message.indexOf(':');
  const code = separator === -1 ? error.message : error.message.slice(0, separator);
  return /^[A-Z][A-Z0-9_]*$/.test(code) ? code : undefined;
}

/** A layer error carrying a stable `code` string; the engine and the skill layer both use one. */
interface CodedError {
  readonly code: string;
}

function isCodedError(error: unknown): error is CodedError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

/** The error name a layer sets on its own class, e.g. `SkillError` / `ConnectorError`. */
function nameOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name?: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return '';
}

/**
 * Maps any thrown value to the canonical envelope. A refusal this gateway did not raise is
 * reported as `INTERNAL_ERROR` with a fixed, value-free message: the underlying text is never
 * echoed, because it can carry a provider body, a host or a credential (`08` §9).
 */
export function mapError(error: unknown, correlation_id: string): ErrorResponse {
  if (error instanceof GatewayFailureError) {
    return toErrorResponse(error.failure, correlation_id);
  }

  if (isCodedError(error)) {
    const name = nameOf(error);
    const table =
      name === 'SkillError'
        ? SKILL_CODE_MAP
        : name === 'ConnectorError'
          ? CONNECTOR_CODE_MAP
          : ORCHESTRATOR_CODE_MAP;
    const mapped = table[error.code];
    if (mapped !== undefined) {
      return toErrorResponse(failureFor(mapped, `${mapped} [${error.code}]`), correlation_id);
    }
  }

  if (error instanceof Error && error.name === 'OrchestratorError' && isCodedError(error)) {
    const mapped = ORCHESTRATOR_CODE_MAP[error.code];
    if (mapped !== undefined) {
      return toErrorResponse(failureFor(mapped, `${mapped} [${error.code}]`), correlation_id);
    }
  }
  const repositoryCode = messageCode(error);
  const repositoryMapped = repositoryCode === undefined ? undefined : REPOSITORY_CODE_MAP[repositoryCode];
  if (repositoryMapped !== undefined) {
    return toErrorResponse(failureFor(repositoryMapped, `${repositoryMapped} [${repositoryCode}]`), correlation_id);
  }


  return toErrorResponse(
    failureFor('INTERNAL_ERROR', 'the request could not be completed'),
    correlation_id,
  );
}

// ============================================================================
// Request context
// ============================================================================

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the gateway's authentication hook; absent on an unauthenticated route. */
    gatewayPrincipal?: GatewayPrincipal;
    /** Resolved correlation id of this request. */
    gatewayCorrelationId?: string;
  }
}

/** Correlation id for one request: the caller's when present, else a server-issued one. */
export function correlationIdOf(request: FastifyRequest, runtime: GatewayRuntime): string {
  const existing = request.gatewayCorrelationId;
  if (typeof existing === 'string' && existing.length > 0) return existing;

  const header = request.headers[CORRELATION_HEADER];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  const resolved =
    typeof fromHeader === 'string' && fromHeader.length > 0 && fromHeader.length <= 128
      ? fromHeader
      : runtime.ids();

  request.gatewayCorrelationId = resolved;
  return resolved;
}

/** Writes a refusal in the canonical envelope; the status comes from the code, never the caller. */
export function replyFailure(reply: FastifyReply, error: unknown, correlation_id: string): FastifyReply {
  const failure = error instanceof GatewayFailureError ? error.failure : undefined;
  const envelope = mapError(error, correlation_id);
  const status = failure?.http_status ?? FAILURE_STATUS[envelope.error_code] ?? 500;
  return reply.status(status).header('content-type', 'application/json; charset=utf-8').send(envelope);
}
