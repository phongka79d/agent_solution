import { describe, expect, it } from 'vitest';

import { LlmTokenBudgetError, LlmUsageRecorder, llmIdempotencyKey, type LlmCostRecordInput } from './llm-usage.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const CONTEXT = { tenant_id: TENANT, run_id: 'run-1', correlation_id: 'corr-1', step_index: 0, attempt: 0 };

/** Mirrors token_cost_records' (tenant_id, idempotency_key) uniqueness: a replay is a no-op. */
function uniqueSink() {
  const rows = new Map<string, LlmCostRecordInput>();
  return {
    rows,
    async appendTokenCost(input: LlmCostRecordInput) {
      const key = `${input.tenant_id}|${input.idempotency_key}`;
      if (!rows.has(key)) rows.set(key, input);
    },
  };
}

describe('LlmUsageRecorder', () => {
  it('records provider usage once per run/step/attempt even when the call is replayed', async () => {
    const sink = uniqueSink();
    const recorder = new LlmUsageRecorder({ sink });
    const call = { ...CONTEXT, provider: 'openai', model: 'm', usage: { prompt_tokens: 10, completion_tokens: 5 } };

    await recorder.record(call);
    await recorder.record(call);

    expect([...sink.rows.values()]).toHaveLength(1);
    const [row] = [...sink.rows.values()];
    expect(row).toMatchObject({ idempotency_key: llmIdempotencyKey('run-1', 0, 0), input_tokens: 10, output_tokens: 5 });
  });

  it('refuses before the provider call when persisted tenant usage exhausts the budget', async () => {
    const recorder = new LlmUsageRecorder({
      reader: { totalTokensForTenant: async () => 1_000 },
      budgetConfig: { token_budget: 1_000 },
    });
    await expect(recorder.beforeCall(CONTEXT)).rejects.toMatchObject({ code: 'LLM_TOKEN_BUDGET_EXHAUSTED' });
  });

  it('fails closed when persisted usage cannot be read', async () => {
    const recorder = new LlmUsageRecorder({
      reader: { totalTokensForTenant: async () => { throw new Error('db down'); } },
      budgetConfig: { token_budget: 1_000 },
    });
    await expect(recorder.beforeCall(CONTEXT)).rejects.toBeInstanceOf(LlmTokenBudgetError);
  });

  it('records nothing and warns when the provider omits usage', async () => {
    const sink = uniqueSink();
    const warnings: string[] = [];
    const recorder = new LlmUsageRecorder({ sink, warn: (event) => warnings.push(event.code) });

    const row = await recorder.record({ ...CONTEXT, provider: 'openai', model: 'm', usage: null });

    expect(row).toBeNull();
    expect(sink.rows.size).toBe(0);
    expect(warnings).toEqual(['LLM_USAGE_MISSING']);
  });
});
