import { approvalPayloadInput, OrchestratorError } from '@agentos/core-engine';

import { randomUUID } from 'node:crypto';

import type {
  ActionDraft,
  AssignableAuthority,
  ExecutionReceipt,
  HydratedContext,
  IAdapterDispatcher,
} from '@agentos/core-engine/contracts';
import {
  ORCHESTRATOR_BROKER,
  SkillError,
  type SkillDispatchRequest,
  type SkillDispatchResult,
  type SkillRuntimeEngine,
} from '@agentos/skills';

const ASSIGNABLE_AUTHORITIES: Readonly<Record<AssignableAuthority, true>> = Object.freeze({
  'AUTH-0': true,
  'AUTH-1': true,
  'AUTH-2': true,
  'AUTH-3': true,
});

function isAssignableAuthority(value: unknown): value is AssignableAuthority {
  return typeof value === 'string' && Object.hasOwn(ASSIGNABLE_AUTHORITIES, value);
}

function errorCodeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error) || typeof error.code !== 'string') {
    return undefined;
  }
  return error.code;
}

export function mapSkillError(error: unknown, mutating: boolean, skill_id?: string): unknown {
  if (!(error instanceof SkillError)) return error;
  if (
    skill_id === 'skill.mkt.dispatch_campaign'
    && error.code === 'SKILL_UNAVAILABLE'
    && error.message.endsWith('CONNECTOR_UNBOUND')
  ) {
    return new OrchestratorError('CAMPAIGN_DISPATCH_NOT_INTEGRATED', error.message);
  }
  const causeCode = error.code === 'SKILL_EXECUTION_FAILED' ? errorCodeOf(error.cause) : undefined;
  const code = causeCode ?? error.code;
  if (mutating && code === 'TIMEOUT') {
    return new OrchestratorError(
      'EFFECT_UNKNOWN',
      `Skill timeout may have occurred after the effect call: ${error.message}`,
    );
  }
  return new OrchestratorError(code, error.message);
}


