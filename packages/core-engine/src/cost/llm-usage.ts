import { Buffer } from 'node:buffer';
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

export interface LlmTokenBudgetReservationInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly reservation_id: string;
  readonly estimated_tokens: number;
  readonly tenant_token_budget: number | null;
  readonly run_token_budget: number | null;
}

/** Durable, atomic admission and settlement for concurrent provider calls. */
export interface LlmTokenBudgetReservationStore {
  reserveTokenBudget(input: LlmTokenBudgetReservationInput): Promise<boolean>;
  settleTokenBudget(input: {
    readonly tenant_id: string;
    readonly run_id: string;
    readonly reservation_id: string;
    /** Null keeps the conservative reservation when the provider omitted usage. */
    readonly actual_tokens: number | null;
  }): Promise<void>;
  releaseTokenBudget(input: {
    readonly tenant_id: string;
    readonly run_id: string;
    readonly reservation_id: string;
  }): Promise<void>;
}


function normalizeEstimatedTokens(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new LlmTokenBudgetError('LLM_TOKEN_BUDGET_UNAVAILABLE');
  }
  return value;
}

function totalUsage(usage: LlmUsage | null | undefined): number | null {
  if (usage === undefined || usage === null) return null;
  const total = usage.prompt_tokens + usage.completion_tokens;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new LlmTokenBudgetError('LLM_TOKEN_BUDGET_UNAVAILABLE');
  }
  return total;
}


function validateReservationConfig(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('LLM_TOKEN_BUDGET_INVALID');
  }
  return value;
}

/** Conservative content-byte estimate plus message framing and the requested output ceiling. */
export function estimateLlmCallTokens(
  messages: readonly { readonly content: string }[],
  maxOutputTokens: number,
): number {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new LlmTokenBudgetError('LLM_TOKEN_BUDGET_UNAVAILABLE');
  }
  let estimated = maxOutputTokens + 2;
  for (const message of messages) {
    estimated += Buffer.byteLength(message.content, 'utf8') + 4;
    if (!Number.isSafeInteger(estimated)) {
      throw new LlmTokenBudgetError('LLM_TOKEN_BUDGET_UNAVAILABLE');
    }
  }
  return estimated;
}



export interface LlmCallContext {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly correlation_id: string;
  readonly step_index: number;
  readonly attempt: number;
  readonly call_index?: number;
}

export interface LlmUsageRecordContext extends LlmCallContext {
  readonly provider: string;
  readonly model: string;
  readonly request_id?: string | null;
  readonly usage: LlmUsage | null | undefined;
}
export interface LlmUsageFailureRecordContext extends LlmCallContext {
  readonly provider: string;
  readonly model: string;
  readonly error_code: string;
  readonly provider_error?: {
    readonly status: number | null;
    readonly type: string | null;
    readonly code: string | null;
  };
  readonly attempts: number;
}

export interface LlmUsageRecorderOptions {
  readonly sink?: LlmCostSink;
  readonly reader?: LlmUsageReader;
  readonly ledger?: CostLedger;
  readonly budget?: TokenBudgetGuard;
  readonly budgetConfig?: BudgetConfig;
  readonly reservationStore?: LlmTokenBudgetReservationStore;
  readonly runTokenBudget?: number;
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
  private readonly reservationStore: LlmTokenBudgetReservationStore | undefined;
  private readonly tenantTokenBudget: number | null;
  private readonly runTokenBudget: number | null;
  private readonly warn: (event: { readonly code: string; readonly tenant_id: string; readonly run_id: string }) => void;
  private readonly now: () => string;
  private readonly recordId: () => string;

  public constructor(options: LlmUsageRecorderOptions = {}) {
    this.ledger = options.ledger ?? new CostLedger();
    this.budget = options.budget ?? new TokenBudgetGuard(options.budgetConfig);
    this.sink = options.sink;
    this.reader = options.reader;
    this.reservationStore = options.reservationStore;
    this.tenantTokenBudget = validateReservationConfig(options.budgetConfig?.token_budget);
    this.runTokenBudget = validateReservationConfig(
      options.runTokenBudget ?? options.budgetConfig?.per_run_token_budget,
    );
    this.warn = options.warn ?? (() => undefined);
    this.now = options.now ?? (() => new Date().toISOString());
    this.recordId = options.recordId ?? randomUUID;
  }

