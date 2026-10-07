import { computeRequestFingerprint } from '@agentos/core-engine';
import type { CareHandoffRepository, EnqueueCareHandoffInput } from '@agentos/database';
import type { SkillToolInvocation } from '@agentos/skills';

import { CareSkillToolError } from './errors.js';

function handoffErrorCode(error: unknown): { readonly code: string; readonly detail: string } | null {
  const message = error instanceof Error ? error.message : '';
  const codeAndDetail = /^([A-Z][A-Z0-9_]+):\s*(.*)$/s.exec(message);
  if (!codeAndDetail || codeAndDetail[1] === undefined) return null;
  return { code: codeAndDetail[1], detail: codeAndDetail[2] || codeAndDetail[1] };
}

function asHandoffRefusal(error: unknown): CareSkillToolError | null {
  const parsed = handoffErrorCode(error);
  if (
    parsed !== null
    && parsed.code !== 'HANDOFF_QUEUE_TIMEOUT'
    && (parsed.code.startsWith('HANDOFF_') || parsed.code === 'IDEMPOTENCY_CONFLICT')
  ) {
    return new CareSkillToolError(parsed.code, parsed.detail);
  }
  return null;
}

/** Executes the durable care handoff binding while preserving enqueue/reconcile semantics. */
export async function handleHandoff<TOutput>(
  invocation: SkillToolInvocation<unknown>,
  handoffRepository: Pick<CareHandoffRepository, 'enqueue' | 'reconcile'>,
): Promise<TOutput> {
  if (typeof invocation.input !== 'object' || invocation.input === null) {
    throw new CareSkillToolError(
      'VALIDATION_FAILED',
      'tool invocation input must be an object',
    );
  }
  const input = invocation.input as {
    readonly tenant_id: string;
    readonly session_id: string;
    readonly conversation_id: string;
    readonly customer_id?: string;
    readonly escalation_reason: string;
    readonly summary_context?: string;
  };
  const trustedTenantId = invocation.context.tenant_id;
  if (input.tenant_id !== trustedTenantId) {
    throw new CareSkillToolError(
      'TENANT_SCOPE_MISMATCH',
      'handoff payload tenant_id must match the orchestrator-bound tenant',
    );
  }

  const enqueueInput: EnqueueCareHandoffInput = {
    tenant_id: trustedTenantId,
    effect_key: invocation.context.effect_key,
    request_fingerprint: computeRequestFingerprint(invocation.input as Record<string, unknown>),
    run_id: invocation.context.run_id,
    session_id: input.session_id,
    conversation_id: input.conversation_id,
    ...(input.customer_id === undefined ? {} : { customer_id: input.customer_id }),
    escalation_reason: input.escalation_reason,
    ...(input.summary_context === undefined ? {} : { summary_context: input.summary_context }),
  };
  const reconcileHandoff = async () => {
    try {
      return await handoffRepository.reconcile({
        tenant_id: enqueueInput.tenant_id,
        effect_key: enqueueInput.effect_key,
        request_fingerprint: enqueueInput.request_fingerprint,
      });
    } catch (error) {
      const refusal = asHandoffRefusal(error);
      if (refusal !== null) throw refusal;
      // A reconciliation timeout is not proof that the queue item is absent. The enqueue retry
      // below is safe because the repository arbitrates by (tenant_id, effect_key).
      return null;
    }
  };
  const enqueueOperation = () => handoffRepository.enqueue(enqueueInput).then(
    (result) => ({ kind: 'completed' as const, output: result.output }),
    (error: unknown) => ({ kind: 'failed' as const, error }),
  );
  const recoverHandoff = async (retryEnqueue: boolean): Promise<TOutput> => {
    const reconciled = await reconcileHandoff();
    if (reconciled?.state === 'COMMITTED') return reconciled.output as TOutput;
    if (!retryEnqueue) {
      throw new CareSkillToolError(
        'QUEUE_DOWN',
        'no committed handoff receipt was found; no enqueue was started',
      );
    }

    // The first transaction may have timed out after its commit or rolled back before the error
    // reached the worker. Re-entering the same transaction is therefore the durable retry: a
    // committed item replays and a rolled-back item is created exactly once.
    const retryOutcome = await enqueueOperation();
    if (retryOutcome.kind === 'completed') return retryOutcome.output as TOutput;
    const refusal = asHandoffRefusal(retryOutcome.error);
    if (refusal !== null) throw refusal;

    const committed = await reconcileHandoff();
    if (committed?.state === 'COMMITTED') return committed.output as TOutput;
    throw new CareSkillToolError(
      'QUEUE_DOWN',
      'the handoff queue did not commit after a bounded idempotent retry',
    );
  };
  const signal = invocation.context.signal;
  if (signal?.aborted) return recoverHandoff(false);

  const operation = enqueueOperation();
  let outcome: Awaited<typeof operation> | { readonly kind: 'aborted' };
  if (!signal) {
    outcome = await operation;
  } else {
    let onAbort!: () => void;
    const aborted = new Promise<{ readonly kind: 'aborted' }>((resolve) => {
      onAbort = () => resolve({ kind: 'aborted' });
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      outcome = await Promise.race([operation, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  if (outcome.kind === 'aborted') {
    // Do not reconcile while the transaction is still in flight: that race was the source of
    // RESERVED-without-handoff outcomes. The repository owns its own bounded transaction, so wait
    // for its commit/rollback and then apply the same idempotent recovery path.
    outcome = await operation;
  }
  if (outcome.kind === 'completed') return outcome.output as TOutput;
  const refusal = asHandoffRefusal(outcome.error);
  if (refusal !== null) throw refusal;
  return recoverHandoff(true);
}
