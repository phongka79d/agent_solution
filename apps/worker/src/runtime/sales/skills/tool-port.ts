import type { Customer360Fact, HydratedContext } from '@agentos/core-engine/contracts';
import type { CustomerEventTimeline } from '@agentos/database';
import type { SkillToolInvocation, SkillToolPort } from '@agentos/skills';
import type { ErpReadPort } from '../../connectors.js';
import type { SalesAdvisorExecutionState } from '../advisor-adapters.js';
import type {
  SalesCartInput,
  SalesCartPort,
  SalesCommunicationInput,
  SalesCommunicationPort,
  SalesConsentPort,
  SalesCustomer360Fact,
  SalesFrequencyCapPort,
  SalesOrderInput,
  SalesOrderPort,
  SalesPaymentPolicyPort,
  SalesPriceFloorPort,
  SalesQuotePort,
  SalesReplenishmentPolicyPort,
} from './types.js';
import { SalesSkillToolError } from './quote-payment-guards.js';
import {
  handleCheckPrice,
  handleCheckStock,
  handleRecommendProduct,
  handleRetrieveCustomer,
  handleSearchProduct,
} from './read-handlers.js';
import {
  handleCreateCart,
  handleCreateOrder,
  handleSendMessage,
} from './mutation-handlers.js';
export {
  buildCanonicalQuotePayload,
  computeQuoteToken,
  hasAuthoritativeQuotePort,
  hasPaymentPolicyPort,
  hasQuoteSigningSecret,
  SalesSkillToolError,
  timingSafeCompare,
} from './quote-payment-guards.js';
export type {
  AuthoritativeQuoteResult,
  QuoteTokenPayload,
} from './quote-payment-guards.js';

export interface SalesContextAggregatorLike {
  verifiedCustomerFor(
    context: HydratedContext,
  ): Customer360Fact | SalesCustomer360Fact | Promise<Customer360Fact | SalesCustomer360Fact | null> | null;
  verifiedTimelineFor(
    context: HydratedContext,
  ): CustomerEventTimeline | Promise<CustomerEventTimeline | null> | null;
  takeoverActiveFor?(context: HydratedContext): Promise<boolean> | boolean;
}

/** Optional owner-approved revenue evidence for a personalized recommendation's economic outcome. */
export interface SalesRecommendationRevenueEvidence {
  readonly conversion_probability: number;
  readonly expected_revenue: number;
  readonly currency: string;
  readonly model_id: string;
  readonly provenance_reference: string;
}

/**
 * Host-provided boundary for the recommendation contract's economic outcome.
 * Without an owner-approved source, advice still succeeds with no expected outcome.
 */
export interface SalesRecommendationRevenueEvidencePort {
  read(input: {
    readonly tenant_id: string;
    readonly customer_id: string;
    readonly sku: string;
    readonly recommendation_type: string;
    readonly confidence: number;
    readonly list_price: number;
    readonly currency: string;
  }): Promise<SalesRecommendationRevenueEvidence>;
}

export interface SalesSkillToolPortOptions {
  readonly erp_read: ErpReadPort | null;
  readonly context: SalesContextAggregatorLike;
  /** Optional owner-approved revenue evidence; absence means no expected outcome is stated. */
  readonly revenue_evidence?: SalesRecommendationRevenueEvidencePort | undefined;
  /** Retained as an injection seam for callers; this port never invents provider timestamps. */
  readonly now?: (() => Date) | undefined;
  /** Run-scoped, tenant-keyed state for server-stamped advisor requirements and read guards. */
  readonly advisor_state?: SalesAdvisorExecutionState | undefined;

  readonly price_floor?: SalesPriceFloorPort | null | undefined;
  readonly cart?: SalesCartPort | null | undefined;
  readonly order?: SalesOrderPort | null | undefined;
  readonly communication?: SalesCommunicationPort | null | undefined;
  readonly consent?: SalesConsentPort | null | undefined;
  readonly frequency_cap?: SalesFrequencyCapPort | null | undefined;
  readonly replenishment_policy?: SalesReplenishmentPolicyPort | null | undefined;
  readonly quote?: SalesQuotePort | null | undefined;
  readonly payment_policy?: SalesPaymentPolicyPort | null | undefined;
  readonly is_takeover_active?: ((tenant_id: string, correlation_id: string) => Promise<boolean> | boolean) | undefined;
  readonly takeover_active?: boolean | undefined;
  readonly quote_signing_secret?: string | undefined;
}

