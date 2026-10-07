import { describe, expect, it, vi } from 'vitest';
import type { ActionDraft } from '@agentos/core-engine/contracts';
import type { SkillDispatchRequest, SkillRuntimeEngine } from '@agentos/skills';

import { createSkillAdapterDispatcher } from './skill-dispatcher.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const EFFECT_KEY = 'effect-server-key';

function action(payload: Record<string, unknown>): ActionDraft {
  return {
    action_id: '22222222-2222-4222-8222-222222222222',
    run_id: 'run-dispatcher-test',
    tenant_id: TENANT_ID,
    agent_id: 'CS-01',
    skill_id: 'skill.care.manage_case',
    adapter_target: 'PostgreSQL.CaseManagementStore',
    step_index: 1,
    mutating: true,
    price_bearing: false,
    request_id: 'req-dispatcher-test',
    action_revision: 0,
    effect_key: EFFECT_KEY,
    required_authority: 'AUTH-3',
    payload,
  };
}

describe('shared skill adapter dispatcher', () => {
  it('passes a matching caller key only as the server envelope identity', async () => {
    const dispatch = vi.fn(async (request: SkillDispatchRequest) => ({
      effect_key: request.effect_key,
      output: { status: 'ok' },
      latency_ms: 0,
      attempts: 1,
    }));
    const dispatcher = createSkillAdapterDispatcher({
      engine: { dispatch } as unknown as SkillRuntimeEngine,
      resolve_correlation_id: async () => 'corr-dispatcher-test',
      resolve_grant: async () => 'AUTH-3',
    });

    await dispatcher.dispatch(action({ tenant_id: TENANT_ID, effect_key: EFFECT_KEY }));

    expect(dispatch).toHaveBeenCalledOnce();
    const request = dispatch.mock.calls[0]?.[0];
    expect(request?.effect_key).toBe(EFFECT_KEY);
    expect(request?.input).toEqual({ tenant_id: TENANT_ID });
  });

  it('refuses a caller key that differs from the server envelope identity', async () => {
    const dispatch = vi.fn();
    const dispatcher = createSkillAdapterDispatcher({
      engine: { dispatch } as unknown as SkillRuntimeEngine,
      resolve_correlation_id: async () => 'corr-dispatcher-test',
      resolve_grant: async () => 'AUTH-3',
    });

    await expect(dispatcher.dispatch(action({ tenant_id: TENANT_ID, effect_key: 'caller-key' })))
      .rejects.toMatchObject({ code: 'EFFECT_KEY_NOT_DETERMINISTIC' });
    expect(dispatch).not.toHaveBeenCalled();
  });
  it('combines caller cancellation with the adapter timeout deadline', async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutController.signal);
    try {
      const signals: AbortSignal[] = [];
      const dispatch = vi.fn(async (request: SkillDispatchRequest) => {
        if (request.signal !== undefined) signals.push(request.signal);
        return {
          effect_key: request.effect_key,
          output: { status: 'ok' },
          latency_ms: 0,
          attempts: 1,
        };
      });
      const dispatcher = createSkillAdapterDispatcher({
        engine: { dispatch } as unknown as SkillRuntimeEngine,
        resolve_correlation_id: async () => 'corr-dispatcher-test',
        resolve_grant: async () => 'AUTH-3',
      });

      const caller = new AbortController();
      await dispatcher.dispatch(action({ tenant_id: TENANT_ID }), {
        timeout_ms: 10_000,
        signal: caller.signal,
      });
      expect(signals[0]).toBeDefined();
      expect(signals[0]).not.toBe(caller.signal);
      expect(signals[0]).not.toBe(timeoutController.signal);
      caller.abort();
      expect(signals[0]!.aborted).toBe(true);

      const adapterDeadline = new AbortController();
      timeoutSpy.mockReturnValue(adapterDeadline.signal);
      await dispatcher.dispatch(action({ tenant_id: TENANT_ID }), { timeout_ms: 1 });
      adapterDeadline.abort();
      expect(signals[1]!.aborted).toBe(true);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

});
