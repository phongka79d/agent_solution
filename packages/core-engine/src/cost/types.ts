import type { ExecutionReceipt } from '../contracts/types.js';

/** Whether an execution cost is backed by a usable provider pricing entry. */
export type CostStatus = 'AVAILABLE' | 'UNAVAILABLE';

/** Pricing supplied by a provider or an owner-approved pricing configuration. */
export interface ProviderPricing {
  readonly provider: string;
  readonly model: string;
  readonly model_version?: string;
  readonly currency: string;
  /** Price per 1,000 input tokens. */
  readonly input_cost_per_1k_tokens?: number;
  /** Price per 1,000 output tokens. */
  readonly output_cost_per_1k_tokens?: number;
  /** Price per 1,000 cached tokens, when the provider exposes one. */
  readonly cached_cost_per_1k_tokens?: number;
  /** Price per input token; takes precedence over the per-1,000 form. */
  readonly input_cost_per_token?: number;
  /** Price per output token; takes precedence over the per-1,000 form. */
  readonly output_cost_per_token?: number;
  /** Price per cached token; takes precedence over the per-1,000 form. */
  readonly cached_cost_per_token?: number;
  /** Source/version of the price, never inferred by the ledger. */
  readonly provenance: string;
}

export interface PricingLookup {
  getPricing(query: {
    readonly provider: string;
    readonly model: string;
    readonly model_version?: string;
  }): ProviderPricing | null | undefined;
}

export type PricingSource =
  | ProviderPricing
  | readonly ProviderPricing[]
  | PricingLookup
  | ((query: {
      readonly provider: string;
      readonly model: string;
      readonly model_version?: string;
    }) => ProviderPricing | null | undefined);

/** Input token facts associated with one execution. */
export interface CostUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly cached_tokens?: number;
}

/** Metadata and usage captured for one append-only cost record. */
export interface CostRecordInput extends CostUsage {
  readonly receipt?: ExecutionReceipt;
  readonly model?: string;
  readonly provider?: string;
  readonly model_version?: string;
  /** A caller-reported estimate is accepted only when pricing is also resolved. */
  readonly estimated_cost?: number;
  readonly currency?: string;
  readonly provenance?: string;
  readonly run_id?: string;
  readonly tenant_id?: string;
  readonly correlation_id?: string;
  readonly timestamp?: string;
}

/** Canonical cost ledger row. Missing values remain null; no zero defaults are fabricated. */
export interface CostRecord {
  readonly model: string | null;
  readonly provider: string | null;
  readonly input_tokens: number | null;
  readonly output_tokens: number | null;
  readonly cached_tokens: number | null;
  readonly estimated_cost: number | null;
  /** Alias for consumers that call the amount an estimated amount. */
  readonly estimated_amount: number | null;
  readonly currency: string | null;
  readonly provenance: string | null;
  readonly cost_status: CostStatus;
  readonly run_id: string | null;
  readonly tenant_id: string | null;
  readonly correlation_id: string | null;
  readonly timestamp: string;
  readonly model_version: string | null;
}

export interface CostLedgerOptions {
  readonly pricing?: PricingSource;
  readonly now?: () => string;
}

export type BudgetExceedAction = 'FAIL_CLOSED' | 'PARK';

/** Optional token limits. An omitted limit means no limit, not a default limit. */
export interface BudgetConfig {
  readonly token_budget?: number;
  readonly per_run_token_budget?: number;
  readonly on_exceed?: BudgetExceedAction;
  /** When true, cached tokens are included in the guarded token total. */
  readonly use_cache?: boolean;
}

export interface BudgetUsage extends CostUsage {
  readonly run_id: string;
  /** Tenant scope for an independent tenant budget; omitted keeps legacy process scope. */
  readonly tenant_id?: string;
}

export type BudgetDecisionStatus = 'ALLOWED' | 'PARKED' | 'FAILED';
export type BudgetDecisionAction = 'ALLOW' | BudgetExceedAction;

export interface BudgetDecision {
  readonly status: BudgetDecisionStatus;
  readonly action: BudgetDecisionAction;
  readonly allowed: boolean;
  readonly reason: 'WITHIN_BUDGET' | 'NO_BUDGET_CONFIGURED' | 'TOKEN_BUDGET_EXCEEDED';
  readonly requested_tokens: number;
  readonly total_tokens: number;
  readonly run_tokens: number;
  readonly token_budget: number | null;
  readonly per_run_token_budget: number | null;
  readonly run_id: string;
  readonly tenant_id?: string;
}

