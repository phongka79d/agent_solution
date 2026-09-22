/**
 * @file Bounded execution contract (implement/05 §2 retry loop, §6.5, §8 scenarios 12-14, 27).
 *
 * The safety property under test: a timed-out attempt whose external outcome is unconfirmed is
 * NEVER re-dispatched, and the identity it was reserved under is never regenerated.
 */

import { describe, expect, it } from 'vitest';

import type { SkillToolInvocation } from '../contracts/index.js';
import { createHarness, dispatchRequest } from '../testing/harness.js';
import { expectRefusalAsync } from '../testing/refusal.js';

/** An adapter that never answers on its own and only rejects when its deadline signal fires. */
function hangsUntilAborted(invocation: SkillToolInvocation): Promise<unknown> {
  return new Promise((_resolve, reject) => {
    const signal = invocation.context.signal;
    if (signal === undefined) {
      reject(new Error('the runtime did not supply an abort signal'));
      return;
    }
    signal.addEventListener('abort', () => {
      reject(Object.assign(new Error('aborted by the skill deadline'), { code: 'DEADLINE_FIRED' }));
    });
  });
}

/** An adapter that fails with a transient provider code the row does not list as non-retryable. */
function alwaysTransient(): Promise<unknown> {
  return Promise.reject(Object.assign(new Error('provider 503'), { code: 'PROVIDER_5XX' }));
}

/** An adapter that fails with a code the row declared non-retryable. */
function alwaysFatal(): Promise<unknown> {
  return Promise.reject(Object.assign(new Error('fixture fatal'), { code: 'FIXTURE_FATAL' }));
}

describe('bounded skill execution', () => {
  it('retries a timed-out read-only row inside its budget, then fails terminally', async () => {
    const harness = createHarness({
      respond: hangsUntilAborted,
      row: {
        effect_class: 'READ',
        timeout_ms: 5,
        retry_policy: {
          max_retries: 1,
          initial_interval_ms: 0,
          backoff_multiplier: 2,
          retry_on_timeout: true,
          non_retryable_errors: [],
        },
      },
    });

    await expectRefusalAsync(harness.engine.dispatch(dispatchRequest()), 'SKILL_EXECUTION_FAILED');
    expect(harness.invocations).toHaveLength(2);
  });

  it('never re-dispatches a timed-out effect-bearing row and reports EFFECT_UNKNOWN', async () => {
    const harness = createHarness({
      respond: hangsUntilAborted,
      row: {
        effect_class: 'EFFECT',
        timeout_ms: 5,
        retry_policy: {
          max_retries: 2,
          initial_interval_ms: 0,
          backoff_multiplier: 2,
          retry_on_timeout: false,
          non_retryable_errors: [],
        },
      },
    });

    await expectRefusalAsync(harness.engine.dispatch(dispatchRequest()), 'EFFECT_UNKNOWN');
    // Exactly one provider call: the outcome is unconfirmed and reconciliation is not a resend.
    expect(harness.invocations).toHaveLength(1);
  });

  it('reserves a retried dispatch under one effect identity and never regenerates it', async () => {
    const harness = createHarness({
      respond: alwaysTransient,
      row: {
        timeout_ms: 5,
        retry_policy: {
          max_retries: 2,
          initial_interval_ms: 0,
          backoff_multiplier: 2,
          retry_on_timeout: true,
          non_retryable_errors: [],
        },
      },
    });

    await expectRefusalAsync(harness.engine.dispatch(dispatchRequest()), 'SKILL_EXECUTION_FAILED');
    expect(harness.invocations).toHaveLength(3);
    expect(harness.effectKeyIdentities).toHaveLength(1);
  });

  it('stops immediately on a code the row declared non-retryable', async () => {
    const harness = createHarness({
      respond: alwaysFatal,
      row: {
        timeout_ms: 5,
        retry_policy: {
          max_retries: 3,
          initial_interval_ms: 0,
          backoff_multiplier: 2,
          retry_on_timeout: true,
          non_retryable_errors: ['FIXTURE_FATAL'],
        },
      },
    });

    await expectRefusalAsync(harness.engine.dispatch(dispatchRequest()), 'SKILL_EXECUTION_FAILED');
    expect(harness.invocations).toHaveLength(1);
  });

  it('opens the guarded dependency after the declared failure count and then refuses uncalled', async () => {
    const harness = createHarness({
      respond: hangsUntilAborted,
      row: {
        effect_class: 'EFFECT',
        timeout_ms: 5,
        retry_policy: {
          max_retries: 0,
          initial_interval_ms: 0,
          backoff_multiplier: 1,
          retry_on_timeout: false,
          non_retryable_errors: [],
        },
      },
    });

    for (let failure = 0; failure < 5; failure += 1) {
      await expectRefusalAsync(harness.engine.dispatch(dispatchRequest()), 'EFFECT_UNKNOWN');
    }
    const callsBeforeRefusal = harness.invocations.length;

    await expectRefusalAsync(harness.engine.dispatch(dispatchRequest()), 'CIRCUIT_BREAKER_OPEN');
    expect(harness.invocations).toHaveLength(callsBeforeRefusal);
  });

  it('forwards the caller’s cancellation to the attempt in flight', async () => {
    const controller = new AbortController();
    const harness = createHarness({ respond: hangsUntilAborted, row: { timeout_ms: 1_000 } });
    const cancelled = harness.engine.dispatch(dispatchRequest({ signal: controller.signal }));
    controller.abort();

    // An abandoned run is never retried: exactly one attempt reaches the adapter.
    await expectRefusalAsync(cancelled, 'SKILL_EXECUTION_FAILED');
    expect(harness.invocations).toHaveLength(1);
  });

  it('reports an unconfirmed effect when a caller cancels an effect-bearing attempt', async () => {
    const controller = new AbortController();
    const harness = createHarness({
      respond: hangsUntilAborted,
      row: { effect_class: 'EFFECT', timeout_ms: 1_000 },
    });
    const cancelled = harness.engine.dispatch(dispatchRequest({ signal: controller.signal }));
    controller.abort();

    // The provider may already have acted, so the outcome is reconciled by effect_key, never resent.
    await expectRefusalAsync(cancelled, 'EFFECT_UNKNOWN');
    expect(harness.invocations).toHaveLength(1);
  });
});
