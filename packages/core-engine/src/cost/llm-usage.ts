import { createHash, randomUUID } from 'node:crypto';

import { TokenBudgetGuard } from './budget.js';
import { CostLedger } from './ledger.js';
import type { BudgetConfig, CostRecord, CostUsage } from './types.js';

export interface LlmUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly cached_tokens?: number;
}

export interface LlmCostRecordInput {
  readonly tenant_id: string;
  readonly record_id: string;
  readonly idempotency_key: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly model: string;
  readonly provider: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cached_tokens: number | null;
  readonly estimated_cost_amount: number | null;
  readonly currency: string | null;
  readonly cost_status: 'RECORDED' | 'UNAVAILABLE';
  readonly provenance: Record<string, unknown>;
  readonly recorded_at: string;
}

export interface LlmCostSink {
  appendTokenCost(input: LlmCostRecordInput): Promise<unknown>;
}

export interface LlmUsageReader {
  totalTokensForTenant(tenant_id: string): Promise<number>;
}

export interface LlmCallContext {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly step_index: number;
  readonly attempt: number;
}

export interface LlmUsageRecordContext extends LlmCallContext {
  readonly provider: string;
  readonly model: string;
  readonly request_id?: string | null;
  readonly usage: LlmUsage | null | undefined;
}

export interface LlmUsageRecorderOptions {
  readonly sink?: LlmCostSink;
  readonly reader?: LlmUsageReader;
  readonly ledger?: CostLedger;
  readonly budget?: TokenBudgetGuard;
  readonly budgetConfig?: BudgetConfig;
  readonly warn?: (event: { readonly code: string; readonly tenant_id: string; readonly run_id: string }) => void;
  readonly now?: () => string;
  readonly recordId?: () => string;
}

export class LlmTokenBudgetError extends Error {
  readonly code: 'LLM_TOKEN_BUDGET_EXHAUSTED' | 'LLM_TOKEN_BUDGET_UNAVAILABLE';

  constructor(code: LlmTokenBudgetError['code']) {
    super(code);
    this.name = 'LlmTokenBudgetError';
    this.code = code;
  }
}

/**
 * Performs fail-closed pre-provider admission and persists provider-reported usage only.
 * The sink is intentionally structural so the core does not depend on a concrete database module.
 */
export class LlmUsageRecorder {
  private readonly ledger: CostLedger;
  private readonly budget: TokenBudgetGuard;
  private readonly sink: LlmCostSink | undefined;
  private readonly reader: LlmUsageReader | undefined;
  private readonly warn: (event: { readonly code: string; readonly tenant_id: string; readonly run_id: string }) => void;
  private readonly now: () => string;
  private readonly recordId: () => string;

  public constructor(options: LlmUsageRecorderOptions = {}) {
    this.ledger = options.ledger ?? new CostLedger();
    this.budget = options.budget ?? new TokenBudgetGuard(options.budgetConfig);
    this.sink = options.sink;
    this.reader = options.reader;
    this.warn = options.warn ?? (() => undefined);
    this.now = options.now ?? (() => new Date().toISOString());
    this.recordId = options.recordId ?? randomUUID;
  }

  public async beforeCall(context: LlmCallContext): Promise<void> {
    if (this.reader !== undefined) {
      let total: number;
      try {
        total = await this.reader.totalTokensForTenant(context.tenant_id);
      } catch {
        throw new LlmTokenBudgetError('LLM_TOKEN_BUDGET_UNAVAILABLE');
      }
      this.budget.setUsedTokens(context.tenant_id, total);
    }
    const decision = this.budget.check({
      tenant_id: context.tenant_id,
      run_id: context.run_id,
      input_tokens: 0,
      output_tokens: 0,
    });
    if (!decision.allowed) throw new LlmTokenBudgetError('LLM_TOKEN_BUDGET_EXHAUSTED');
  }

  public async record(context: LlmUsageRecordContext): Promise<CostRecord | null> {
    if (context.usage === undefined || context.usage === null) {
      this.warn({ code: 'LLM_USAGE_MISSING', tenant_id: context.tenant_id, run_id: context.run_id });
      return null;
    }

    const usage: CostUsage = {
      input_tokens: context.usage.prompt_tokens,
      output_tokens: context.usage.completion_tokens,
      ...(context.usage.cached_tokens === undefined ? {} : { cached_tokens: context.usage.cached_tokens }),
    };
    const row = this.ledger.record({
      ...usage,
      tenant_id: context.tenant_id,
      run_id: context.run_id,
      correlation_id: context.correlation_id,
      provider: context.provider,
      model: context.model,
      timestamp: this.now(),
    });
    this.budget.consume({ ...usage, tenant_id: context.tenant_id, run_id: context.run_id });
    if (this.sink !== undefined) {
      try {
        await this.sink.appendTokenCost({
          tenant_id: context.tenant_id,
          record_id: this.recordId(),
          idempotency_key: llmIdempotencyKey(context.run_id, context.step_index, context.attempt),
          run_id: context.run_id,
          correlation_id: context.correlation_id,
          provider: context.provider,
          model: context.model,
          input_tokens: row.input_tokens ?? 0,
          output_tokens: row.output_tokens ?? 0,
          cached_tokens: row.cached_tokens,
          estimated_cost_amount: row.estimated_amount,
          currency: row.currency,
          cost_status: row.cost_status === 'AVAILABLE' ? 'RECORDED' : 'UNAVAILABLE',
          provenance: {
            source: 'llm_provider_usage',
            step_index: context.step_index,
            attempt: context.attempt,
            ...(context.request_id === undefined || context.request_id === null ? {} : { request_id: context.request_id }),
          },
          recorded_at: row.timestamp,
        });
      } catch {
        this.warn({ code: 'LLM_USAGE_RECORD_FAILED', tenant_id: context.tenant_id, run_id: context.run_id });
      }
    }
    return row;
  }

  public get entries(): readonly CostRecord[] {
    return this.ledger.entries();
  }
}

export function llmIdempotencyKey(run_id: string, step_index: number, attempt: number): string {
  const raw = `llm:${run_id}:${step_index}:${attempt}`;
  if (raw.length <= 128) return raw;
  return `llm:${createHash('sha256').update(raw, 'utf8').digest('hex')}`;
}
