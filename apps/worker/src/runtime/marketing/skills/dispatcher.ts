import { randomUUID } from 'node:crypto';

import type {
  ActionDraft,
  AssignableAuthority,
  ExecutionReceipt,
  IAdapterDispatcher,
} from '@agentos/core-engine/contracts';
import {
  ORCHESTRATOR_BROKER,
  SkillError,
  type SkillDispatchRequest,
  type SkillDispatchResult,
  type SkillRuntimeEngine,
} from '@agentos/skills';

import type { MarketingReconcileFn } from './types.js';

const ASSIGNABLE_AUTHORITIES: Readonly<Record<AssignableAuthority, true>> = Object.freeze({
  'AUTH-0': true,
  'AUTH-1': true,
  'AUTH-2': true,
  'AUTH-3': true,
});

function isAssignableAuthority(value: unknown): value is AssignableAuthority {
  return typeof value === 'string' && Object.hasOwn(ASSIGNABLE_AUTHORITIES, value);
}

/**
 * Dispatch integration marker. Routing via apps/worker/src/worker.ts is deferred.
 */
export const MARKETING_DISPATCH_INTEGRATION = 'PENDING_P2_SHARED_ROUTING' as const;

export interface MarketingSkillDispatcherOptions {
  readonly engine: SkillRuntimeEngine;
  readonly resolve_correlation_id: (tenant_id: string, run_id: string) => Promise<string>;
  readonly resolve_grant: (tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>;
  readonly reconcile?: MarketingReconcileFn;
}

/**
 * Creates the Marketing skill adapter dispatcher that transforms an ActionDraft
 * into a SkillDispatchRequest, dispatches through the SkillRuntimeEngine, and
 * maps the validated output onto an ExecutionReceipt.
 *
 * For AUTH-4 actions, approval_id and approval_payload_digest are forwarded unchanged.
 */
export function createMarketingSkillDispatcher(
  options: MarketingSkillDispatcherOptions,
): IAdapterDispatcher {
  return {
    async dispatch(
      action: ActionDraft,
      dispatchOptions?: { timeout_ms?: number },
    ): Promise<ExecutionReceipt> {
      const correlation_id = await options.resolve_correlation_id(
        action.tenant_id,
        action.run_id,
      );
      const granted_authority = await options.resolve_grant(
        action.tenant_id,
        action.agent_id,
      );

      if (!isAssignableAuthority(granted_authority)) {
        throw new SkillError(
          granted_authority === null || granted_authority === undefined
            ? 'CLEARANCE_REQUIRED'
            : 'INVALID_CLEARANCE',
          `granted_authority '${String(granted_authority)}' is not an assignable authority (BR-008)`,
          action.skill_id,
        );
      }

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
        ...(action.approval_id !== undefined ? { approval_id: action.approval_id } : {}),
        ...(action.approval_payload_digest !== undefined
          ? { approval_payload_digest: action.approval_payload_digest }
          : {}),
        ...(dispatchOptions?.timeout_ms !== undefined
          ? { signal: AbortSignal.timeout(dispatchOptions.timeout_ms) }
          : {}),
        input: action.payload,
      };

      const result: SkillDispatchResult<unknown> = await options.engine.dispatch(request);

      const outputRecord =
        result.output !== null && typeof result.output === 'object'
          ? (result.output as Record<string, unknown>)
          : {};

      const providerReference =
        typeof outputRecord.dispatch_id === 'string' && outputRecord.dispatch_id.length > 0
          ? outputRecord.dispatch_id
          : typeof outputRecord.provider_reference === 'string' &&
              outputRecord.provider_reference.length > 0
            ? outputRecord.provider_reference
            : typeof outputRecord._provider_reference === 'string' &&
                outputRecord._provider_reference.length > 0
              ? outputRecord._provider_reference
              : null;

      return {
        execution_id: randomUUID(),
        adapter_status: 'SUCCESS',
        provider_reference: providerReference,
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
      if (options.reconcile) {
        return await options.reconcile(input);
      }
      return { outcome: 'INDETERMINATE' };
    },
  };
}
