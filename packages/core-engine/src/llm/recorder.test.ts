import { describe, expect, it } from 'vitest';

import { LlmUsageRecorder, type LlmCostRecordInput } from '../cost/llm-usage.js';
import { LlmCallRecorder, type LlmProviderCallInput } from './recorder.js';

const context = {
  tenant_id: '11111111-1111-4111-8111-111111111111',
  run_id: 'run-1',
  correlation_id: 'corr-1',
  step_index: 0,
  attempt: 0,
  stage: 'EXECUTION' as const,
  call_index: 0,
  provider: 'openai-compatible',
  model: 'model-1',
};

describe('LlmCallRecorder', () => {
  it('persists failed calls to both ledgers without provider response text', async () => {
    const tokenCosts: LlmCostRecordInput[] = [];
    const providerCalls: LlmProviderCallInput[] = [];
    const recorder = new LlmCallRecorder({
      usage: new LlmUsageRecorder({
        sink: { appendTokenCost: async (input) => tokenCosts.push(input) },
        recordId: () => 'record-1',
        now: () => '2026-10-01T00:00:00.000Z',
      }),
      providerCalls: { appendProviderCall: async (input) => providerCalls.push(input) },
      now: () => '2026-10-01T00:00:00.000Z',
    });

    await recorder.recordFailure({
      ...context,
      error_code: 'LLM_RATE_LIMITED',
      provider_error: { status: 429, type: 'rate_limit_error', code: 'rate_limited' },
      attempts: 2,
      latency_ms: 120,
    });

    expect(tokenCosts).toHaveLength(1);
    expect(tokenCosts[0]).toMatchObject({
      cost_status: 'UNAVAILABLE',
      input_tokens: 0,
      output_tokens: 0,
      provenance: {
        source: 'llm_provider_failure',
        error_code: 'LLM_RATE_LIMITED',
        attempts: 2,
        provider_error: { status: 429, type: 'rate_limit_error', code: 'rate_limited' },
      },
    });
    expect(providerCalls).toHaveLength(1);
    expect(providerCalls[0]).toMatchObject({
      observed_status: 'LLM_RATE_LIMITED',
      latency_ms: 120,
      prompt_tokens: null,
      completion_tokens: null,
      cost_status: 'UNAVAILABLE',
    });
  });
});
