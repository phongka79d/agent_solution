/**
 * @file apps/command-center/src/components/operations/retry-helpers.ts
 * Safe side-effect-free retry evaluator per SCR-002, 06 §1.1 R13, and 04 §3.2.4.
 *
 * Exposes retry ONLY when:
 * 1. The run has state or execution_status indicating 'failed'.
 * 2. `last_error_class` explicitly proves a verified side-effect-free failure.
 *
 * Rejects retry when `last_error_class` is 'UNKNOWN', missing, or any fatal/indeterminate class.
 */

import type { AgentRunProjection, RetryEligibility, RetryableFailureClass } from './types';

/**
 * The verified side-effect-free failure classes from 06 §1.1 R13.
 * 'UNKNOWN' is deliberately omitted: indeterminate outcomes must be reconciled by effect_key (R18),
 * never re-dispatched blind.
 */
export const RETRYABLE_FAILURE_CLASSES: readonly RetryableFailureClass[] = [
  'SCHEMA_VALIDATION_FAILURE',
  'AUTHORITY_DENY',
  'FAIL_CLOSED',
  'PRE_DISPATCH_PROVIDER_REJECTION',
] as const;

/** Additional internal engine enum for retryable errors */
const EXTENDED_RETRYABLE = 'RETRYABLE';

/**
 * Evaluates whether a run satisfies the strict safety constraints for an operator retry.
 */
export function isRunRetryable(run: AgentRunProjection | null | undefined): boolean {
  if (!run) {
    return false;
  }

  const isFailed = run.state === 'failed' || run.execution_status === 'failed';
  if (!isFailed) {
    return false;
  }

  const errorClass = run.last_error_class;
  if (!errorClass || errorClass === 'UNKNOWN') {
    return false;
  }

  return (
    RETRYABLE_FAILURE_CLASSES.includes(errorClass as RetryableFailureClass) ||
    errorClass === EXTENDED_RETRYABLE
  );
}

/**
 * Returns detailed eligibility diagnosis for operator guidance.
 */
export function getRetryEligibility(run: AgentRunProjection | null | undefined): RetryEligibility {
  if (!run) {
    return {
      retryable: false,
      reason: 'NOT_FAILED',
      explanation: 'No run selected.',
    };
  }

  const isFailed = run.state === 'failed' || run.execution_status === 'failed';
  if (!isFailed) {
    return {
      retryable: false,
      reason: 'NOT_FAILED',
      explanation: `Run is currently in '${run.state}' state; only failed runs can be re-queued.`,
    };
  }

  const errorClass = run.last_error_class;
  if (!errorClass) {
    return {
      retryable: false,
      reason: 'NO_ERROR_CLASS',
      explanation: 'No error classification recorded; cannot prove failure was side-effect-free.',
    };
  }

  if (errorClass === 'UNKNOWN') {
    return {
      retryable: false,
      reason: 'UNKNOWN',
      explanation:
        'Indeterminate failure outcome (UNKNOWN). Side-effects may have occurred; requires reconciliation via effect_key, not blind retry.',
    };
  }

  const matches =
    RETRYABLE_FAILURE_CLASSES.includes(errorClass as RetryableFailureClass) ||
    errorClass === EXTENDED_RETRYABLE;

  if (matches) {
    return {
      retryable: true,
      reason: 'RETRYABLE',
      explanation: `Verified side-effect-free failure class '${errorClass}'. Eligible for operator retry.`,
    };
  }

  return {
    retryable: false,
    reason: 'NON_RETRYABLE_ERROR_CLASS',
    explanation: `Error class '${errorClass}' does not prove a side-effect-free failure.`,
  };
}
