import type { ConnectorReadResult } from '@agentos/adapters';
import type { HydratedContext } from '@agentos/core-engine/contracts';
import type { SalesPriceFloorDecision, SalesPriceFloorPort } from './skills/types.js';
import type { ErpReadPort } from './skills/types.js';


/** Server-stamped requirements/proposals for one conversational advisor run. */
export interface SalesAdvisorBudget {
  readonly amount: number;
  readonly currency: string;
}

export interface SalesProductEligibilityProposal {
  /** A search hint only; inventory and quote reads must still verify the returned SKU. */
  readonly sku?: string;
  /** A search hint only; it is not authoritative catalog eligibility. */
  readonly category?: string;
}

export interface SalesAdvisorRequirements {
  readonly category?: string;
  readonly budget?: SalesAdvisorBudget;
  readonly use_case?: string;
  readonly product_eligibility?: SalesProductEligibilityProposal;
}


function salesRunState(context: HydratedContext) {
  context.run_state ??= {};
  context.run_state.sales ??= {};
  return context.run_state.sales;
}

function readRequirements(value: unknown): SalesAdvisorRequirements | undefined {
  if (!isRecord(value)) return undefined;
  const requirements: {
    category?: string;
    budget?: SalesAdvisorBudget;
    use_case?: string;
    product_eligibility?: SalesProductEligibilityProposal;
  } = {};
  if (typeof value['category'] === 'string') requirements.category = value['category'];
  if (typeof value['use_case'] === 'string') requirements.use_case = value['use_case'];
  const budget = value['budget'];
  if (isRecord(budget) && typeof budget['amount'] === 'number'
    && Number.isFinite(budget['amount']) && budget['amount'] >= 0
    && typeof budget['currency'] === 'string' && budget['currency'].trim().length > 0) {
    requirements.budget = { amount: budget['amount'], currency: budget['currency'] };
  }
  const eligibility = value['product_eligibility'];
  if (isRecord(eligibility)) {
    const product_eligibility: { sku?: string; category?: string } = {};
    if (typeof eligibility['sku'] === 'string') product_eligibility.sku = eligibility['sku'];
    if (typeof eligibility['category'] === 'string') product_eligibility.category = eligibility['category'];
    if (Object.keys(product_eligibility).length > 0) requirements.product_eligibility = product_eligibility;
  }
  return Object.keys(value).length === 0 || Object.keys(requirements).length > 0
    ? requirements
    : undefined;
}

/**
 * Small run-scoped state seam shared by the plan builder and Sales read handlers.
 * It carries server-stamped requirements and observations in checkpoint context; it never accepts
 * caller/model-selected SKU, price, authority or tenant values.
 */
export class SalesAdvisorExecutionState {
  setRequirements(context: HydratedContext, requirements: SalesAdvisorRequirements): void {
    salesRunState(context).advisor_requirements = requirements;
  }

  requirementsFor(context: HydratedContext): SalesAdvisorRequirements | undefined {
    return readRequirements(context.run_state?.sales?.advisor_requirements);
  }

  recordStock(context: HydratedContext, sku_id: string, available_quantity: number): void {
    const sales = salesRunState(context);
    const stock = sales.advisor_stock ?? Object.create(null) as Record<string, number>;
    Object.defineProperty(stock, sku_id, {
      configurable: true,
      enumerable: true,
      value: available_quantity,
      writable: true,
    });
    sales.advisor_stock = stock;
  }

  stockFor(context: HydratedContext, sku_id: string): number | undefined {
    const stock = context.run_state?.sales?.advisor_stock;
    if (!isRecord(stock) || !Object.prototype.hasOwnProperty.call(stock, sku_id)) return undefined;
    const quantity = stock[sku_id];
    return typeof quantity === 'number' && Number.isFinite(quantity) ? quantity : undefined;
  }

  /**
   * Records the one SKU the advisor's grounded read chain selected. The recommendation step reads it
   * back so the customer-visible product stays the SKU whose stock and owner-approved quote were
   * already verified in this same run; a later step never re-selects a different SKU.
   */
  recordCandidateSku(context: HydratedContext, sku_id: string): void {
    salesRunState(context).advisor_candidate_sku = sku_id;
  }

  candidateSkuFor(context: HydratedContext): string | undefined {
    const sku = context.run_state?.sales?.advisor_candidate_sku;
    return typeof sku === 'string' ? sku : undefined;
  }
}

/**
 * API-001.PricingEngine binding over the worker's already-authenticated ERP read connector.
 * It does not calculate a floor or substitute a local price; every value is copied from the SoR
 * response and malformed/unapproved responses become explicit refusals.
 */
export function createSalesErpPriceFloorPort(erp_read: ErpReadPort | null): SalesPriceFloorPort | null {
  if (erp_read === null) return null;
  return {
    async read(query): Promise<SalesPriceFloorDecision> {
      let result: ConnectorReadResult;
      try {
        result = await erp_read.read({ tenant_id: query.tenant_id, resource: 'prices', key: query.sku_id });
      } catch {
        return { ok: false, owner_approved: false, reason: 'API-001 price floor read failed' };
      }

      const value = result.value;
      if (!isRecord(value) || result.tenant_id !== query.tenant_id) {
        return { ok: false, owner_approved: false, reason: 'API-001 price floor response is not tenant-scoped' };
      }
      const sku = stringValue(value.sku_id);
      const currency = stringValue(value.currency);
      const floor_source = stringValue(value.floor_source) ?? stringValue(value.floor_price_source);
      const list_price = numberValue(value.list_price) ?? numberValue(value.original_list_price);
      const p_floor = numberValue(value.p_floor) ?? numberValue(value.floor_price);
      const quote_ttl_seconds = numberValue(value.quote_ttl_seconds);
      if (
        sku !== query.sku_id
        || value.tenant_id !== query.tenant_id
        || value.owner_approved !== true
        || currency === undefined
        || floor_source === undefined
        || list_price === undefined
        || p_floor === undefined
        || quote_ttl_seconds === undefined
        || list_price < 0
        || p_floor < 0
        || p_floor > list_price
        || quote_ttl_seconds <= 0
      ) {
        return { ok: false, owner_approved: false, reason: 'API-001 price floor is missing, invalid, or unapproved' };
      }
      return {
        ok: true,
        owner_approved: true,
        list_price,
        p_floor,
        currency,
        floor_source,
        quote_ttl_seconds,
      };
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
