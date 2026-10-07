import {
  OrchestratorError,
  type ActionDraft,
  type ExecutionReceipt,
  type PlannedStep,
} from '../contracts/index.js';
import type { IAdapterDispatcher, IEffectGuard } from '../contracts/index.js';
import { serializeError } from './checkpoint-guards.js';

/** One provider proof consumed by the exact parked effect before the step loop resumes. */
export interface ReconciledEffect {
  readonly effect_key: string;
  readonly action_id: string;
  readonly kind: 'REPLAY' | 'DISPATCH';
  readonly receipt?: unknown;
}
/**
 * Provider success is only authoritative when the adapter returned the same minimal receipt proof
 * required by the dispatch reconciliation boundary. A status label without durable provider and
 * execution identities remains UNKNOWN.
 */
export function isConfirmedExecutionReceipt(receipt: unknown): receipt is ExecutionReceipt {
  if (receipt === null || typeof receipt !== 'object') {
    return false;
  }
  const candidate = receipt as Partial<ExecutionReceipt>;
  return candidate.adapter_status === 'SUCCESS'
    && typeof candidate.execution_id === 'string'
    && candidate.execution_id.trim().length > 0
    && typeof candidate.provider_reference === 'string'
    && candidate.provider_reference.trim().length > 0;
}


export interface EffectReconciliationDependencies {
  readonly effectGuard: IEffectGuard;
  readonly adapterDispatcher: IAdapterDispatcher;
  readonly assertExecutionLease?: (tenant_id: string, run_id: string) => Promise<void>;
}

/**
 * Reserves one effect slot and reports what the reservation permits. A read-only action is never
 * reserved; an unresolved provider outcome always waits for reconciliation instead of guessing.
 */
export async function acquireEffectSlot(
  dependencies: EffectReconciliationDependencies,
  action: ActionDraft,
  run_id: string,
  reconciledEffect: ReconciledEffect | null = null,
): Promise<{ kind: 'DISPATCH' } | { kind: 'REPLAY'; receipt: unknown | null } | { kind: 'WAIT'; reason: string }> {
  if (!action.mutating) {
    if (reconciledEffect !== null) {
      throw new OrchestratorError(
        'RECONCILIATION_BINDING_REQUIRED',
        'Provider reconciliation proof is bound to a mutating pending action, not a read-only step.',
      );
    }
    return { kind: 'DISPATCH' };
  }

  if (reconciledEffect !== null) {
    if (
      reconciledEffect.effect_key !== action.effect_key
      || reconciledEffect.action_id !== action.action_id
    ) {
      throw new OrchestratorError(
        'RECONCILIATION_BINDING_REQUIRED',
        'Provider reconciliation proof is bound to a different action or effect key than the resumed action.',
      );
    }
    return reconciledEffect.kind === 'REPLAY'
      ? { kind: 'REPLAY', receipt: reconciledEffect.receipt ?? null }
      : { kind: 'DISPATCH' };
  }

  const outcome = await dependencies.effectGuard.reserve({
    tenant_id: action.tenant_id,
    run_id,
    request_id: action.request_id,
    effect_key: action.effect_key,
    request_fingerprint: dependencies.effectGuard.computeRequestFingerprint(action.payload),
    skill_id: action.skill_id,
    step_index: action.step_index,
    action_revision: action.action_revision,
  });

  switch (outcome.kind) {
    case 'RESERVED':
      return { kind: 'DISPATCH' };
    case 'REPLAY':
      // Same key, same fingerprint, already SUCCEEDED: return the stored receipt verbatim.
      return { kind: 'REPLAY', receipt: outcome.receipt ?? null };
    case 'IN_FLIGHT':
      return { kind: 'WAIT', reason: 'EFFECT_IN_FLIGHT: an identical effect is still in flight' };
    case 'CONFLICT':
      throw new OrchestratorError(
        'IDEMPOTENCY_CONFLICT',
        `effect_key ${action.effect_key} was already used with a different payload (BR-005).`
      );
    case 'RECONCILE_REQUIRED': {
      // The guard reads durable reservation state but cannot prove what the provider did.
      const providerReconcile = dependencies.adapterDispatcher.reconcile;
      if (providerReconcile === undefined) {
        return { kind: 'WAIT', reason: 'EFFECT_UNKNOWN: provider reconciliation is not bound' };
      }
      const reconciled = await providerReconcile({
        tenant_id: action.tenant_id,
        effect_key: action.effect_key,
        action_id: action.action_id,
        adapter_target: action.adapter_target,
        skill_id: action.skill_id,
      });
      if (reconciled.outcome === 'SUCCEEDED') {
        if (!isConfirmedExecutionReceipt(reconciled.receipt)) {
          return { kind: 'WAIT', reason: 'EFFECT_UNKNOWN: provider success proof is incomplete' };
        }
        // Provider proof becomes durable truth before replay is exposed to the run.
        await dependencies.effectGuard.resolve({
          tenant_id: action.tenant_id,
          effect_key: action.effect_key,
          status: 'SUCCEEDED',
          receipt: reconciled.receipt,
        });
        return { kind: 'REPLAY', receipt: reconciled.receipt };
      }
      if (reconciled.outcome === 'FAILED') {
        // Provider-confirmed absence settles proof, then reopens the same deterministic key.
        await dependencies.effectGuard.resolve({
          tenant_id: action.tenant_id,
          effect_key: action.effect_key,
          status: 'FAILED',
        });
        const reopened = await dependencies.effectGuard.reopenForRetry?.({
          tenant_id: action.tenant_id,
          effect_key: action.effect_key,
        });
        if (reopened !== true) {
          return { kind: 'WAIT', reason: 'EFFECT_UNKNOWN: reservation could not be reopened for retry' };
        }
        return { kind: 'DISPATCH' };
      }
      return { kind: 'WAIT', reason: 'EFFECT_UNKNOWN: provider reconciliation is indeterminate' };
    }
  }
}

