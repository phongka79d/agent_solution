import type { AssignableAuthority, Customer360Fact, IAdapterDispatcher } from '@agentos/core-engine/contracts';
import type { ConsentSource, ConsentState } from '@agentos/core-engine';
import type { SkillRegistry, SkillRuntimeEngine, SkillToolPort } from '@agentos/skills';
import type { ErpReadPort } from '../../connectors.js';
import type {
  SalesContextAggregatorLike,
  SalesRecommendationRevenueEvidencePort,
} from './tool-port.js';

export type { ErpReadPort } from '../../connectors.js';
export type {
  SalesContextAggregatorLike,
  SalesRecommendationRevenueEvidence,
  SalesRecommendationRevenueEvidencePort,
  SalesSkillToolPortOptions,
} from './tool-port.js';

/** Customer 360 verified purchase/order evidence entry. */
export interface VerifiedPurchaseEvidence {
  readonly order_id: string;
  readonly order_date: string;
  readonly total_amount?: number | undefined;
  readonly currency?: string | undefined;
  readonly items?: readonly string[] | undefined;
}

/** Extended Customer 360 fact carrying real verified purchase evidence. */
export interface SalesCustomer360Fact extends Customer360Fact {
  readonly last_order_date?: string | null | undefined;
  readonly purchase_evidence?: readonly VerifiedPurchaseEvidence[] | undefined;
  readonly purchases?: readonly VerifiedPurchaseEvidence[] | undefined;
  readonly verified_purchases?: readonly VerifiedPurchaseEvidence[] | undefined;
  readonly order_events?: readonly VerifiedPurchaseEvidence[] | undefined;
}

/** Query for API-001.PricingEngine floor decision. */
export interface SalesPriceFloorQuery {
  readonly tenant_id: string;
  readonly sku_id: string;
}

/** Owner-approved floor decision with full provenance and quote TTL. */
export interface SalesPriceFloorApproved {
  readonly ok?: true;
  readonly list_price: number;
  readonly currency: string;
  readonly p_floor: number;
  readonly floor_source: string;
  readonly owner_approved: true;
  readonly quote_ttl_seconds: number;
  readonly reason?: never;
}

/** Explicit refusal reason from the pricing engine. */
export interface SalesPriceFloorRefused {
  readonly ok?: false;
  readonly owner_approved?: false;
  readonly reason: string;
  readonly list_price?: never;
  readonly currency?: never;
  readonly p_floor?: never;
  readonly floor_source?: never;
  readonly quote_ttl_seconds?: never;
}

export type SalesPriceFloorDecision = SalesPriceFloorApproved | SalesPriceFloorRefused;

/** Single item within an aggregate price floor query. */
export interface SalesPriceFloorItemQuery {
  readonly sku_id: string;
  readonly quantity?: number | undefined;
  readonly proposed_price?: number | undefined;
  readonly list_price?: number | undefined;
}

/** Query for API-001.PricingEngine aggregate/cart-level floor decision. */
export interface SalesAggregatePriceFloorQuery {
  readonly tenant_id: string;
  readonly items: readonly SalesPriceFloorItemQuery[];
  readonly offer_id?: string | undefined;
  readonly discount_amount?: number | undefined;
  readonly discount_percent?: number | undefined;
  readonly proposed_price?: number | undefined;
  readonly currency?: string | undefined;
}

/** Injected port for API-001.PricingEngine. Never computes p_floor locally. */
export interface SalesPriceFloorPort {
  read(query: SalesPriceFloorQuery): Promise<SalesPriceFloorDecision>;
  readAggregate?(query: SalesAggregatePriceFloorQuery): Promise<SalesPriceFloorDecision | undefined>;
  readQuote?(query: SalesQuoteQuery): Promise<SalesQuote | undefined>;
}

/** Inbound item for shopping cart mutation. */
export interface SalesCartItem {
  readonly sku_id: string;
  readonly quantity: number;
}

/** Inbound payload for API-002.CommerceCartAPI. */
export interface SalesCartInput {
  readonly tenant_id: string;
  readonly session_id: string;
  readonly customer_id?: string | undefined;
  readonly items: readonly SalesCartItem[];
  readonly idempotency_key: string;
  readonly offer_id?: string | undefined;
  readonly discount_amount?: number | undefined;
  readonly discount_percent?: number | undefined;
}

/** Canonical output schema of API-002.CommerceCartAPI. */
export interface SalesCartOutput {
  readonly cart_id: string;
  readonly item_count: number;
  readonly subtotal: number;
  readonly currency: string;
  readonly updated_at: string;
}

