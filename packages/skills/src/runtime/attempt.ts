/**
 * @file Bounded execution of one skill invocation (implement/05 §2 retry loop, §6.5, §8 scenarios
 * 12-14).
 *
 * The loop is bounded twice: by the row's hard `timeout_ms` deadline, and by its declared retry
 * budget. A failure whose outcome is unconfirmed never re-enters the loop — it leaves as
 * `EFFECT_UNKNOWN` for the orchestrator to reconcile by `effect_key`, because a second dispatch
 * would be a second external effect, not a second attempt. A caller cancellation is terminal for
 * the same reason it is never counted against the guarded dependency: an abandoned run is not
 * evidence that the provider is broken, and retrying it would be work the caller already stopped.
 */

import { SkillError, type RetryPolicy } from '../contracts/index.js';
import { backoffDelayMs, classifyFailure, errorCodeOf } from './retry.js';

/** Everything one bounded execution needs; every ambient dependency is injected. */
export interface BoundedExecutionOptions<TOutput> {
  readonly skill_id: string;
  readonly retry_policy: RetryPolicy;
  readonly timeout_ms: number;
  /** One attempt, under a signal that is aborted when the attempt's deadline fires. */
  readonly runAttempt: (signal: AbortSignal) => Promise<TOutput>;
  /** Called exactly once when an attempt ends the loop as `EFFECT_UNKNOWN` or `FATAL`. */
  readonly onAttemptFailure: () => void;
  readonly random: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  /** Cancellation of the whole invocation, forwarded to the attempt in flight. */
  readonly signal?: AbortSignal;
}

/** Result of a bounded execution that ended in one successful attempt. */
export interface BoundedExecution<TOutput> {
  readonly output: TOutput;
  /** Attempts consumed, `1` when the first attempt succeeded. */
  readonly attempts: number;
}

/**
 * Runs one skill invocation under its deadline and retry budget.
 *
 * @param options The row's bounds, the attempt body, and the injected clock seams.
 * @returns The successful attempt's output and the number of attempts consumed.
 * @throws {SkillError} `EFFECT_UNKNOWN` when an attempt's external outcome is unconfirmed, or
 *   `SKILL_EXECUTION_FAILED` when the attempt failed terminally or the budget is exhausted.
 */
export async function executeBounded<TOutput>(
  options: BoundedExecutionOptions<TOutput>,
): Promise<BoundedExecution<TOutput>> {
  let attempt = 0;

  for (;;) {
    attempt += 1;

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), options.timeout_ms);
    const external = options.signal;
    const forwardAbort = (): void => controller.abort();

    if (external?.aborted === true) {
      controller.abort();
    } else {
      external?.addEventListener('abort', forwardAbort);
    }

    try {
      const output = await options.runAttempt(controller.signal);
      clearTimeout(deadline);
      external?.removeEventListener('abort', forwardAbort);
      return { output, attempts: attempt };
    } catch (error) {
      clearTimeout(deadline);
      external?.removeEventListener('abort', forwardAbort);

      const aborted = controller.signal.aborted;
      const errorCode = errorCodeOf(error, aborted);
      const cancelled = options.signal?.aborted === true;
      const classification = classifyFailure(
        { skill_id: options.skill_id, retry_policy: options.retry_policy },
        errorCode,
        aborted,
        attempt,
      );

      if (classification === 'UNKNOWN') {
        if (!cancelled) {
          options.onAttemptFailure();
        }
        throw new SkillError(
          'EFFECT_UNKNOWN',
          `${errorCode} on an attempt whose external outcome is unconfirmed; the reservation stays RESERVED and the orchestrator reconciles by effect_key before any retry (§04 §4.4)`,
          options.skill_id,
        );
      }

      if (classification === 'FATAL') {
        options.onAttemptFailure();
        throw new SkillError(
          'SKILL_EXECUTION_FAILED',
          `${errorCode} after ${attempt} attempts inside a ${options.retry_policy.max_retries}-retry budget`,
          options.skill_id,
        );
      }

      if (cancelled) {
        throw new SkillError(
          'SKILL_EXECUTION_FAILED',
          `the caller cancelled this invocation while attempt ${attempt} was in flight (${errorCode}); an abandoned run is never retried`,
          options.skill_id,
        );
      }

      await options.sleep(backoffDelayMs(options.retry_policy, attempt, options.random));
    }
  }
}
