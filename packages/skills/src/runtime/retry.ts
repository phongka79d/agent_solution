/**
 * @file Retry classification and backoff of one failed attempt (implement/05 §2 `classifyFailure`,
 * §6.5, §8 scenarios 12-14).
 *
 * Three primitives make up the resilience vocabulary of a dispatch: `errorCodeOf` reduces a thrown
 * value to a stable code, `classifyFailure` decides what that failure means for the retry budget,
 * and `backoffDelayMs` produces the full-jitter delay before the next attempt.
 *
 * The order of the classification questions is the safety property: an unconfirmed outcome is judged
 * by the row's declared consent *before* any retryability is considered, because a retry is
 * admissible only when it cannot duplicate an external effect. Nothing here dispatches, sleeps or
 * reads a clock: the jitter source is injected, so a backoff is reproducible in a test.
 */

import {
  INDETERMINATE_TRANSPORT_ERRORS,
  isSkillError,
  type RetryClass,
  type RetryPolicy,
} from '../contracts/index.js';

/**
 * The part of a `RetryPolicy` a backoff is computed from. A whole `RetryPolicy` satisfies it, and so
 * does the two-field shape a caller or a test pins when it wants a schedule and not a whole row.
 */
export type RetryBackoffPolicy = Pick<RetryPolicy, 'initial_interval_ms' | 'backoff_multiplier'>;

/**
 * Reads a non-empty string property off a thrown value without coercing the value itself.
 *
 * @param value The thrown value; only a non-null object can carry a property.
 * @param property The property to read.
 * @returns The property when it is a non-empty string, otherwise `null`.
 */
function readNonEmptyStringProperty(value: unknown, property: 'code' | 'message'): string | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = (value as Record<string, unknown>)[property];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/**
 * Reduces a thrown value to a stable, never-empty error code.
 *
 * The ladder is the §2 loop's `isAborted ? 'TIMEOUT' : err.code || err.message || 'UNKNOWN_ERROR'`,
 * made total: a thrown value that carries neither a non-empty `code` nor a non-empty `message` is
 * still a code — `'UNKNOWN_ERROR'` — so no failure is ever classified on an empty string, and a
 * value is never coerced into a code, because `String(error)` would turn an unrelated throw into
 * `'[object Object]'` and disguise it as a provider code.
 *
 * @param error The thrown value; any type, since an adapter may throw a string, a plain object or an
 *   `Error` subclass of its own.
 * @param isAborted Whether the attempt's deadline fired; a fired deadline is a timeout whatever the
 *   adapter threw.
 * @returns `'TIMEOUT'`, the `SkillError`'s code, the value's non-empty `code`, its non-empty
 *   `message`, or `'UNKNOWN_ERROR'`.
 */
export function errorCodeOf(error: unknown, isAborted: boolean): string {
  if (isAborted) {
    return 'TIMEOUT';
  }

  if (isSkillError(error)) {
    return error.code;
  }

  const code = readNonEmptyStringProperty(error, 'code');
  if (code !== null) {
    return code;
  }

  const message = readNonEmptyStringProperty(error, 'message');
  if (message !== null) {
    return message;
  }

  return 'UNKNOWN_ERROR';
}

/**
 * Classifies one failed attempt against the consent its row declared (implement/05 §2
 * `classifyFailure`; canonical with §04 §3.2.4 `RetryClass`). The order of the questions is the
 * safety property:
 *
 *   1. Is the budget gone? `exhausted` is `attempt > retry_policy.max_retries`, with `attempt` the
 *      1-based index of the attempt that just failed.
 *   2. Is the outcome unconfirmed? A fired deadline (`isAborted`) or a listed
 *      `INDETERMINATE_TRANSPORT_ERRORS` code means the request may already have reached the
 *      provider, so the class is decided by the row's consent: `retry_on_timeout: false` — every row
 *      whose adapter call can produce an external effect — is `'UNKNOWN'`, and the orchestrator
 *      reconciles by `effect_key` instead of this layer sending a blind second dispatch;
 *      `retry_on_timeout: true` has asserted its attempts are effect-free, so the timeout is retried
 *      in-loop while the declared budget lasts.
 *   3. Otherwise the provider answered: a listed `non_retryable_errors` code is `'FATAL'`, and any
 *      other transient code is `'RETRYABLE'` under the unchanged `effect_key` until the budget is
 *      gone.
 *
 * `skill_id` travels with the subject so the caller's refusal and this classification name the same
 * row; the decision itself reads only the retry policy.
 *
 * @param skill The row subject: its `skill_id` and the `retry_policy` it declares.
 * @param errorCode Stable code of the failed attempt, as produced by `errorCodeOf`.
 * @param isAborted Whether the attempt's deadline fired.
 * @param attempt 1-based index of the attempt that just failed.
 * @returns `'UNKNOWN'` to reconcile and never resend, `'RETRYABLE'` to try again, `'FATAL'` to stop.
 */
export function classifyFailure(
  skill: { readonly skill_id: string; readonly retry_policy: RetryPolicy },
  errorCode: string,
  isAborted: boolean,
  attempt: number,
): RetryClass {
  const exhausted = attempt > skill.retry_policy.max_retries;
  const indeterminate = isAborted || INDETERMINATE_TRANSPORT_ERRORS.includes(errorCode);

  if (indeterminate) {
    if (!skill.retry_policy.retry_on_timeout) {
      return 'UNKNOWN';
    }
    return exhausted ? 'FATAL' : 'RETRYABLE';
  }

  if (skill.retry_policy.non_retryable_errors.includes(errorCode)) {
    return 'FATAL';
  }
  return exhausted ? 'FATAL' : 'RETRYABLE';
}

/**
 * Full-jitter exponential backoff delay before the next attempt (implement/05 §2 retry loop).
 *
 * The §2 loop seeds its delay with `initial_interval_ms` before the first sleep and multiplies it by
 * `backoff_multiplier` after each one, so the base of a 1-based `attempt` is
 * `initial_interval_ms * backoff_multiplier ** (attempt - 1)` and the delay is
 * `base + random() * base` — full jitter, so concurrent callers do not align their retries on one
 * schedule and re-create the thundering herd that opened the breaker.
 *
 * The result is always a finite, non-negative number, because the caller sleeps for it: a base that
 * is zero, negative or non-finite yields `0` rather than `NaN`, a negative delay or a guess. A zero
 * interval therefore means "retry in the same tick", which is exactly what an effect-free read row
 * declares when it wants its budget spent without a wait.
 *
 * @param policy The backoff fields of the row's retry policy.
 * @param attempt 1-based index of the attempt that just failed; the delay precedes attempt + 1.
 * @param random Injected jitter source returning `[0, 1)`; never a hidden `Math.random` call.
 * @returns Milliseconds to sleep before the next attempt, in `[base, 2 * base)` for a well-behaved
 *   jitter source and `0` when the policy declares no wait.
 */
export function backoffDelayMs(
  policy: RetryBackoffPolicy,
  attempt: number,
  random: () => number,
): number {
  const rawBase = policy.initial_interval_ms * policy.backoff_multiplier ** (attempt - 1);
  const base = Number.isFinite(rawBase) && rawBase > 0 ? rawBase : 0;

  if (base === 0) {
    return 0;
  }

  const delay = base + random() * base;
  return Number.isFinite(delay) && delay > 0 ? delay : 0;
}