/**
 * Queries the provider for the exact parked action, then makes that proof durable before the guarded
 * loop can replay or re-dispatch it. Operator receipts and labels never settle a reservation.
 */
export async function reconcileProviderEffect(
  dependencies: EffectReconciliationDependencies,
  action: ActionDraft,
): Promise<ReconciledEffect> {
  if (!action.mutating) {
    throw new OrchestratorError(
      'RECONCILIATION_BINDING_REQUIRED',
      'Provider reconciliation proof is bound to a mutating pending action, not a read-only step.',
    );
  }
  const providerReconcile = dependencies.adapterDispatcher.reconcile;
  if (providerReconcile === undefined) {
    throw new OrchestratorError(
      'RECONCILIATION_PROVIDER_UNAVAILABLE',
      'No provider reconciliation boundary is bound for the parked mutating effect.',
    );
  }

  const reconciled = await providerReconcile({
    tenant_id: action.tenant_id,
    effect_key: action.effect_key,
    action_id: action.action_id,
    adapter_target: action.adapter_target,
    skill_id: action.skill_id,
  });

  if (reconciled.outcome === 'SUCCEEDED') {
    if (!isConfirmedExecutionReceipt(reconciled.receipt)) {
      throw new OrchestratorError(
        'RECONCILIATION_PROVIDER_PROOF_REQUIRED',
        'The provider reported success without a verified execution receipt; no reservation settlement is authorized.',
      );
    }
    await dependencies.effectGuard.resolve({
      tenant_id: action.tenant_id,
      effect_key: action.effect_key,
      status: 'SUCCEEDED',
      receipt: reconciled.receipt,
    });
    return {
      effect_key: action.effect_key,
      action_id: action.action_id,
      kind: 'REPLAY',
      receipt: reconciled.receipt,
    };
  }

  if (reconciled.outcome === 'FAILED') {
    await dependencies.effectGuard.resolve({
      tenant_id: action.tenant_id,
      effect_key: action.effect_key,
      status: 'FAILED',
    });
    const reopened = await dependencies.effectGuard.reopenForRetry?.({
      tenant_id: action.tenant_id,
      effect_key: action.effect_key,
    });
    if (reopened !== true) {
      throw new OrchestratorError(
        'RECONCILIATION_REOPEN_FAILED',
        'Provider absence was proven, but the same effect reservation could not be reopened for retry.',
      );
    }
    return { effect_key: action.effect_key, action_id: action.action_id, kind: 'DISPATCH' };
  }

  throw new OrchestratorError(
    'RECONCILIATION_PROVIDER_PROOF_REQUIRED',
    'The provider did not return proof of success or absence; no reservation settlement or re-dispatch is authorized.',
  );
}

/** Enforces the registry-declared hard deadline around one adapter dispatch. */
export async function dispatchWithDeadline(
  dependencies: EffectReconciliationDependencies,
  action: ActionDraft,
  step: PlannedStep,
): Promise<ExecutionReceipt> {
  let deadlineTimer: NodeJS.Timeout | undefined;
  const abortController = new AbortController();
  try {
    await dependencies.assertExecutionLease?.(action.tenant_id, action.run_id);
    const inFlight = dependencies.adapterDispatcher.dispatch(action, {
      timeout_ms: step.timeout_ms,
      signal: abortController.signal,
    });
    // A settlement that arrives after the deadline is late, not unhandled.
    inFlight.catch(() => undefined);
    return await Promise.race([
      inFlight,
      new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(
          () => {
            abortController.abort();
            reject(new OrchestratorError(
              'DISPATCH_TIMEOUT',
              `Adapter call for step ${step.step_index} exceeded its ${step.timeout_ms}ms deadline`
            ));
          },
          step.timeout_ms
        );
      }),
    ]);
  } catch (error) {
    if (error instanceof OrchestratorError) {
      throw error;
    }
    throw new OrchestratorError(
      'PROVIDER_INDETERMINATE',
      `Adapter call for step ${step.step_index} returned no verifiable outcome (${JSON.stringify(serializeError(error))}).`
    );
  } finally {
    clearTimeout(deadlineTimer);
  }
}
