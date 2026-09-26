import type {
  ExecutionReceipt,
  IAdapterDispatcher,
} from '@agentos/core-engine/contracts';
import {
  createSkillAdapterDispatcher,
  type SkillAdapterDispatcherOptions,
} from '../../shared/skill-dispatcher.js';

export interface CareSkillDispatcherOptions extends Omit<SkillAdapterDispatcherOptions, 'special_receipt'> {}

/**
 * Creates the Care skill adapter dispatcher that turns an ActionDraft into a SkillDispatchRequest,
 * dispatches through the SkillRuntimeEngine, and maps the validated output onto an ExecutionReceipt.
 */
export function createCareSkillDispatcher(options: CareSkillDispatcherOptions): IAdapterDispatcher {
  return createSkillAdapterDispatcher({
    ...options,
    special_receipt: ({ action, output }): ExecutionReceipt | null => {
      if (action.skill_id === 'skill.care.escalate_to_human') {
        const handoffId = output['handoff_id'];
        if (typeof handoffId !== 'string' || handoffId.length === 0) {
          throw new Error('HANDOFF_RECEIPT_INVALID: handoff output lacks its durable identity.');
        }
        return {
          execution_id: handoffId,
          adapter_status: 'SUCCESS',
          provider_reference: handoffId,
          response_payload: output,
          latency_ms: 0,
          token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
        };
      }
      return null;
    },
  });
}
