import { ApiError } from './http-client.js';
import { t } from './i18n/index.js';
import type { ApiErrorEnvelope } from './types/common.js';

/**
 * UI-facing error vocabulary. It mirrors the stable `error_code` catalog owned by orchestration
 * (T1.5/T5.1) but keeps localized reason/hint keys so no console renders a raw code or English text.
 */
export type ErrorRetryClass = 'RETRYABLE' | 'FATAL' | 'UNKNOWN';

export interface ApiErrorCatalogEntry {
  readonly class: ErrorRetryClass;
  readonly reason_key: string;
  readonly admin_hint_key: string;
}

const GENERIC_REASON = 'errors.generic';
const GENERIC_HINT = 'errors.hint.generic';

function entry(retryClass: ErrorRetryClass, reason_key: string, admin_hint_key: string): ApiErrorCatalogEntry {
  return { class: retryClass, reason_key, admin_hint_key };
}

/** Known codes get a precise, localized explanation; anything else fails closed to the generic view. */
export const API_ERROR_CATALOG: Readonly<Record<string, ApiErrorCatalogEntry>> = Object.freeze({
  // Authentication / authorization / session.
  UNAUTHENTICATED: entry('FATAL', 'errors.auth.unauthenticated', 'errors.hint.sign_in'),
  UNAUTHORIZED: entry('FATAL', 'errors.auth.forbidden', 'errors.hint.permission'),
  FORBIDDEN: entry('FATAL', 'errors.auth.forbidden', 'errors.hint.permission'),
  PERMISSION_DENIED: entry('FATAL', 'errors.auth.forbidden', 'errors.hint.permission'),
  SESSION_EXPIRED: entry('FATAL', 'errors.auth.session_expired', 'errors.hint.sign_in'),
  RATE_LIMITED: entry('RETRYABLE', 'errors.rate_limited', 'errors.hint.wait'),
  TOO_MANY_REQUESTS: entry('RETRYABLE', 'errors.rate_limited', 'errors.hint.wait'),
  // Validation / conflicts / not found.
  VALIDATION_FAILED: entry('FATAL', 'errors.validation', 'errors.hint.fields'),
  VALIDATION_ERROR: entry('FATAL', 'errors.validation', 'errors.hint.fields'),
  INVALID_INPUT: entry('FATAL', 'errors.validation', 'errors.hint.fields'),
  NOT_FOUND: entry('FATAL', 'errors.not_found', 'errors.hint.missing'),
  VERSION_CONFLICT: entry('FATAL', 'errors.version_conflict', 'errors.hint.refresh'),
  CONFLICT: entry('FATAL', 'errors.version_conflict', 'errors.hint.refresh'),
  PRECONDITION_FAILED: entry('FATAL', 'errors.version_conflict', 'errors.hint.refresh'),
  // Dependency / provider.
  DEPENDENCY_MISCONFIGURED: entry('FATAL', 'errors.dependency_misconfigured', 'errors.hint.admin'),
  DEPENDENCY_UNAVAILABLE: entry('RETRYABLE', 'errors.dependency_unavailable', 'errors.hint.wait'),
  PROVIDER_UNAVAILABLE: entry('RETRYABLE', 'errors.dependency_unavailable', 'errors.hint.wait'),
  PROVIDER_REJECTED: entry('FATAL', 'errors.provider_rejected', 'errors.hint.admin'),
  LLM_UNAVAILABLE: entry('RETRYABLE', 'errors.dependency_unavailable', 'errors.hint.wait'),
  LLM_NOT_CONFIGURED: entry('FATAL', 'errors.llm_not_configured', 'errors.hint.admin'),
  LLM_AUTH_FAILED: entry('FATAL', 'errors.llm_not_configured', 'errors.hint.admin'),
  PROVIDER_RATE_LIMITED: entry('RETRYABLE', 'errors.rate_limited', 'errors.hint.wait'),
  TIMEOUT: entry('RETRYABLE', 'errors.timeout', 'errors.hint.wait'),
  DISPATCH_TIMEOUT: entry('UNKNOWN', 'errors.outcome_unknown', 'errors.hint.reconcile'),
  BREAKER_OPEN: entry('RETRYABLE', 'errors.dependency_unavailable', 'errors.hint.wait'),
  CIRCUIT_BREAKER_OPEN: entry('RETRYABLE', 'errors.dependency_unavailable', 'errors.hint.wait'),
  // Effects / governance.
  EFFECT_UNKNOWN: entry('UNKNOWN', 'errors.outcome_unknown', 'errors.hint.reconcile'),
  PROVIDER_INDETERMINATE: entry('UNKNOWN', 'errors.outcome_unknown', 'errors.hint.reconcile'),
  EFFECT_KEY_REQUIRED: entry('FATAL', 'errors.effect_blocked', 'errors.hint.admin'),
  APPROVAL_REQUIRED: entry('FATAL', 'errors.approval_required', 'errors.hint.approvals'),
  CONSENT_REQUIRED: entry('FATAL', 'errors.consent_required', 'errors.hint.customer'),
  OUT_OF_STOCK: entry('FATAL', 'errors.out_of_stock', 'errors.hint.inventory'),
  INSUFFICIENT_AUTHORITY: entry('FATAL', 'errors.forbidden_action', 'errors.hint.admin'),
  PROHIBITED_ACTION: entry('FATAL', 'errors.forbidden_action', 'errors.hint.admin'),
});

