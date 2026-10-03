import { describe, expect, it } from 'vitest';

import {
  estimateLlmCallTokens,
  LlmTokenBudgetError,
  LlmUsageRecorder,
  llmIdempotencyKey,
  type LlmCostRecordInput,
} from './llm-usage.js';

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

function inMemoryReservationStore() {
  const budgets = new Map<string, { used: number; reserved: number }>();
  const reservations = new Map<string, { run_key: string; tokens: number }>();
  return {
    budgets,
    reservations,
    async reserveTokenBudget(input: {
      tenant_id: string;
      run_id: string;
      reservation_id: string;
      estimated_tokens: number;
      tenant_token_budget: number | null;
      run_token_budget: number | null;
    }) {
      const run_key = `${input.tenant_id}|${input.run_id}`;
      const key = `${run_key}|${input.reservation_id}`;
      if (reservations.has(key)) return false;
      const budget = budgets.get(run_key) ?? { used: 0, reserved: 0 };
      const requested = budget.used + budget.reserved + input.estimated_tokens;
      if (input.run_token_budget !== null && requested > input.run_token_budget) return false;
      budget.reserved += input.estimated_tokens;
      budgets.set(run_key, budget);
      reservations.set(key, { run_key, tokens: input.estimated_tokens });
      return true;
    },
    async settleTokenBudget(input: {
      tenant_id: string;
      run_id: string;
      reservation_id: string;
      actual_tokens: number | null;
    }) {
      const run_key = `${input.tenant_id}|${input.run_id}`;
      const key = `${run_key}|${input.reservation_id}`;
      const reservation = reservations.get(key);
      if (reservation === undefined) return;
      const budget = budgets.get(run_key);
      if (budget === undefined) throw new Error('reservation state missing');
      budget.reserved -= reservation.tokens;
      budget.used += input.actual_tokens ?? reservation.tokens;
      reservations.delete(key);
    },
    async releaseTokenBudget(input: {
      tenant_id: string;
      run_id: string;
      reservation_id: string;
    }) {
      const run_key = `${input.tenant_id}|${input.run_id}`;
      const key = `${run_key}|${input.reservation_id}`;
      const reservation = reservations.get(key);
      if (reservation === undefined) return;
      const budget = budgets.get(run_key);
      if (budget === undefined) throw new Error('reservation state missing');
      budget.reserved -= reservation.tokens;
      reservations.delete(key);
    },
  };
}

describe('LlmUsageRecorder', () => {
  it('reserves content-byte prompt estimates, message framing, and the output ceiling', () => {
    expect(estimateLlmCallTokens([{ content: 'a' }, { content: 'é' }], 10)).toBe(23);
  });

  it('gives calls within one skill attempt distinct idempotency keys', () => {
    expect(llmIdempotencyKey('run-1', 0, 0, 0)).not.toBe(llmIdempotencyKey('run-1', 0, 0, 1));
  });
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

  it('atomically admits only the first concurrent reservation that fits the run budget', async () => {
    const store = inMemoryReservationStore();
    const recorder = new LlmUsageRecorder({ reservationStore: store, runTokenBudget: 100 });
    const outcomes = await Promise.allSettled([
      recorder.beforeCall({ ...CONTEXT, step_index: 1 }, 60),
      recorder.beforeCall({ ...CONTEXT, step_index: 2 }, 60),
    ]);
    const accepted = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const refused = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(accepted).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(store.budgets.get(`${TENANT}|run-1`)).toEqual({ used: 0, reserved: 60 });
  });

  it('releases a failed provider call reservation so a later call can use that budget', async () => {
    const store = inMemoryReservationStore();
    const recorder = new LlmUsageRecorder({ reservationStore: store, runTokenBudget: 100 });
    const firstContext = { ...CONTEXT, step_index: 1 };

    await recorder.beforeCall(firstContext, 80);
    await recorder.recordFailure({
      ...firstContext,
      provider: 'openai',
      model: 'm',
      error_code: 'LLM_UNAVAILABLE',
      attempts: 1,
    });
    await expect(recorder.beforeCall({ ...CONTEXT, step_index: 2 }, 80)).resolves.toBeUndefined();
    expect(store.budgets.get(`${TENANT}|run-1`)).toEqual({ used: 0, reserved: 80 });
  });

  it('settles a successful reservation to provider-reported usage', async () => {
    const store = inMemoryReservationStore();
    const recorder = new LlmUsageRecorder({ reservationStore: store, runTokenBudget: 100 });
    const callContext = { ...CONTEXT, step_index: 1 };

    await recorder.beforeCall(callContext, 80);
    await recorder.record({
      ...callContext,
      provider: 'openai',
      model: 'm',
      usage: { prompt_tokens: 8, completion_tokens: 12 },
    });

    expect(store.budgets.get(`${TENANT}|run-1`)).toEqual({ used: 20, reserved: 0 });
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
