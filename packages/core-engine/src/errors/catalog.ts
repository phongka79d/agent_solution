import type { RetryClass } from '../contracts/types.js';

export interface ErrorCatalogEntry {
  readonly class: RetryClass;
  readonly reason_key: string;
  readonly admin_hint: string;
}

const FATAL: ErrorCatalogEntry = Object.freeze({
  class: 'FATAL',
  reason_key: 'run.failure.deterministic',
  admin_hint: 'Review the refusal code and correct the input, authority, consent or configuration before rerunning.',
});
const RETRYABLE: ErrorCatalogEntry = Object.freeze({
  class: 'RETRYABLE',
  reason_key: 'run.failure.transient',
  admin_hint: 'Inspect provider or database health; a bounded retry may succeed.',
});
const UNKNOWN: ErrorCatalogEntry = Object.freeze({
  class: 'UNKNOWN',
  reason_key: 'run.failure.outcome_unknown',
  admin_hint: 'Reconcile the exact effect_key with the provider before any retry.',
});

/** Stable error-code catalog consumed by orchestration, audit and operator surfaces. */
export const ERROR_CATALOG: Readonly<Record<string, ErrorCatalogEntry>> = Object.freeze({
  SKILL_ALREADY_REGISTERED: FATAL,
  MISSING_ALLOWED_AGENTS: FATAL,
  PROHIBITED_AUTHORITY_REQUIREMENT: FATAL,
  MISSING_BASELINE_TEST_CASES: FATAL,
  INVALID_SCHEMA: FATAL,
  INVALID_SKILL_CONTRACT: FATAL,
  SKILL_NOT_FOUND: FATAL,
  SKILL_DISABLED: FATAL,
  UNBROKERED_INVOCATION: FATAL,
  HANDOFF_REQUEST_FINGERPRINT_MISSING: FATAL,
  MISSING_DISPATCH_CONTEXT: FATAL,
  UNAUTHORIZED_AGENT: FATAL,
  CLEARANCE_REQUIRED: FATAL,
  INVALID_CLEARANCE: FATAL,
  INVALID_AUTHORITY_REQUIREMENT: FATAL,
  INSUFFICIENT_AUTHORITY: FATAL,
  PROHIBITED_ACTION: FATAL,
  APPROVAL_REQUIRED: FATAL,
  REQUIRE_HUMAN_APPROVAL: FATAL,
  APPROVAL_PAYLOAD_MISMATCH: FATAL,
  CROSS_TENANT_ASSERTION: FATAL,
  EFFECT_KEY_IN_INPUT: FATAL,
  ACTION_EFFECT_KEY_CONFLICT: FATAL,
  SCHEMA_VALIDATION_ERROR: FATAL,
  OUTPUT_SCHEMA_VALIDATION_ERROR: FATAL,
  EFFECT_KEY_REQUIRED: FATAL,
  EFFECT_KEY_NOT_DETERMINISTIC: FATAL,
  CONSENT_REQUIRED: FATAL,
  OUT_OF_STOCK: FATAL,
  P_FLOOR_UNAVAILABLE: FATAL,
  AUTHORITATIVE_SOURCE_UNAVAILABLE: FATAL,
  DOCUMENT_NOT_APPROVED: FATAL,
  LLM_NOT_CONFIGURED: FATAL,
  LLM_AUTH_FAILED: FATAL,
  LLM_INVALID_RESPONSE: FATAL,
  LLM_CANCELLED: FATAL,
  CAMPAIGN_DISPATCH_NOT_INTEGRATED: FATAL,
  EFFECT_UNKNOWN: UNKNOWN,
  PROVIDER_INDETERMINATE: UNKNOWN,
  DISPATCH_TIMEOUT: UNKNOWN,
  TIMEOUT: RETRYABLE,
  BREAKER_OPEN: RETRYABLE,
  CIRCUIT_BREAKER_OPEN: RETRYABLE,
  PROVIDER_RATE_LIMITED: RETRYABLE,
  LLM_RATE_LIMITED: RETRYABLE,
  PROVIDER_UNAVAILABLE: RETRYABLE,
  LLM_UNAVAILABLE: RETRYABLE,
  LLM_TIMEOUT: RETRYABLE,
  CONCURRENT_TASK_LOCK: RETRYABLE,
  SKILL_EXECUTION_FAILED: FATAL,
  '40001': RETRYABLE,
  '40P01': RETRYABLE,
  '08006': RETRYABLE,
  ECONNRESET: RETRYABLE,
  CONNECTION_RESET: RETRYABLE,
});

const PRE_EFFECT_REFUSALS: Readonly<Record<string, true>> = Object.freeze({
  SKILL_DISABLED: true,
  UNAUTHORIZED_AGENT: true,
  CONSENT_REQUIRED: true,
  OUT_OF_STOCK: true,
  LLM_NOT_CONFIGURED: true,
  LLM_AUTH_FAILED: true,
  CIRCUIT_BREAKER_OPEN: true,
  BREAKER_OPEN: true,
  PROVIDER_RATE_LIMITED: true,
  LLM_RATE_LIMITED: true,
  CAMPAIGN_DISPATCH_NOT_INTEGRATED: true,
});

/** Looks up a stable classification, including the schema and HTTP status code families. */
export function getErrorCatalogEntry(code: string): ErrorCatalogEntry | undefined {
  const normalized = code.trim().toUpperCase();
  const known = ERROR_CATALOG[normalized];
  if (known !== undefined) return known;
  if (normalized.startsWith('SCHEMA_')) return FATAL;
  if (/(?:^|_)(?:5[0-9]{2}|5XX)(?:$|_)/.test(normalized)) return RETRYABLE;
  if (/(?:^|_)(?:429)(?:$|_)/.test(normalized)) return RETRYABLE;
  if (normalized === 'CONNECTION RESET' || normalized === 'ECONNRESET') return RETRYABLE;
  return undefined;
}

/** Unknown codes fail closed; transient dependencies and explicitly indeterminate effects stay typed. */
export function classifyErrorCode(code: string): RetryClass {
  return getErrorCatalogEntry(code)?.class ?? 'FATAL';
}

/** Whether a refused dispatch proves no provider call was made and its reservation can be failed. */
export function isPreEffectRefusalCode(code: string): boolean {
  const normalized = code.trim().toUpperCase();
  return Object.hasOwn(PRE_EFFECT_REFUSALS, normalized) || normalized.startsWith('SCHEMA_');
}