  public async beforeCall(context: LlmCallContext, estimated_tokens = 0): Promise<void> {
    const estimated = normalizeEstimatedTokens(estimated_tokens);
    if (this.reservationStore !== undefined) {
      let allowed: boolean;
      try {
        allowed = await this.reservationStore.reserveTokenBudget({
          tenant_id: context.tenant_id,
          run_id: context.run_id,
          reservation_id: llmIdempotencyKey(
            context.run_id,
            context.step_index,
            context.attempt,
            context.call_index,
          ),
          estimated_tokens: estimated,
          tenant_token_budget: this.tenantTokenBudget,
          run_token_budget: this.runTokenBudget,
        });
      } catch {
        throw new LlmTokenBudgetError('LLM_TOKEN_BUDGET_UNAVAILABLE');
      }
      if (!allowed) throw new LlmTokenBudgetError('LLM_TOKEN_BUDGET_EXHAUSTED');
      return;
    }

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
      output_tokens: estimated,
    });
    if (!decision.allowed) throw new LlmTokenBudgetError('LLM_TOKEN_BUDGET_EXHAUSTED');
  }


  public async record(context: LlmUsageRecordContext): Promise<CostRecord | null> {
    if (context.usage === undefined || context.usage === null) {
      this.warn({ code: 'LLM_USAGE_MISSING', tenant_id: context.tenant_id, run_id: context.run_id });
      await this.settleReservation(context, null);
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
          idempotency_key: llmIdempotencyKey(
            context.run_id,
            context.step_index,
            context.attempt,
            context.call_index,
          ),
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
    await this.settleReservation(context, totalUsage(context.usage));
    return row;
  }

  public async recordFailure(context: LlmUsageFailureRecordContext): Promise<void> {
    if (this.sink !== undefined) {
      try {
        await this.sink.appendTokenCost({
          tenant_id: context.tenant_id,
          record_id: this.recordId(),
          idempotency_key: llmIdempotencyKey(
            context.run_id,
            context.step_index,
            context.attempt,
            context.call_index,
          ),
          run_id: context.run_id,
          correlation_id: context.correlation_id,
          provider: context.provider,
          model: context.model,
          input_tokens: 0,
          output_tokens: 0,
          cached_tokens: null,
          estimated_cost_amount: null,
          currency: null,
          cost_status: 'UNAVAILABLE',
          provenance: {
            source: 'llm_provider_failure',
            step_index: context.step_index,
            attempt: context.attempt,
            error_code: context.error_code,
            attempts: context.attempts,
            ...(context.provider_error === undefined ? {} : { provider_error: context.provider_error }),
          },
          recorded_at: this.now(),
        });
      } catch {
        this.warn({ code: 'LLM_USAGE_RECORD_FAILED', tenant_id: context.tenant_id, run_id: context.run_id });
      }
    }
    await this.releaseReservation(context);
  }

  private async settleReservation(
    context: LlmCallContext,
    actual_tokens: number | null,
  ): Promise<void> {
    if (this.reservationStore === undefined) return;
    try {
      await this.reservationStore.settleTokenBudget({
        tenant_id: context.tenant_id,
        run_id: context.run_id,
        reservation_id: llmIdempotencyKey(
          context.run_id,
          context.step_index,
          context.attempt,
          context.call_index,
        ),
        actual_tokens,
      });
    } catch {
      throw new LlmTokenBudgetError('LLM_TOKEN_BUDGET_UNAVAILABLE');
    }
  }

  private async releaseReservation(context: LlmCallContext): Promise<void> {
    if (this.reservationStore === undefined) return;
    try {
      await this.reservationStore.releaseTokenBudget({
        tenant_id: context.tenant_id,
        run_id: context.run_id,
        reservation_id: llmIdempotencyKey(
          context.run_id,
          context.step_index,
          context.attempt,
          context.call_index,
        ),
      });
    } catch {
      throw new LlmTokenBudgetError('LLM_TOKEN_BUDGET_UNAVAILABLE');
    }
  }


  public get entries(): readonly CostRecord[] {
    return this.ledger.entries();
  }
}

export function llmIdempotencyKey(
  run_id: string,
  step_index: number,
  attempt: number,
  call_index = 0,
): string {
  const raw = call_index === 0
    ? `llm:${run_id}:${step_index}:${attempt}`
    : `llm:${run_id}:${step_index}:${attempt}:${call_index}`;
  if (raw.length <= 128) return raw;
  return `llm:${createHash('sha256').update(raw, 'utf8').digest('hex')}`;
}
