import type { ConnectorReadResult } from '@agentos/adapters';
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

interface AdvisorRunState {
  readonly requirements?: SalesAdvisorRequirements;
  readonly stock: Map<string, number>;
  candidate_sku?: string;
}

/**
 * Small run-scoped state seam shared by the plan builder and Sales read handlers.
 * It carries only server-stamped requirements and observations from earlier reads; it never
 * accepts caller/model-selected SKU, price, authority or tenant values.
 */
export class SalesAdvisorExecutionState {
  private readonly runs = new Map<string, AdvisorRunState>();

  setRequirements(tenant_id: string, correlation_id: string, requirements: SalesAdvisorRequirements): void {
    const key = this.key(tenant_id, correlation_id);
    const current = this.runs.get(key);
    this.runs.set(key, {
      requirements,
      stock: current?.stock ?? new Map<string, number>(),
    });
    this.prune();
  }

  requirementsFor(tenant_id: string, correlation_id: string): SalesAdvisorRequirements | undefined {
    return this.runs.get(this.key(tenant_id, correlation_id))?.requirements;
  }

  recordStock(tenant_id: string, correlation_id: string, sku_id: string, available_quantity: number): void {
    const key = this.key(tenant_id, correlation_id);
    const current = this.runs.get(key) ?? { stock: new Map<string, number>() };
    current.stock.set(sku_id, available_quantity);
    this.runs.set(key, current);
    this.prune();
  }

  stockFor(tenant_id: string, correlation_id: string, sku_id: string): number | undefined {
    return this.runs.get(this.key(tenant_id, correlation_id))?.stock.get(sku_id);
  }

  /**
   * Records the one SKU the advisor's grounded read chain selected. The recommendation step reads it
   * back so the customer-visible product stays the SKU whose stock and owner-approved quote were
   * already verified in this same run; a later step never re-selects a different SKU.
   */
  recordCandidateSku(tenant_id: string, correlation_id: string, sku_id: string): void {
    const key = this.key(tenant_id, correlation_id);
    const current = this.runs.get(key) ?? { stock: new Map<string, number>() };
    current.candidate_sku = sku_id;
    this.runs.set(key, current);
    this.prune();
  }

  candidateSkuFor(tenant_id: string, correlation_id: string): string | undefined {
    return this.runs.get(this.key(tenant_id, correlation_id))?.candidate_sku;
  }

  private key(tenant_id: string, correlation_id: string): string {
    return `${tenant_id}\u0000${correlation_id}`;
  }

  private prune(): void {
    if (this.runs.size <= 256) return;
    const oldest = this.runs.keys().next().value;
    if (typeof oldest === 'string') this.runs.delete(oldest);
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
