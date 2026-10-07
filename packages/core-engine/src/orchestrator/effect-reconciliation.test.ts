import { describe, expect, it, vi } from 'vitest';

import {
  type ActionDraft,
  type EffectReservationRecord,
  type EffectReservationRepository,
  type ExecutionPlan,
  type ExecutionReceipt,
  type HydratedContext,
  type IEffectGuard,
  type PlannedStep,
  type RoutingDecision,
  type SignalEnvelope,
} from '../contracts/index.js';
import { EffectGuard } from '../durability/effect-guard.js';
import { RevenueOrchestrator } from './revenue-orchestrator.js';
import {
  dispatchWithDeadline,
  isConfirmedExecutionReceipt,
  reconcileProviderEffect,
} from './effect-reconciliation.js';

const ACTION: ActionDraft = {
  action_id: 'action-1',
  run_id: 'run-1',
  tenant_id: 'tenant-1',
  agent_id: 'SAL-01',
  skill_id: 'skill.test.dispatch',
  adapter_target: 'API-003',
  step_index: 1,
  mutating: true,
  price_bearing: false,
  request_id: 'request-1',
  action_revision: 0,
  effect_key: 'effect-1',
  required_authority: 'AUTH-3',
  payload: { tenant_id: 'tenant-1', effect_key: 'effect-1' },
};

const STEP: PlannedStep = {
  step_index: 1,
  agent_id: 'SAL-01',
  skill_id: ACTION.skill_id,
  adapter_target: ACTION.adapter_target,
  input_parameters: {},
  required_authority: 'AUTH-3',
  mutating: true,
  price_bearing: false,
  idempotent: false,
  timeout_ms: 10,
};

const RECEIPT: ExecutionReceipt = {
  execution_id: 'execution-1',
  adapter_status: 'SUCCESS',
  provider_reference: 'provider-1',
  response_payload: { confirmed: true },
  latency_ms: 1,
  token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
};

function repositoryFor(status: EffectReservationRecord['status']): EffectReservationRepository {
  const row: EffectReservationRecord = {
    tenant_id: ACTION.tenant_id,
    effect_key: ACTION.effect_key,
    request_id: ACTION.request_id,
    request_fingerprint: 'a'.repeat(64),
    run_id: ACTION.run_id,
    step_index: ACTION.step_index,
    skill_id: ACTION.skill_id,
    status,
    response_receipt: null,
    reserved_at: '2026-09-22T00:00:00.000Z',
    resolved_at: null,
    expires_at: '2026-09-25T00:00:00.000Z',
  };
  return {
    insertReservation: vi.fn(),
    getReservation: vi.fn().mockResolvedValue(row),
    resolve: vi.fn().mockResolvedValue(undefined),
    settleReservation: vi.fn().mockResolvedValue(false),
    reopenReservation: vi.fn().mockResolvedValue(false),
    expireReservation: vi.fn().mockResolvedValue(false),
  };
}

