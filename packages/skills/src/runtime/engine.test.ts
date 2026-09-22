/**
 * @file Runtime dispatch contract (implement/05 §6.3 dispatch order, §8.1 registry-to-invocation
 * boundary, SRS §11/§12).
 *
 * The authority gate itself is supplied as an independent double (`testAuthorityVerdict`), so these
 * cases assert what this layer owns: the ORDER of the admission steps, the refusal each step
 * produces, and which inputs the effect-identity seam is handed.
 */

import { describe, expect, it } from 'vitest';

import type { AssignableAuthority } from '@agentos/core-engine/contracts';

import type { OrchestratorBroker } from '../contracts/index.js';
import { enforceAuthorityAdmission } from '../runtime/authority.js';
import {
  createHarness,
  dispatchRequest,
  testAuthorityVerdict,
  testDigest,
  testEffectKey,
} from '../testing/harness.js';
import { expectRefusal, expectRefusalAsync } from '../testing/refusal.js';

/** A clock whose first read opens the measured span and every later read closes it. */
function scriptedClock(start: number, end: number): () => number {
  let reads = 0;
  return () => {
    reads += 1;
    return reads === 1 ? start : end;
  };
}

describe('skill runtime dispatch', () => {
  it('refuses an unknown skill id and calls no adapter', async () => {
    const harness = createHarness();

    await expectRefusalAsync(
      harness.engine.dispatch(dispatchRequest({ skill_id: 'skill.test.absent' })),
      'SKILL_NOT_FOUND',
    );
    expect(harness.invocations).toEqual([]);
  });

  it('refuses an invocation that did not arrive through the orchestrator', async () => {
    const harness = createHarness();
    const unbrokered = dispatchRequest({
      broker: 'AGENT_DIRECT' as unknown as OrchestratorBroker,
    });

    await expectRefusalAsync(harness.engine.dispatch(unbrokered), 'UNBROKERED_INVOCATION');
    expect(harness.invocations).toEqual([]);
  });

  it.each([
    ['run_id', { run_id: '' }],
    ['tenant_id', { tenant_id: '' }],
    ['correlation_id', { correlation_id: '' }],
    ['caller_agent', { caller_agent: '' }],
  ])('refuses a dispatch without the server-resolved %s', async (_field, override) => {
    const harness = createHarness();

    await expectRefusalAsync(
      harness.engine.dispatch(dispatchRequest(override)),
      'MISSING_DISPATCH_CONTEXT',
    );
    expect(harness.invocations).toEqual([]);
  });

  it('refuses a row that the gate has not enabled', async () => {
    const harness = createHarness({ row: { enabled: false } });

    await expectRefusalAsync(harness.engine.dispatch(dispatchRequest()), 'SKILL_DISABLED');
    expect(harness.invocations).toEqual([]);
  });

  it('binds the caller agent before it validates the payload', async () => {
    const harness = createHarness();
    // The payload is invalid too, so an implementation that validated first could not pass this.
    const wrongAgent = dispatchRequest({ caller_agent: 'SAL-01', input: { sku_id: 'SKU-1' } });

    await expectRefusalAsync(harness.engine.dispatch(wrongAgent), 'UNAUTHORIZED_AGENT');
    expect(harness.invocations).toEqual([]);
  });

  it('refuses a rank shortfall and a verdict-only grant differently', async () => {
    const harness = createHarness();

    await expectRefusalAsync(
      harness.engine.dispatch(dispatchRequest({ granted_authority: 'AUTH-0' })),
      'INSUFFICIENT_AUTHORITY',
    );
    await expectRefusalAsync(
      harness.engine.dispatch(
        dispatchRequest({ granted_authority: 'AUTH-4' as unknown as AssignableAuthority }),
      ),
      'INVALID_CLEARANCE',
    );
    expect(harness.invocations).toEqual([]);
  });

  it('refuses PROHIBITED_ACTION for a row that would require AUTH-5', () => {
    expectRefusal(
      () =>
        enforceAuthorityAdmission({
          skill_id: 'skill.test.prohibited',
          allowed_agents: ['CS-01'],
          required_authority: 'AUTH-5',
          caller_agent: 'CS-01',
          granted_authority: 'AUTH-3',
          evaluateAuthority: testAuthorityVerdict,
        }),
      'PROHIBITED_ACTION',
    );
  });

  it('routes an AUTH-4 row to the human gate and refuses it without a bound approval', async () => {
    const harness = createHarness({
      row: { effect_class: 'APPROVAL', required_authority: 'AUTH-4' },
    });

    await expectRefusalAsync(
      harness.engine.dispatch(dispatchRequest({ granted_authority: 'AUTH-3' })),
      'APPROVAL_REQUIRED',
    );
    expect(harness.invocations).toEqual([]);
  });

  it('refuses an approval whose digest covers a different payload', async () => {
    const harness = createHarness({
      row: { effect_class: 'APPROVAL', required_authority: 'AUTH-4' },
    });
    const mismatched = dispatchRequest({
      granted_authority: 'AUTH-3',
      approval_id: 'approval-1',
      approval_payload_digest: testDigest({ tenant_id: 'tenant-1', sku_id: 'OTHER' }),
    });

    await expectRefusalAsync(harness.engine.dispatch(mismatched), 'APPROVAL_PAYLOAD_MISMATCH');
    expect(harness.invocations).toEqual([]);
  });

  it('dispatches an approved AUTH-4 row under the normalized payload digest', async () => {
    const harness = createHarness({
      row: {
        effect_class: 'APPROVAL',
        required_authority: 'AUTH-4',
        retry_policy: {
          max_retries: 0,
          initial_interval_ms: 0,
          backoff_multiplier: 1,
          retry_on_timeout: false,
          non_retryable_errors: [],
        },
      },
    });
    const approved = dispatchRequest({
      granted_authority: 'AUTH-3',
      approval_id: 'approval-1',
      // The digest is taken over the NORMALIZED payload: `limit` defaulted, `smuggled` stripped.
      approval_payload_digest: testDigest({ tenant_id: 'tenant-1', sku_id: 'SKU-1', limit: 10 }),
    });

    const result = await harness.engine.dispatch(approved);

    expect(result.verdict).toBe('AWAITING_HUMAN_APPROVAL');
    expect(result.approval_id).toBe('approval-1');
    expect(harness.invocations).toHaveLength(1);
  });

  it('refuses schema-invalid input with zero adapter calls', async () => {
    const harness = createHarness();
    const invalid = dispatchRequest({ input: { tenant_id: 'tenant-1', limit: 10 } });

    await expectRefusalAsync(harness.engine.dispatch(invalid), 'SCHEMA_VALIDATION_ERROR');
    expect(harness.invocations).toEqual([]);
  });

  it('normalizes the payload — defaults applied, unknown members stripped — before the adapter', async () => {
    const harness = createHarness();
    const withExtras = dispatchRequest({
      input: { tenant_id: 'tenant-1', sku_id: 'SKU-1', note: null, smuggled: 'value' },
    });

    await harness.engine.dispatch(withExtras);

    expect(harness.invocations[0]?.input).toEqual({
      tenant_id: 'tenant-1',
      sku_id: 'SKU-1',
      limit: 10,
      note: null,
    });
  });

  it('refuses a supplied effect key that is not this dispatch’s derivation', async () => {
    const harness = createHarness();
    const fabricated = dispatchRequest({ effect_key: 'f'.repeat(64) });

    await expectRefusalAsync(harness.engine.dispatch(fabricated), 'EFFECT_KEY_NOT_DETERMINISTIC');
    expect(harness.invocations).toEqual([]);
  });

  it('derives the effect identity from the immutable request, never from the run', async () => {
    const harness = createHarness();

    const first = await harness.engine.dispatch(dispatchRequest({ run_id: 'run-1' }));
    const replay = await harness.engine.dispatch(dispatchRequest({ run_id: 'run-2' }));

    // A new run replaying the same inbound request must reproduce the same key (BR-005).
    expect(replay.effect_key).toBe(first.effect_key);
    expect(harness.effectKeyIdentities[0]).toEqual({
      tenant_id: 'tenant-1',
      skill_id: 'skill.test.fixture',
      step_index: 0,
      action_revision: 1,
      request_id: 'req-1',
    });
    expect(Object.keys(harness.effectKeyIdentities[0] ?? {}).sort()).toEqual([
      'action_revision',
      'request_id',
      'skill_id',
      'step_index',
      'tenant_id',
    ]);
  });

  it('accepts a supplied effect key that is the canonical derivation', async () => {
    const harness = createHarness();
    const canonical = testEffectKey({
      tenant_id: 'tenant-1',
      skill_id: 'skill.test.fixture',
      step_index: 0,
      action_revision: 1,
      request_id: 'req-1',
    });

    const result = await harness.engine.dispatch(dispatchRequest({ effect_key: canonical }));

    expect(result.effect_key).toBe(canonical);
  });

  it('refuses an adapter response that fails the output schema', async () => {
    const harness = createHarness({ respond: async () => ({ sku_id: 42 }) });

    await expectRefusalAsync(
      harness.engine.dispatch(dispatchRequest()),
      'OUTPUT_SCHEMA_VALIDATION_ERROR',
    );
  });

  it('returns the verdict, effect class, attempt count and injected-clock latency', async () => {
    // The clock is scripted: its first read starts the measured span and every later read ends it,
    // so the reported latency is the engine's own span rather than a count of internal clock reads.
    const harness = createHarness({ engine: { now: scriptedClock(1_000, 1_042) } });

    const result = await harness.engine.dispatch(dispatchRequest());

    expect(result.skill_id).toBe('skill.test.fixture');
    expect(result.verdict).toBe('AUTO_APPROVED');
    expect(result.effect_class).toBe('READ');
    expect(result.attempts).toBe(1);
    expect(result.latency_ms).toBe(42);
    expect(result.output).toEqual({ sku_id: 'SKU-1' });
  });
});
