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

const ASSIGNABLE_AUTHORITIES: Readonly<Record<AssignableAuthority, true>> = Object.freeze({
  'AUTH-0': true,
  'AUTH-1': true,
  'AUTH-2': true,
  'AUTH-3': true,
});

function isAssignableAuthority(value: unknown): value is AssignableAuthority {
  return typeof value === 'string' && Object.hasOwn(ASSIGNABLE_AUTHORITIES, value);
}

export interface CareSkillDispatcherOptions {
  readonly engine: SkillRuntimeEngine;
  readonly resolve_correlation_id: (tenant_id: string, run_id: string) => Promise<string>;
  readonly resolve_grant: (tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>;
}

/**
 * Creates the Care skill adapter dispatcher that turns an ActionDraft into a SkillDispatchRequest,
 * dispatches through the SkillRuntimeEngine, and maps the validated output onto an ExecutionReceipt.
 */
export function createCareSkillDispatcher(options: CareSkillDispatcherOptions): IAdapterDispatcher {
  return {
    async dispatch(action: ActionDraft, dispatchOptions?: { timeout_ms?: number }): Promise<ExecutionReceipt> {
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
        ...(action.approval_id ? { approval_id: action.approval_id } : {}),
        input: action.payload,
        ...(dispatchOptions?.timeout_ms ? { signal: AbortSignal.timeout(dispatchOptions.timeout_ms) } : {}),
      };

      // Dispatches through the SkillRuntimeEngine. A SkillError refusal surfaces as the canonical failure,
      // never caught or suppressed as a synthetic success.
      const result: SkillDispatchResult<unknown> = await options.engine.dispatch(request);

      const outputRecord = result.output && typeof result.output === 'object'
        ? (result.output as Record<string, unknown>)
        : {};

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
  };
}