export function hasTakeoverAuthority(options: {
  readonly takeover_active?: boolean | undefined;
  readonly is_takeover_active?: ((tenant_id: string, correlation_id: string) => Promise<boolean> | boolean) | undefined;
  readonly context?: {
    readonly takeoverActiveFor?: ((context: HydratedContext) => Promise<boolean> | boolean) | undefined;
  } | undefined;
}): boolean {
  return (
    typeof options.takeover_active === 'boolean'
    || typeof options.is_takeover_active === 'function'
    || typeof options.context?.takeoverActiveFor === 'function'
  );
}

interface SearchProductInput {
  readonly tenant_id: string;
  readonly query: string;
  readonly category_id?: string;
  readonly limit?: number;
}

interface CheckStockInput {
  readonly tenant_id: string;
  readonly sku_id: string;
}

interface RetrieveCustomerInput {
  readonly tenant_id: string;
  readonly customer_identifier: string;
}

interface RecommendProductInput {
  readonly tenant_id: string;
  readonly customer_id?: string;
  readonly current_cart_skus: readonly string[];
  readonly recommendation_type?: string;
}

interface CheckPriceInput {
  readonly tenant_id: string;
  readonly sku_id: string;
  readonly customer_id?: string;
  readonly requested_discount_percent?: number;
}

export function createSalesSkillToolPort(options: SalesSkillToolPortOptions): SkillToolPort {
  return {
    async invoke<TInput, TOutput>(invocation: SkillToolInvocation<TInput>): Promise<TOutput> {
      if (
        invocation.skill_id === 'skill.sales.search_product'
        && invocation.tool_binding === 'API-001.CatalogConnector'
      ) {
        return await handleSearchProduct(
          options,
          invocation as unknown as SkillToolInvocation<SearchProductInput>,
        ) as TOutput;
      }
      if (
        invocation.skill_id === 'skill.sales.check_stock'
        && invocation.tool_binding === 'API-001.InventoryConnector'
      ) {
        return await handleCheckStock(
          options,
          invocation as unknown as SkillToolInvocation<CheckStockInput>,
        ) as TOutput;
      }
      if (
        invocation.skill_id === 'skill.sales.retrieve_customer'
        && invocation.tool_binding === 'PostgreSQL.Customer360Store'
      ) {
        return await handleRetrieveCustomer(
          options,
          invocation as unknown as SkillToolInvocation<RetrieveCustomerInput>,
        ) as TOutput;
      }
      if (
        invocation.skill_id === 'skill.sales.recommend_product'
        && invocation.tool_binding === 'Core.RecommendationEngine'
      ) {
        return await handleRecommendProduct(
          options,
          invocation as unknown as SkillToolInvocation<RecommendProductInput>,
        ) as TOutput;
      }
      if (
        invocation.skill_id === 'skill.sales.check_price'
        && invocation.tool_binding === 'API-001.PricingEngine'
      ) {
        return await handleCheckPrice(
          options,
          invocation as unknown as SkillToolInvocation<CheckPriceInput>,
        ) as TOutput;
      }
      if (
        invocation.skill_id === 'skill.sales.create_cart'
        && invocation.tool_binding === 'API-002.CommerceCartAPI'
      ) {
        return await handleCreateCart(
          options,
          invocation as unknown as SkillToolInvocation<SalesCartInput>,
        ) as TOutput;
      }
      if (
        invocation.skill_id === 'skill.sales.create_order'
        && invocation.tool_binding === 'API-001.OrderConnector'
      ) {
        return await handleCreateOrder(
          options,
          invocation as unknown as SkillToolInvocation<SalesOrderInput>,
        ) as TOutput;
      }
      if (
        invocation.skill_id === 'skill.sales.send_message'
        && invocation.tool_binding === 'API-003.CommunicationConnector'
      ) {
        return await handleSendMessage(
          options,
          invocation as unknown as SkillToolInvocation<SalesCommunicationInput>,
        ) as TOutput;
      }

      throw new SalesSkillToolError(
        'UNKNOWN_CAPABILITY',
        `Sales tool binding is not enabled for ${invocation.skill_id}`,
      );
    },
  };
}
