import type {
  LlmCallContext,
  LlmUsage,
  LlmUsageRecorder,
} from '../cost/llm-usage.js';

export type LlmLedgerStage = 'CONTEXT' | 'EXECUTION';

export interface LlmProviderError {
  readonly status: number | null;
  readonly type: string | null;
  readonly code: string | null;
}

export interface LlmProviderCallInput {
  readonly tenant_id: string;
  readonly run_id: string;
  readonly step_index: number;
  readonly stage: LlmLedgerStage;
  readonly call_index: number;
  readonly provider: string;
  readonly model: string;
  readonly observed_status: string;
  readonly latency_ms: number | null;
  readonly prompt_tokens: number | null;
  readonly completion_tokens: number | null;
  readonly cached_tokens: number | null;
  readonly estimated_cost_amount: number | null;
  readonly currency: string | null;
  readonly cost_status: 'RECORDED' | 'UNAVAILABLE' | null;
  readonly recorded_at: string;
}

export interface LlmProviderCallSink {
  appendProviderCall(input: LlmProviderCallInput): Promise<unknown>;
}

export interface LlmRecorderContext extends LlmCallContext {
  readonly stage: LlmLedgerStage;
  readonly call_index: number;
  readonly provider: string;
  readonly model: string;
}

export interface LlmRecorderSuccess extends LlmRecorderContext {
  readonly request_id?: string | null;
  readonly usage: LlmUsage | null | undefined;
  readonly latency_ms: number;
}

export interface LlmRecorderFailure extends LlmRecorderContext {
  readonly error_code: string;
  readonly provider_error?: LlmProviderError;
  readonly latency_ms: number;
  readonly attempts: number;
}

export interface LlmRecorderOptions {
  readonly usage: Pick<LlmUsageRecorder, 'beforeCall' | 'record' | 'recordFailure'>;
  readonly providerCalls: LlmProviderCallSink;
  readonly warn?: (event: { readonly code: string; readonly tenant_id: string; readonly run_id: string }) => void;
  readonly now?: () => string;
}

/** Coordinates one provider call's cost and outcome writes without depending on database code. */
export class LlmCallRecorder {
  private readonly usage: LlmRecorderOptions['usage'];
  private readonly providerCalls: LlmProviderCallSink;
  private readonly warn: NonNullable<LlmRecorderOptions['warn']>;
  private readonly now: () => string;

  constructor(options: LlmRecorderOptions) {
    this.usage = options.usage;
    this.providerCalls = options.providerCalls;
    this.warn = options.warn ?? (() => undefined);
    this.now = options.now ?? (() => new Date().toISOString());
  }

  beforeCall(context: LlmCallContext, estimated_tokens = 0): Promise<void> {
    return this.usage.beforeCall(context, estimated_tokens);
  }

  async recordSuccess(context: LlmRecorderSuccess): Promise<void> {
    const cost = await this.usage.record({
      tenant_id: context.tenant_id,
      run_id: context.run_id,
      correlation_id: context.correlation_id,
      step_index: context.step_index,
      attempt: context.attempt,
      call_index: context.call_index,
      provider: context.provider,
      model: context.model,
      ...(context.request_id === undefined ? {} : { request_id: context.request_id }),
      usage: context.usage,
    });
    await this.appendProviderCall({
      ...context,
      observed_status: 'SUCCESS',
      latency_ms: context.latency_ms,
      prompt_tokens: context.usage?.prompt_tokens ?? null,
      completion_tokens: context.usage?.completion_tokens ?? null,
      cached_tokens: context.usage?.cached_tokens ?? null,
      estimated_cost_amount: cost?.estimated_amount ?? null,
      currency: cost?.currency ?? null,
      cost_status: cost === null ? null : cost.cost_status === 'AVAILABLE' ? 'RECORDED' : 'UNAVAILABLE',
      recorded_at: cost?.timestamp ?? this.now(),
    });
  }

  async recordFailure(context: LlmRecorderFailure): Promise<void> {
    await this.usage.recordFailure({
      tenant_id: context.tenant_id,
      run_id: context.run_id,
      correlation_id: context.correlation_id,
      step_index: context.step_index,
      attempt: context.attempt,
      call_index: context.call_index,
      provider: context.provider,
      model: context.model,
      error_code: context.error_code,
      ...(context.provider_error === undefined ? {} : { provider_error: context.provider_error }),
      attempts: context.attempts,
    });
    await this.appendProviderCall({
      ...context,
      observed_status: context.error_code,
      latency_ms: context.latency_ms,
      prompt_tokens: null,
      completion_tokens: null,
      cached_tokens: null,
      estimated_cost_amount: null,
      currency: null,
      cost_status: 'UNAVAILABLE',
      recorded_at: this.now(),
    });
  }

  private async appendProviderCall(input: LlmProviderCallInput): Promise<void> {
    try {
      await this.providerCalls.appendProviderCall(input);
    } catch {
      this.warn({ code: 'LLM_PROVIDER_CALL_RECORD_FAILED', tenant_id: input.tenant_id, run_id: input.run_id });
    }
  }
}