const STATUS_FALLBACK: Readonly<Record<number, ApiErrorCatalogEntry>> = Object.freeze({
  400: entry('FATAL', 'errors.validation', 'errors.hint.fields'),
  401: entry('FATAL', 'errors.auth.session_expired', 'errors.hint.sign_in'),
  403: entry('FATAL', 'errors.auth.forbidden', 'errors.hint.permission'),
  404: entry('FATAL', 'errors.not_found', 'errors.hint.missing'),
  409: entry('FATAL', 'errors.version_conflict', 'errors.hint.refresh'),
  412: entry('FATAL', 'errors.version_conflict', 'errors.hint.refresh'),
  429: entry('RETRYABLE', 'errors.rate_limited', 'errors.hint.wait'),
  500: entry('UNKNOWN', 'errors.server_error', 'errors.hint.retry'),
  502: entry('RETRYABLE', 'errors.dependency_unavailable', 'errors.hint.wait'),
  503: entry('RETRYABLE', 'errors.dependency_unavailable', 'errors.hint.wait'),
  504: entry('RETRYABLE', 'errors.timeout', 'errors.hint.wait'),
});

export interface ApiErrorView {
  /** Stable machine code; render it only inside an Advanced/technical section. */
  readonly code: string;
  /** Localized, human-readable message safe for the main surface. */
  readonly message: string;
  readonly reason_key: string;
  readonly admin_hint_key: string | null;
  readonly class: ErrorRetryClass;
  /** True only when a bounded retry can be offered; UNKNOWN effects must be reconciled instead. */
  readonly retryable: boolean;
  readonly retry_label: string | null;
  readonly correlation_id: string | null;
  readonly status: number | null;
  /** Raw diagnostic detail (code/status) for Advanced details, never the primary label. */
  readonly technical: string;
}

interface ErrorLike {
  readonly error_code?: unknown;
  readonly errorCode?: unknown;
  readonly code?: unknown;
  readonly correlation_id?: unknown;
  readonly correlationId?: unknown;
  readonly retryable?: unknown;
  readonly status?: unknown;
  readonly message?: unknown;
  readonly envelope?: unknown;
}

function asRecord(value: unknown): ErrorLike | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as ErrorLike;
}

function pickString(...values: readonly unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

function pickNumber(...values: readonly unknown[]): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/**
 * Turns any thrown value (ApiError, error envelope, Error, string) into one localized descriptor
 * that carries the retry decision and the correlation id a support agent needs.
 */
export function describeApiError(error: unknown): ApiErrorView {
  const envelope = asRecord(asRecord(error)?.envelope);
  const record = asRecord(error);
  const code =
    pickString(
      record?.error_code,
      record?.errorCode,
      record?.code,
      envelope?.error_code,
      typeof error === 'string' ? error : null,
    ) ?? 'UNKNOWN_ERROR';
  const correlation_id = pickString(
    record?.correlation_id,
    record?.correlationId,
    envelope?.correlation_id,
  );
  const status =
    pickNumber(record?.status) ?? (error instanceof ApiError ? error.status : null);
  const catalogEntry = API_ERROR_CATALOG[code] ?? (status !== null ? STATUS_FALLBACK[status] : undefined);
  const declaredRetryable =
    typeof record?.retryable === 'boolean'
      ? record.retryable
      : typeof envelope?.retryable === 'boolean'
        ? envelope.retryable
        : undefined;

  const retryClass: ErrorRetryClass =
    catalogEntry?.class ?? (declaredRetryable === true ? 'RETRYABLE' : declaredRetryable === false ? 'FATAL' : 'FATAL');
  // UNKNOWN effects must never be auto-retried; they need reconciliation (workflow §26).
  const retryable = retryClass === 'RETRYABLE';

  const reasonKey = catalogEntry?.reason_key ?? GENERIC_REASON;
  // Never surface the raw upstream message; the localized reason is the only main-surface copy.
  const message = t(reasonKey);

  return {
    code,
    message,
    reason_key: reasonKey,
    admin_hint_key: catalogEntry?.admin_hint_key ?? GENERIC_HINT,
    class: retryClass,
    retryable,
    retry_label: retryable ? t('common.retry') : null,
    correlation_id,
    status,
    technical: status !== null ? `${code} (HTTP ${status})` : code,
  };
}

export type { ApiErrorEnvelope };