describe('effect reconciliation guards', () => {
  it('aborts the in-flight adapter call when the step deadline expires', async () => {
    let receivedSignal: AbortSignal | undefined;
    const dispatch = vi.fn((_action: ActionDraft, options?: { signal?: AbortSignal }) => {
      receivedSignal = options?.signal;
      return new Promise<ExecutionReceipt>(() => undefined);
    });

    await expect(dispatchWithDeadline({
      effectGuard: {} as IEffectGuard,
      adapterDispatcher: { dispatch },
    }, ACTION, STEP)).rejects.toMatchObject({ code: 'DISPATCH_TIMEOUT' });

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
  });

  it.each(['FAILED', 'EXPIRED'] as const)(
    'settles a %s reservation through the reconciliation-tolerant durable transition',
    async (status) => {
      const repository = repositoryFor(status);
      const guard = new EffectGuard({ repository });

      await guard.resolve({
        tenant_id: ACTION.tenant_id,
        effect_key: ACTION.effect_key,
        status: 'SUCCEEDED',
        receipt: RECEIPT,
      });

      expect(repository.resolve).toHaveBeenCalledWith({
        tenant_id: ACTION.tenant_id,
        effect_key: ACTION.effect_key,
        status: 'SUCCEEDED',
        receipt: RECEIPT,
      });
      expect(repository.settleReservation).not.toHaveBeenCalled();
    },
  );

  it('refuses to settle success without an existing verified provider receipt', async () => {
    const resolve = vi.fn();
    const dependencies = {
      effectGuard: { resolve } as unknown as IEffectGuard,
      adapterDispatcher: {
        dispatch: vi.fn(),
        reconcile: vi.fn().mockResolvedValue({ outcome: 'SUCCEEDED' }),
      },
    };

    await expect(reconcileProviderEffect(dependencies, ACTION)).rejects.toMatchObject({
      code: 'RECONCILIATION_PROVIDER_PROOF_REQUIRED',
    });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('accepts only a confirmed receipt as provider success proof', async () => {
    expect(isConfirmedExecutionReceipt(RECEIPT)).toBe(true);
    expect(isConfirmedExecutionReceipt({
      ...RECEIPT,
      provider_reference: null,
    })).toBe(false);

    const resolve = vi.fn().mockResolvedValue(undefined);
    const result = await reconcileProviderEffect({
      effectGuard: { resolve } as unknown as IEffectGuard,
      adapterDispatcher: {
        dispatch: vi.fn(),
        reconcile: vi.fn().mockResolvedValue({ outcome: 'SUCCEEDED', receipt: RECEIPT }),
      },
    }, ACTION);

    expect(result).toEqual({
      effect_key: ACTION.effect_key,
      action_id: ACTION.action_id,
      kind: 'REPLAY',
      receipt: RECEIPT,
    });
    expect(resolve).toHaveBeenCalledWith({
      tenant_id: ACTION.tenant_id,
      effect_key: ACTION.effect_key,
      status: 'SUCCEEDED',
      receipt: RECEIPT,
    });
  });

  it('builds clarification responses from the bound context route and fails closed when absent', () => {
    const orchestrator = new RevenueOrchestrator({} as never);
    const buildClarificationPlan = (
      orchestrator as unknown as {
        buildClarificationPlan(
          routing: RoutingDecision,
          signal: SignalEnvelope,
          context: HydratedContext,
        ): ExecutionPlan;
      }
    ).buildClarificationPlan.bind(orchestrator);
    const routing: RoutingDecision = {
      target_agent: 'CS-01',
      requires_clarification: true,
      clarification_prompt: 'Which order should I check?',
      rationalization: 'missing order reference',
    };
    const signal: SignalEnvelope = {
      signal_id: 'signal-1',
      tenant_id: ACTION.tenant_id,
      correlation_id: 'correlation-1',
      source_channel: 'wrong-channel',
      event_type: 'message.received',
      payload: {},
      subject: { session_id: 'session-1', channel_type: 'web' },
      timestamp: '2026-09-22T00:00:00.000Z',
    };
    const context: HydratedContext = {
      correlation_id: signal.correlation_id,
      tenant_id: signal.tenant_id,
      customer: null,
      working_memory: {
        session_id: signal.subject.session_id,
        last_touch_channel: 'bound-channel',
        response_skill_id: 'skill.care.reply',
        response_adapter_target: 'API-003.CommunicationConnector',
        turn_count: 1,
        takeover_active: false,
      },
      knowledge_citations: [],
      hydrated_at: signal.timestamp,
    };

    const plan = buildClarificationPlan(routing, signal, context);
    expect(plan.steps[0]).toMatchObject({
      skill_id: 'skill.care.reply',
      adapter_target: 'API-003.CommunicationConnector',
      input_parameters: { channel: 'bound-channel' },
    });
    const { response_skill_id: _responseSkillId, ...unboundMemory } = context.working_memory;
    expect(() => buildClarificationPlan(routing, signal, {
      ...context,
      working_memory: unboundMemory,
    })).toThrow('RESPONSE_SENDER_UNBOUND');
  });

  it('keeps a provider indeterminate outcome unreconciled', async () => {
    const resolve = vi.fn();
    await expect(reconcileProviderEffect({
      effectGuard: { resolve } as unknown as IEffectGuard,
      adapterDispatcher: {
        dispatch: vi.fn(),
        reconcile: vi.fn().mockResolvedValue({ outcome: 'INDETERMINATE' }),
      },
    }, ACTION)).rejects.toMatchObject({
      code: 'RECONCILIATION_PROVIDER_PROOF_REQUIRED',
    });
    expect(resolve).not.toHaveBeenCalled();
  });
});
