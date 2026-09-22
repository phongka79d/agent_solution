import { describe, expect, it } from 'vitest';

import type { ActionDraft, ExecutionReceipt } from '@agentos/core-engine/contracts';

import type { AdapterPort } from './port.js';

/**
 * An in-repo fake port: it satisfies `AdapterPort` without pulling in any provider SDK.
 *
 * @param adapterId Identifier the port should report.
 * @returns A port that echoes the draft back as a successful receipt.
 */
function createFakePort(adapterId: string): AdapterPort {
  return {
    adapterId,
    async dispatch(draft: ActionDraft): Promise<ExecutionReceipt> {
      return {
        execution_id: `${adapterId}:${draft.action_id}`,
        adapter_status: 'SUCCESS',
        provider_reference: draft.effect_key,
        response_payload: { adapter_target: draft.adapter_target },
        latency_ms: 0,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      };
    },
  };
}

const draft: ActionDraft = {
  action_id: '2f1c4f8e-6a5b-4f2e-9d3a-1b7c8e0f4a21',
  run_id: 'run-fixture',
  tenant_id: 'tenant-fixture',
  agent_id: 'CS-01',
  skill_id: 'skill-fixture',
  adapter_target: 'erp',
  step_index: 0,
  mutating: false,
  price_bearing: false,
  request_id: 'request-fixture',
  action_revision: 0,
  effect_key: 'effect-fixture',
  required_authority: 'AUTH-1',
  payload: {},
};

describe('AdapterPort', () => {
  it('round-trips the adapter id and returns the receipt for a dispatch', async () => {
    const port = createFakePort('fake-erp');

    expect(port.adapterId).toBe('fake-erp');

    const receipt = await port.dispatch(draft);

    expect(receipt.adapter_status).toBe('SUCCESS');
    expect(receipt.execution_id).toBe(`fake-erp:${draft.action_id}`);
    expect(receipt.provider_reference).toBe(draft.effect_key);
  });
});
