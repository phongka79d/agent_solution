import { computeRequestFingerprint } from '@agentos/core-engine';
import type {
  ManageServiceCaseInput,
  ServiceCaseReconciliation,
  ServiceCaseRepository,
} from '@agentos/database';
import type { SkillToolInvocation } from '@agentos/skills';

import { CareSkillToolError } from './errors.js';
import type { CareCaseSlaTargetHoursResolver } from './types.js';

type CaseManagementToolInput = Omit<
  ManageServiceCaseInput,
  'effect_key' | 'request_fingerprint' | 'actor_id' | 'sla_target_hours'
> & {
  readonly effect_key?: string;
};

/** Executes the durable case-management binding while preserving CAS/reconciliation semantics. */
export async function handleCaseManagement<TOutput>(
  invocation: SkillToolInvocation<unknown>,
  caseRepository: Pick<ServiceCaseRepository, 'manage' | 'reconcile'>,
  resolveSlaTargetHours: CareCaseSlaTargetHoursResolver | undefined,
): Promise<TOutput> {
  if (typeof invocation.input !== 'object' || invocation.input === null) {
    throw new CareSkillToolError(
      'VALIDATION_FAILED',
      'tool invocation input must be an object',
    );
  }
  const input = invocation.input as CaseManagementToolInput;
  const { effect_key: callerEffectKey, ...businessInput } = input;
  const trustedTenantId = invocation.context.tenant_id;
  if (callerEffectKey !== undefined && callerEffectKey !== invocation.context.effect_key) {
    throw new CareSkillToolError(
      'EFFECT_KEY_MISMATCH',
      'Caller-supplied effect key does not match the server-derived effect key for case management',
    );
  }
  if (input.tenant_id !== trustedTenantId) {
    throw new CareSkillToolError(
      'TENANT_SCOPE_MISMATCH',
      'case payload tenant_id must match the orchestrator-bound tenant',
    );
  }

  let slaTargetHours: number | undefined;
  if (resolveSlaTargetHours) {
    let configuredHours: number | null;
    try {
      configuredHours = await resolveSlaTargetHours(trustedTenantId, businessInput.priority);
    } catch {
      throw new CareSkillToolError(
        'CASE_SLA_POLICY_UNAVAILABLE',
        'the tenant-specific case SLA policy could not be resolved',
      );
    }
    if (configuredHours !== null) {
      if (!Number.isSafeInteger(configuredHours) || configuredHours < 1) {
        throw new CareSkillToolError(
          'CASE_SLA_POLICY_UNAVAILABLE',
          'the tenant-specific case SLA policy returned an invalid target',
        );
      }
      slaTargetHours = configuredHours;
    }
  }
  if (businessInput.action_type === 'CREATE' && slaTargetHours === undefined) {
    throw new CareSkillToolError(
      'CASE_SLA_POLICY_UNAVAILABLE',
      'case creation requires an authoritative tenant-specific SLA target',
    );
  }

  const mutation: ManageServiceCaseInput = {
    ...businessInput,
    tenant_id: trustedTenantId,
    effect_key: invocation.context.effect_key,
    request_fingerprint: computeRequestFingerprint(businessInput as Record<string, unknown>),
    actor_id: invocation.context.caller_agent,
    ...(slaTargetHours === undefined ? {} : { sla_target_hours: slaTargetHours }),
  };
  const reconcileMutation = async () => {
    try {
      return await caseRepository.reconcile(mutation);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const codeAndDetail = /^([A-Z][A-Z0-9_]+):\s*(.*)$/s.exec(message);
      if (codeAndDetail?.[1] === 'IDEMPOTENCY_CONFLICT' || codeAndDetail?.[1] === 'CASE_BINDING_MISMATCH') {
        throw new CareSkillToolError(codeAndDetail[1], codeAndDetail[2] || codeAndDetail[1]);
      }
      throw new CareSkillToolError(
        'CASE_RECONCILIATION_FAILED',
        'the durable effect could not be reconciled; no automatic retry was attempted',
      );
    }
  };
  const uncommittedError = (result: Extract<ServiceCaseReconciliation, { readonly state: 'NOT_COMMITTED' }>) => {
    const latest = result.current_case_version === null
      ? ''
      : ' (current version ' + result.current_case_version + ', status ' + result.current_status + ')';
    return new CareSkillToolError(
      'CASE_EFFECT_NOT_COMMITTED',
      'no durable receipt exists for this effect' + latest + '; automatic retry is disabled',
    );
  };
  const signal = invocation.context.signal;
  if (signal?.aborted) {
    const reconciled = await reconcileMutation();
    if (reconciled.state === 'COMMITTED') return reconciled.output as TOutput;
    throw uncommittedError(reconciled);
  }

  const operation = caseRepository.manage(mutation).then(
    (output) => ({ kind: 'completed' as const, output }),
    (error: unknown) => ({ kind: 'failed' as const, error }),
  );
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
    const reconciled = await reconcileMutation();
    if (reconciled.state === 'COMMITTED') return reconciled.output as TOutput;
    throw uncommittedError(reconciled);
  }
  if (outcome.kind === 'completed') return outcome.output as TOutput;

  const error = outcome.error;
  if (error instanceof CareSkillToolError) throw error;
  const message = error instanceof Error ? error.message : '';
  const codeAndDetail = /^([A-Z][A-Z0-9_]+):\s*(.*)$/s.exec(message);
  if (codeAndDetail) {
    throw new CareSkillToolError(codeAndDetail[1]!, codeAndDetail[2] || codeAndDetail[1]!);
  }

  const reconciled = await reconcileMutation();
  if (reconciled.state === 'COMMITTED') return reconciled.output as TOutput;
  throw uncommittedError(reconciled);
}
