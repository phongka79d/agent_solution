import { OrchestratorError } from '@agentos/core-engine';

import { describe, expect, it, vi } from 'vitest';
import type { ActionDraft, HydratedContext } from '@agentos/core-engine/contracts';
import { getErrorCatalogEntry } from '@agentos/core-engine/contracts';
import { SkillError, type SkillDispatchRequest, type SkillRuntimeEngine } from '@agentos/skills';

import { createSkillAdapterDispatcher, mapSkillError } from './skill-dispatcher.js';

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
  it('passes the checkpoint hydrated context through to the skill runtime', async () => {
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
    const hydrated_context: HydratedContext = {
      correlation_id: 'corr-dispatcher-test',
      tenant_id: TENANT_ID,
      customer: null,
      working_memory: {
        session_id: 'session-dispatcher-test',
        last_touch_channel: 'web',
        turn_count: 1,
        takeover_active: false,
      },
      knowledge_citations: [],
      hydrated_at: '2026-09-30T00:00:00.000Z',
      run_state: { sales: { advisor_candidate_sku: 'SKU-1' } },
    };

    await dispatcher.dispatch(action({ tenant_id: TENANT_ID }), { hydrated_context });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch.mock.calls[0]?.[0].hydrated_context).toBe(hydrated_context);
  });

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

    await dispatcher.dispatch(
      action({ tenant_id: TENANT_ID, effect_key: EFFECT_KEY }),
      { request_fingerprint: 'a'.repeat(64) },
    );

    expect(dispatch).toHaveBeenCalledOnce();
    const request = dispatch.mock.calls[0]?.[0];
    expect(request?.effect_key).toBe(EFFECT_KEY);
    expect(request?.request_fingerprint).toBe('a'.repeat(64));
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
  it.each([
    [new SkillError('EFFECT_UNKNOWN', 'effect outcome is not confirmed'), true, 'EFFECT_UNKNOWN'],
    [new SkillError('TIMEOUT', 'read timed out'), false, 'TIMEOUT'],
    [
      Object.assign(
        new SkillError('SKILL_EXECUTION_FAILED', 'rate limit exhausted'),
        { cause: { code: 'PROVIDER_RATE_LIMITED' } },
      ),
      false,
      'PROVIDER_RATE_LIMITED',
    ],
    [
      Object.assign(
        new SkillError('SKILL_EXECUTION_FAILED', 'provider is not configured'),
        { cause: { code: 'LLM_NOT_CONFIGURED' } },
      ),
      false,
      'LLM_NOT_CONFIGURED',
    ],
  ] as const)('preserves skill error codes', (error, mutating, expectedCode) => {
    const mapped = mapSkillError(error, mutating);
    expect(mapped).toBeInstanceOf(OrchestratorError);
    if (!(mapped instanceof OrchestratorError)) throw new Error('skill errors must map to OrchestratorError');
    expect(mapped.code).toBe(expectedCode);
  });
  it('retains RETRYABLE LLM_UNAVAILABLE after the bounded draft skill budget is exhausted', () => {
    const providerFailure = Object.assign(new Error('HTTP 500'), { code: 'LLM_UNAVAILABLE' });
    const mapped = mapSkillError(
      new SkillError('SKILL_EXECUTION_FAILED', 'content generation budget exhausted', 'skill.mkt.generate_content', providerFailure),
      true,
      'skill.mkt.generate_content',
    );
    expect(mapped).toBeInstanceOf(OrchestratorError);
    if (!(mapped instanceof OrchestratorError)) throw new Error('skill errors must map to OrchestratorError');
    expect(mapped.code).toBe('LLM_UNAVAILABLE');
    expect(getErrorCatalogEntry(mapped.code)?.class).toBe('RETRYABLE');
  });
  it('marks an unbound campaign connector as a known pre-dispatch outcome', () => {
    const mapped = mapSkillError(
      new SkillError(
        'SKILL_UNAVAILABLE',
        'the skill is not available for this tenant: CONNECTOR_UNBOUND',
        'skill.mkt.dispatch_campaign',
      ),
      true,
      'skill.mkt.dispatch_campaign',
    );

    expect(mapped).toBeInstanceOf(OrchestratorError);
    expect(mapped).toMatchObject({ code: 'CAMPAIGN_DISPATCH_NOT_INTEGRATED' });
  });


});