export interface SalesCartPort {
  createCart?(input: SalesCartInput): Promise<SalesCartOutput>;
  create?(input: SalesCartInput): Promise<SalesCartOutput>;
  execute?(input: SalesCartInput): Promise<SalesCartOutput>;
  getCart?(query: SalesQuoteQuery): Promise<SalesCartOutput | SalesQuote | undefined>;
  readCart?(query: SalesQuoteQuery): Promise<SalesCartOutput | SalesQuote | undefined>;
  getQuote?(query: SalesQuoteQuery): Promise<SalesQuote | SalesCartOutput | undefined>;
  readQuote?(query: SalesQuoteQuery): Promise<SalesQuote | SalesCartOutput | undefined>;
  read?(query: SalesQuoteQuery): Promise<SalesCartOutput | SalesQuote | undefined>;
  readonly quote?: SalesQuotePort | undefined;
}

/** Inbound payload for API-001.OrderConnector. */
export interface SalesOrderInput {
  readonly tenant_id: string;
  readonly cart_id: string;
  readonly customer_id: string;
  readonly shipping_address: Record<string, unknown>;
  readonly payment_method: 'CREDIT_CARD' | 'CVS_COD' | 'LINE_PAY' | 'JKOPAY' | 'STRIPE' | 'PAYPAL';
  readonly effect_key: string;
  readonly quote_token?: string | undefined;
  readonly quote_expires_at?: string | undefined;
  readonly sku_id?: string | undefined;
  readonly p_floor?: number | undefined;
  readonly final_price?: number | undefined;
  readonly currency?: string | undefined;
}

/** Canonical output schema of API-001.OrderConnector. */
export interface SalesOrderOutput {
  readonly order_id: string;
  readonly order_number: string;
  readonly total_amount: number;
  readonly currency: string;
  readonly status: 'DRAFT' | 'PENDING_PAYMENT' | 'CONFIRMED';
  readonly payment_url?: string | undefined;
  readonly created_at: string;
}

export interface SalesOrderPort {
  createOrder?(input: SalesOrderInput): Promise<SalesOrderOutput>;
  create?(input: SalesOrderInput): Promise<SalesOrderOutput>;
  execute?(input: SalesOrderInput): Promise<SalesOrderOutput>;
  validateQuote?(query: SalesQuoteQuery): Promise<SalesQuote | SalesCartOutput | undefined>;
  authorizeOrder?(query: SalesQuoteQuery): Promise<SalesQuote | SalesCartOutput | undefined>;
  readSupportedPaymentMethods?(query: SalesPaymentPolicyQuery | string): Promise<readonly string[] | undefined> | readonly string[] | undefined;
  readonly payment_policy?: SalesPaymentPolicyPort | undefined;
}

/** Card payload inside outbound message content. */
export interface SalesOutboundMessageCard {
  readonly title: string;
  readonly description: string;
  readonly image_url?: string | undefined;
  readonly action_url?: string | undefined;
}

/** Outbound message payload. */
export interface SalesOutboundMessageContent {
  readonly text: string;
  readonly quick_replies?: readonly string[] | undefined;
  readonly template_id?: string | undefined;
  readonly template_params?: Record<string, string> | undefined;
  readonly card?: SalesOutboundMessageCard | undefined;
}

/** Inbound payload for API-003.CommunicationConnector. */
export interface SalesCommunicationInput {
  readonly tenant_id: string;
  readonly recipient_id: string;
  readonly channel: 'LINE' | 'WHATSAPP' | 'WEB_CHAT' | 'SMS' | 'ZALO' | 'TIKTOK' | 'MESSENGER' | 'INSTAGRAM';
  readonly message_content: SalesOutboundMessageContent;
  readonly effect_key: string;
}

export interface SalesCommunicationOutput {
  readonly message_id: string;
  readonly provider_reference: string;
  readonly delivered_at: string;
}

/** Injected port for API-003.CommunicationConnector. */
export interface SalesCommunicationPort {
  sendMessage?(input: SalesCommunicationInput): Promise<SalesCommunicationOutput>;
  send?(input: SalesCommunicationInput): Promise<SalesCommunicationOutput>;
  execute?(input: SalesCommunicationInput): Promise<SalesCommunicationOutput>;
}

/** Inbound query for channel-specific consent and suppression read. */
export interface SalesConsentQuery {
  readonly tenant_id: string;
  readonly customer_id: string;
  readonly channel: string;
}

/** Output of channel-specific consent and suppression read. */
export interface SalesConsentDecision {
  readonly consented: boolean;
  readonly suppressed: boolean;
  readonly reason?: string | undefined;
}

/** Inbound query for customer-level consent and suppression read. */
export interface SalesCustomerConsentQuery {
  readonly tenant_id: string;
  readonly customer_id: string;
}

/** Customer-level consent state from the authoritative consent boundary. */
export type SalesCustomerConsentState = ConsentState;

