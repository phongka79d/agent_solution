import { describe, expect, it, vi } from 'vitest';

import {
  OrchestratorError,
  type ActionDraft,
  type EffectReservationRecord,
  type EffectReservationRepository,
  type ExecutionPlan,
  type ExecutionReceipt,
  type IEffectGuard,
  type PlannedStep,
  type RoutingDecision,
} from '../contracts/index.js';
import { EffectGuard } from '../durability/effect-guard.js';
import { MemoryEffectGuard } from '../effects/memory-effect-guard.js';
import { RevenueOrchestrator } from './revenue-orchestrator.js';
import { classifyFailure, serializeError } from './checkpoint-guards.js';

import {
  acquireEffectSlot,
  dispatchWithDeadline,
  isConfirmedExecutionReceipt,
  readReconciledEffect,
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
  it.each([
    { thrown: 'LLM_UNAVAILABLE', surfaced: 'LLM_UNAVAILABLE' },
    { thrown: 'DISPATCH_TIMEOUT', surfaced: 'LLM_TIMEOUT' },
  ])('lets an in-process LLM $thrown retry, but keeps a provider effect reserved', async ({ thrown, surfaced }) => {
    async function attempt(adapter_target: string) {
      const effectGuard = new MemoryEffectGuard();
      const effect_key = effectGuard.computeEffectKey({
        tenant_id: ACTION.tenant_id,
        skill_id: ACTION.skill_id,
        step_index: ACTION.step_index,
        action_revision: ACTION.action_revision,
        request_id: ACTION.request_id,
      });
      const action: ActionDraft = { ...ACTION, adapter_target, effect_key, payload: { ...ACTION.payload, effect_key } };
      const request_fingerprint = effectGuard.computeRequestFingerprint(action.payload);
      const providerReconcile = vi.fn(async () => ({ outcome: 'INDETERMINATE' as const }));
      const dependencies = {
        effectGuard,
        adapterDispatcher: {
          dispatch: vi.fn().mockRejectedValue(new OrchestratorError(thrown, 'provider did not answer')),
          reconcile: providerReconcile,
        },
      };
      expect(await acquireEffectSlot(dependencies, action, action.run_id, null, request_fingerprint))
        .toEqual({ kind: 'DISPATCH' });
      const failure = await dispatchWithDeadline(dependencies, action, STEP, request_fingerprint).catch((error) => error);
      return {
        failure,
        retry: await acquireEffectSlot(dependencies, action, action.run_id, null, request_fingerprint),
        providerReconcile,
      };
    }

    // The content engine keeps no provider state: the durable retry may generate again.
    const llm = await attempt('Core.LLMContentEngine');
    expect(llm.failure).toMatchObject({ code: surfaced });
    expect(llm.retry).toEqual({ kind: 'DISPATCH' });
    expect(llm.providerReconcile).not.toHaveBeenCalled();

    // An external target may have applied its effect before failing: never re-dispatched blind.
    const external = await attempt('API-003');
    expect(external.failure).toMatchObject({ code: thrown });
    expect(external.retry).toMatchObject({ kind: 'WAIT' });
  });

  it('aborts the in-flight adapter call when the step deadline expires without releasing its reservation', async () => {
    let receivedSignal: AbortSignal | undefined;
    const resolve = vi.fn();
    const dispatch = vi.fn((_action: ActionDraft, options?: { signal?: AbortSignal }) => {
      receivedSignal = options?.signal;
      return new Promise<ExecutionReceipt>(() => undefined);
    });

    await expect(dispatchWithDeadline({
      effectGuard: { resolve } as unknown as IEffectGuard,
      adapterDispatcher: { dispatch },
    }, ACTION, STEP)).rejects.toMatchObject({ code: 'DISPATCH_TIMEOUT' });

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('uses the total bounded-invocation timeout when a step declares a retry deadline', async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal: AbortSignal | undefined;
      const dispatch = vi.fn((_action: ActionDraft, options?: { timeout_ms?: number; signal?: AbortSignal }) => {
        receivedSignal = options?.signal;
        return new Promise<ExecutionReceipt>(() => undefined);
      });
      const guard = new EffectGuard({ repository: repositoryFor('RESERVED') });
      const pending = dispatchWithDeadline({
        effectGuard: guard,
        adapterDispatcher: { dispatch },
      }, ACTION, { ...STEP, timeout_ms: 10, dispatch_timeout_ms: 30 });
      const rejection = expect(pending).rejects.toMatchObject({ code: 'DISPATCH_TIMEOUT' });

      await vi.advanceTimersByTimeAsync(0);
      expect(dispatch).toHaveBeenCalledWith(ACTION, expect.objectContaining({ timeout_ms: 30 }));
      await vi.advanceTimersByTimeAsync(29);
      expect(receivedSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
      expect(receivedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    'SKILL_DISABLED',
    'UNAUTHORIZED_AGENT',
    'SCHEMA_VALIDATION_ERROR',
    'CONSENT_REQUIRED',
    'OUT_OF_STOCK',
    'LLM_NOT_CONFIGURED',
    'LLM_AUTH_FAILED',
  ])('preserves pre-effect refusal %s and releases the reservation', async (code) => {
    const resolve = vi.fn().mockResolvedValue(undefined);
    const refusal = Object.assign(new Error(code), { code });

    await expect(dispatchWithDeadline({
      effectGuard: { resolve } as unknown as IEffectGuard,
      adapterDispatcher: { dispatch: vi.fn().mockRejectedValue(refusal) },
    }, ACTION, STEP)).rejects.toMatchObject({ code });

    expect(resolve).toHaveBeenCalledWith({
      tenant_id: ACTION.tenant_id,
      effect_key: ACTION.effect_key,
      status: 'FAILED',
    });
  });

  it('classifies transient database errors and keeps their string code when serialized', () => {
    const error = Object.assign(new Error('transaction serialization failure'), { code: '40001' });
    expect(classifyFailure(error)).toBe('RETRYABLE');
    expect(serializeError(error)).toMatchObject({ code: '40001' });
  });

  it('preserves a classified action effect-key conflict in durable error details', () => {
    const error = Object.assign(new Error('ACTION_EFFECT_KEY_CONFLICT: another action owns the key'), {
      code: 'ACTION_EFFECT_KEY_CONFLICT',
    });
    expect(classifyFailure(error)).toBe('FATAL');
    expect(serializeError(error)).toMatchObject({ code: 'ACTION_EFFECT_KEY_CONFLICT' });
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

  it('binds the stored reconciliation receipt to the pending action and revision without a provider call', async () => {
    const effectGuard = new MemoryEffectGuard();
    const reconcile = vi.spyOn(effectGuard, 'reconcile').mockResolvedValue({
      outcome: 'SUCCEEDED',
      receipt: RECEIPT,
    });
    const reserve = vi.spyOn(effectGuard, 'reserve');
    const providerReconcile = vi.fn();
    const dispatch = vi.fn();
    const dependencies = { effectGuard, adapterDispatcher: { dispatch, reconcile: providerReconcile } };
    const action: ActionDraft = { ...ACTION, action_revision: 2 };

    const proof = await readReconciledEffect(dependencies, action);

    expect(proof).toEqual({
      effect_key: action.effect_key,
      action_id: action.action_id,
      action_revision: 2,
      kind: 'REPLAY',
      receipt: RECEIPT,
    });
    expect(await acquireEffectSlot(dependencies, action, action.run_id, proof))
      .toEqual({ kind: 'REPLAY', receipt: RECEIPT });
    expect(reconcile).toHaveBeenCalledWith({
      tenant_id: action.tenant_id,
      effect_key: action.effect_key,
      skill_id: action.skill_id,
    });
    expect(reserve).not.toHaveBeenCalled();
    expect(providerReconcile).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();

    for (const other of [
      { ...action, action_id: 'another-action' },
      { ...action, action_revision: 3 },
      { ...action, effect_key: 'another-key' },
    ]) {
      await expect(acquireEffectSlot(dependencies, other, other.run_id, proof))
        .rejects.toMatchObject({ code: 'RECONCILIATION_BINDING_REQUIRED' });
    }
  });

  it.each([
    { outcome: 'INDETERMINATE' },
    { outcome: 'FAILED' },
    { outcome: 'SUCCEEDED' },
    { outcome: 'SUCCEEDED', receipt: { ...RECEIPT, provider_reference: null } },
  ] satisfies { outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE'; receipt?: unknown }[])(
    'refuses automatic replay without a durable confirmed success receipt ($outcome)',
    async (stored) => {
      const effectGuard = new MemoryEffectGuard();
      vi.spyOn(effectGuard, 'reconcile').mockResolvedValue(stored);
      const dispatch = vi.fn();
      const providerReconcile = vi.fn();
      const resolve = vi.spyOn(effectGuard, 'resolve');
      const reserve = vi.spyOn(effectGuard, 'reserve');

      await expect(readReconciledEffect({
        effectGuard,
        adapterDispatcher: { dispatch, reconcile: providerReconcile },
      }, ACTION)).rejects.toMatchObject({ code: 'RECONCILIATION_PROVIDER_PROOF_REQUIRED' });

      expect(dispatch).not.toHaveBeenCalled();
      expect(providerReconcile).not.toHaveBeenCalled();
      expect(resolve).not.toHaveBeenCalled();
      expect(reserve).not.toHaveBeenCalled();
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
      action_revision: ACTION.action_revision,
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

  it('builds a terminal typed clarification response without a synthetic reply step', () => {
    const orchestrator = new RevenueOrchestrator({} as never);
    const buildClarificationPlan = (
      orchestrator as unknown as {
        buildClarificationPlan(routing: RoutingDecision): ExecutionPlan;
      }
    ).buildClarificationPlan.bind(orchestrator);
    const routing: RoutingDecision = {
      target_agent: 'CS-01',
      domain: 'support',
      requires_clarification: true,
      clarification_template_key: 'care.identity_required',
      clarification_prompt: 'Which order should I check?',
      rationalization: 'missing order reference',
    };

    const plan = buildClarificationPlan(routing);
    expect(plan.steps).toEqual([]);
    expect(plan.response_agent_id).toBe('CS-01');
    expect(plan.terminal_response).toMatchObject({
      response_kind: 'CLARIFICATION',
      template_key: 'care.identity_required',
      source: 'Core.Template@1',
      sources: [],
    });
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