export interface SkillAdapterDispatcherOptions {
  readonly engine: SkillRuntimeEngine;
  readonly resolve_correlation_id: (tenant_id: string, run_id: string) => Promise<string>;
  readonly resolve_grant: (tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>;
  readonly erp_reconcile?: (input: {
    readonly tenant_id: string;
    readonly effect_key: string;
    readonly action_id?: string;
    readonly adapter_target?: string;
    readonly skill_id?: string;
  }) => Promise<{
    readonly outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE';
    readonly receipt?: ExecutionReceipt;
  }>;
  // Lets a domain bind its own provider query without a second dispatcher.
  readonly provider_reconcile?: (input: {
    readonly tenant_id: string;
    readonly effect_key: string;
    readonly action_id?: string;
    readonly adapter_target?: string;
    readonly skill_id?: string;
  }) => Promise<{
    readonly outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE';
    readonly receipt?: ExecutionReceipt;
  }>;
  readonly special_receipt?: (input: { readonly action: ActionDraft; readonly output: Record<string, unknown> }) => ExecutionReceipt | null;
}

/**
 * Creates the domain-neutral skill adapter dispatcher that turns an ActionDraft into a SkillDispatchRequest,
 * dispatches through the SkillRuntimeEngine, and maps the validated output onto an ExecutionReceipt.
 */
export function createSkillAdapterDispatcher(options: SkillAdapterDispatcherOptions): IAdapterDispatcher {
  return {
    async dispatch(
      action: ActionDraft,
      dispatchOptions?: {
        timeout_ms?: number;
        signal?: AbortSignal;
        request_fingerprint?: string;
        hydrated_context?: HydratedContext;
      },
    ): Promise<ExecutionReceipt> {
      const correlation_id = await options.resolve_correlation_id(action.tenant_id, action.run_id);
      const granted_authority = await options.resolve_grant(action.tenant_id, action.agent_id);

      if (!isAssignableAuthority(granted_authority)) {
        throw new SkillError(
          granted_authority === null || granted_authority === undefined
            ? 'CLEARANCE_REQUIRED'
            : 'INVALID_CLEARANCE',
          `granted_authority '${String(granted_authority)}' is not an assignable authority (BR-008)`,
          action.skill_id,
        );
      }

      // The envelope's server-derived key is authoritative. Accept a caller echo only when it
      // agrees, then strip it before the runtime schema guard rejects envelope fields in input.
      let skillInput: unknown = action.payload;
      if (
        typeof action.payload === 'object'
        && action.payload !== null
        && !Array.isArray(action.payload)
        && Object.hasOwn(action.payload, 'effect_key')
      ) {
        const inputRecord = action.payload as Record<string, unknown>;
        if (inputRecord.effect_key !== action.effect_key) {
          throw new SkillError(
            'EFFECT_KEY_NOT_DETERMINISTIC',
            'caller-supplied effect_key does not match the server-derived dispatch key',
            action.skill_id,
          );
        }
        skillInput = approvalPayloadInput(action);
      }

      const timeoutSignal = dispatchOptions?.timeout_ms === undefined
        ? undefined
        : AbortSignal.timeout(dispatchOptions.timeout_ms);
      const signal = dispatchOptions?.signal === undefined
        ? timeoutSignal
        : timeoutSignal === undefined
          ? dispatchOptions.signal
          : AbortSignal.any([dispatchOptions.signal, timeoutSignal]);
      const request: SkillDispatchRequest = {
        broker: ORCHESTRATOR_BROKER,
        skill_id: action.skill_id,
        run_id: action.run_id,
        tenant_id: action.tenant_id,
        correlation_id,
        caller_agent: action.agent_id,
        granted_authority,
        request_id: action.request_id,
        step_index: action.step_index,
        action_revision: action.action_revision,
        effect_key: action.effect_key,
        ...(dispatchOptions?.hydrated_context === undefined
          ? {}
          : { hydrated_context: dispatchOptions.hydrated_context }),
        ...(dispatchOptions?.request_fingerprint === undefined
          ? {}
          : { request_fingerprint: dispatchOptions.request_fingerprint }),
        ...(action.approval_id ? { approval_id: action.approval_id } : {}),
        ...(action.approval_payload_digest ? { approval_payload_digest: action.approval_payload_digest } : {}),
        ...(signal === undefined ? {} : { signal }),
        input: skillInput,
      };

      let result: SkillDispatchResult<unknown>;
      try {
        result = await options.engine.dispatch(request);
      } catch (error) {
        throw mapSkillError(error, action.mutating, action.skill_id);
      }

      const outputRecord = result.output && typeof result.output === 'object'
        ? (result.output as Record<string, unknown>)
        : {};

      if (options.special_receipt) {
        const special = options.special_receipt({ action, output: outputRecord });
        if (special !== null) {
          return special;
        }
      }

      const providerEvidence = typeof outputRecord.provider_reference === 'string' && outputRecord.provider_reference.length > 0
        ? outputRecord.provider_reference
        : (typeof outputRecord._provider_reference === 'string' && outputRecord._provider_reference.length > 0
          ? outputRecord._provider_reference
          : null);

      return {
        execution_id: randomUUID(),
        adapter_status: 'SUCCESS',
        provider_reference: providerEvidence,
        response_payload: outputRecord,
        latency_ms: result.latency_ms,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      };
    },

    async reconcile(input: {
      readonly tenant_id: string;
      readonly effect_key: string;
      readonly action_id?: string;
      readonly adapter_target?: string;
      readonly skill_id?: string;
    }): Promise<{
      readonly outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE';
      readonly receipt?: ExecutionReceipt;
    }> {
      if (options.provider_reconcile) {
        return await options.provider_reconcile(input);
      }
      const isApi001 = input.adapter_target !== undefined
        ? input.adapter_target === 'API-001' || input.adapter_target.startsWith('API-001.')
        : input.skill_id !== 'skill.care.escalate_to_human';
      if (!isApi001) {
        return { outcome: 'INDETERMINATE' };
      }
      if (options.erp_reconcile) {
        return await options.erp_reconcile(input);
      }
      return { outcome: 'INDETERMINATE' };
    },
  };
}