/** Injected port for channel-specific and customer-level consent and suppression read. */
export interface SalesConsentPort extends ConsentSource {
  /** Channel-specific consent and suppression check (enforced at tool port). */
  read(query: SalesConsentQuery): Promise<SalesConsentDecision>;
  /** Customer-level consent and suppression read (enforced at PEP). */
  getConsent(input: {
    readonly tenant_id: string;
    readonly customer_id: string;
  }): Promise<ConsentState | undefined>;
}

/** Query for tenant-configured reminder frequency cap. */
export interface SalesFrequencyCapQuery {
  readonly tenant_id: string;
  readonly cart_id?: string | undefined;
  readonly chain_id?: string | undefined;
  readonly recipient_id?: string | undefined;
  readonly customer_id?: string | undefined;
  readonly channel?: string | undefined;
}

/** Tenant-configured frequency cap configuration. */
export interface SalesFrequencyCapConfig {
  readonly max_reminders?: number | undefined;
  readonly window_seconds?: number | undefined;
  readonly allowed?: boolean | undefined;
  readonly remaining?: number | undefined;
  readonly [key: string]: unknown;
}

/** Injected port for tenant-configured reminder frequency cap. Never returns a platform default. */
export interface SalesFrequencyCapPort {
  read?(query: SalesFrequencyCapQuery): Promise<SalesFrequencyCapConfig | number | undefined> | SalesFrequencyCapConfig | number | undefined;
  getReminderCap?(query: SalesFrequencyCapQuery): Promise<SalesFrequencyCapConfig | number | undefined> | SalesFrequencyCapConfig | number | undefined;
}

/** Query for owner-approved replenishment policy (SAL-05). */
export interface SalesReplenishmentPolicyQuery {
  readonly tenant_id: string;
  readonly sku_id: string;
}

/** Owner-approved replenishment interval and evidence-staleness window. */
export interface SalesReplenishmentPolicy {
  readonly replenishment_interval_days: number;
  readonly evidence_staleness_window_days: number;
  readonly owner_approved: true;
  readonly [key: string]: unknown;
}

/** Injected port for SAL-05 replenishment policy. */
export interface SalesReplenishmentPolicyPort {
  read(query: SalesReplenishmentPolicyQuery): Promise<SalesReplenishmentPolicy | undefined> | SalesReplenishmentPolicy | undefined;
}
/** Query for tenant supported payment methods read. */
export interface SalesPaymentPolicyQuery {
  readonly tenant_id: string;
}

/** Tenant payment policy providing supported payment methods. */
export interface SalesPaymentPolicy {
  readonly supported_payment_methods: readonly string[];
  readonly [key: string]: unknown;
}

/** Injected port for tenant-configured supported payment methods. Never returns a platform default. */
export interface SalesPaymentPolicyPort {
  readSupportedPaymentMethods?(query: SalesPaymentPolicyQuery | string): Promise<readonly string[] | undefined> | readonly string[] | undefined;
  read?(query: SalesPaymentPolicyQuery | string): Promise<SalesPaymentPolicy | readonly string[] | undefined> | SalesPaymentPolicy | readonly string[] | undefined;
}

/** Query for authoritative priced cart/quote. */
export interface SalesQuoteQuery {
  readonly tenant_id: string;
  readonly cart_id: string;
}

/** Authoritative priced cart/quote output. */
export interface SalesQuote {
  readonly cart_id: string;
  readonly total_amount?: number | undefined;
  readonly subtotal?: number | undefined;
  readonly currency: string;
  readonly [key: string]: unknown;
}

/** Injected port for authoritative priced cart/quote verification. */
export interface SalesQuotePort {
  readQuote?(query: SalesQuoteQuery): Promise<SalesQuote | SalesCartOutput | undefined>;
  read?(query: SalesQuoteQuery): Promise<SalesQuote | SalesCartOutput | undefined>;
  getQuote?(query: SalesQuoteQuery): Promise<SalesQuote | SalesCartOutput | undefined>;
}


export interface SalesSkillOptions {
  readonly erp_read: ErpReadPort | null;
  readonly context: Pick<SalesContextAggregatorLike, 'verifiedCustomerFor' | 'verifiedTimelineFor'> & Partial<SalesContextAggregatorLike>;
  readonly revenue_evidence?: SalesRecommendationRevenueEvidencePort | undefined;
  readonly now?: (() => Date) | undefined;
  readonly resolve_correlation_id: (tenant_id: string, run_id: string) => Promise<string>;
  readonly resolve_grant: (tenant_id: string, agent_id: string) => Promise<AssignableAuthority | null>;

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

export interface SalesSkillServices {
  readonly registry: SkillRegistry;
  readonly tool_port: SkillToolPort;
  readonly dispatcher: IAdapterDispatcher;
  readonly unbound: readonly string[];
  readonly enabled_skills?: ReadonlySet<string> | undefined;
  readonly engine?: SkillRuntimeEngine | undefined;
}
