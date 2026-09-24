import type { Customer360Fact } from '@agentos/core-engine/contracts';
import type { CustomerEventTimeline } from '@agentos/database';
import type { ConnectorReadResult } from '@agentos/adapters';

import type { ErpReadPort } from '../connectors.js';
import {
  createSalesSkillServices,
  type SalesContextAggregatorLike,
  type SalesRecommendationRevenueEvidence,
  type SalesRecommendationRevenueEvidencePort,
  type SalesSkillOptions,
  type SalesSkillServices,
} from './skills/index.js';

/**
 * Sales-owned synthetic input for the offline PILOT-02 harness. It is intentionally separate from
 * generated testcases/fixtures output; canonical fixture updates do not silently alter this seam.
 *
 * Canonical inputs are testcases/sources/platform.py and testcases/sources/business.py; generated
 * testcases/fixtures/** are not loaded here. Changes to either fixture set require reviewing this seam.
 */
export interface SalesOfflineFixture {
  readonly tenant_id: string;
  readonly correlation_id: string;
  /** Provider-observed timestamp copied into both ERP read envelopes. */
  readonly observed_at: string;
  readonly catalog: readonly SalesOfflineCatalogItem[];
  readonly inventory: readonly SalesOfflineInventoryItem[];
  readonly customer: Customer360Fact | null;
  readonly timeline: CustomerEventTimeline | null;
  /** Null means the owner-approved revenue evidence source is intentionally absent. */
  readonly revenue_evidence: SalesRecommendationRevenueEvidence | null;
}

export interface SalesOfflineCatalogItem {
  readonly tenant_id: string;
  readonly product_id: string;
  readonly sku: string;
  readonly name: string;
  readonly currency: string;
  readonly original_list_price: number;
  readonly is_active: boolean;
  readonly categories?: readonly string[];
}

export interface SalesOfflineInventoryItem {
  readonly tenant_id: string;
  readonly sku_id: string;
  readonly total_available_to_promise: number;
}

export interface SalesOfflineReadInput {
  readonly tenant_id: string;
  readonly resource: string;
  readonly key?: string;
}

export interface SalesOfflineSkillServiceOverrides {
  readonly resolve_correlation_id?: SalesSkillOptions['resolve_correlation_id'];
  readonly resolve_grant?: SalesSkillOptions['resolve_grant'];
}

export interface SalesOfflineHarnessOptions {
  readonly fixture?: SalesOfflineFixture;
  /** False simulates an unbound API-001 read capability; it never creates a fallback source. */
  readonly erp_available?: boolean;
  /** False simulates an unbound owner-approved recommendation evidence source. */
  readonly revenue_evidence_available?: boolean;
}

export type SalesOfflineRefusalCode =
  | 'AUTHORITATIVE_SOURCE_UNAVAILABLE'
  | 'P_FLOOR_UNAVAILABLE'
  | 'SKILL_DISABLED'
  | 'UNKNOWN_CAPABILITY';

export class SalesOfflineHarnessError extends Error {
  readonly code: SalesOfflineRefusalCode;

  constructor(code: SalesOfflineRefusalCode, message: string) {
    super(message);
    this.name = 'SalesOfflineHarnessError';
    this.code = code;
  }
}

/** P2 rows are present in the registry contract but must not be autonomously enabled. */
export const SALES_P2_DISABLED_SKILLS: readonly string[] = Object.freeze([
  'skill.sales.check_price',
  'skill.sales.create_cart',
  'skill.sales.create_order',
  'skill.sales.send_message',
]);

const PILOT_TENANT_ID = '11111111-1111-1111-1111-111111111111';
const PILOT_CUSTOMER_ID = 'cust-a';
const PILOT_CORRELATION_ID = 'pilot-02-correlation';
const PILOT_OBSERVED_AT = '2026-01-15T10:00:00.000Z';

/**
 * Sales-owned synthetic PILOT-02 harness fixture. It mirrors only the read-only subset needed by
 * this harness; it is not the generated acceptance fixture and does not claim PILOT-02 execution or
 * pass status.
 *
 * It deliberately contains no P_floor value or floor ownership claim; a price path must remain
 * unavailable until an owner-approved provenance decision exists.
 */
export const PILOT_02_OFFLINE_FIXTURE: SalesOfflineFixture = Object.freeze({
  tenant_id: PILOT_TENANT_ID,
  correlation_id: PILOT_CORRELATION_ID,
  observed_at: PILOT_OBSERVED_AT,
  catalog: [{
    tenant_id: PILOT_TENANT_ID,
    product_id: 'prod-mug',
    sku: 'SKU-OK',
    name: 'Aurora Ceramic Mug 350ml',
    currency: 'TWD',
    original_list_price: 1000,
    is_active: true,
    categories: ['mugs', 'drinkware'],
  }],
  inventory: [{
    tenant_id: PILOT_TENANT_ID,
    sku_id: 'SKU-OK',
    total_available_to_promise: 12,
  }],
  customer: {
    customer_id: PILOT_CUSTOMER_ID,
    tenant_id: PILOT_TENANT_ID,
    verified_phone: null,
    verified_email: null,
    total_spent: 1000,
    order_count: 1,
    rfm_segment_hypothesis: 'LOYAL',
    consent_marketing: true,
    consent_updated_at: PILOT_OBSERVED_AT,
    suppression_active: false,
    created_at: PILOT_OBSERVED_AT,
  },
  timeline: {
    items: [{
      event_id: 'event-pilot-02-product-view',
      source_event_id: 'web:pilot-02-product-view',
      event_name: 'product_view',
      session_id: 'sess-a-1',
      channel: 'web',
      occurred_at: '2026-01-15T09:55:00.000Z',
      payload: { category: 'drinkware', sku: 'SKU-OK' },
    }],
    next_cursor: null,
  },
  revenue_evidence: {
    conversion_probability: 0.7,
    expected_revenue: 700,
    currency: 'TWD',
    model_id: 'pilot-02-owner-model',
    provenance_reference: 'pilot-02:approved-revenue-model',
  },
});

function isValidIsoDate(value: string): boolean {
  return value.trim().length > 0 && !Number.isNaN(new Date(value).getTime());
}

function validateFixture(fixture: SalesOfflineFixture): void {
  if (fixture.tenant_id.trim().length === 0 || fixture.correlation_id.trim().length === 0) {
    throw new TypeError('Sales offline fixture requires tenant_id and correlation_id');
  }
  if (!isValidIsoDate(fixture.observed_at)) {
    throw new TypeError('Sales offline fixture observed_at must be a provider timestamp');
  }

  for (const product of fixture.catalog) {
    if (
      product.tenant_id !== fixture.tenant_id
      || product.sku.trim().length === 0
      || product.name.trim().length === 0
      || product.currency.trim().length === 0
      || !Number.isFinite(product.original_list_price)
      || product.original_list_price < 0
    ) {
      throw new TypeError('Sales offline catalog fixture is invalid or crosses tenant scope');
    }
  }

  for (const item of fixture.inventory) {
    if (
      item.tenant_id !== fixture.tenant_id
      || item.sku_id.trim().length === 0
      || !Number.isSafeInteger(item.total_available_to_promise)
      || item.total_available_to_promise < 0
    ) {
      throw new TypeError('Sales offline inventory fixture is invalid or crosses tenant scope');
    }
  }

  if (fixture.customer !== null && fixture.customer.tenant_id !== fixture.tenant_id) {
    throw new TypeError('Sales offline Customer360 fixture crosses tenant scope');
  }
  for (const event of fixture.timeline?.items ?? []) {
    if (event.event_id.trim().length === 0 || !isValidIsoDate(event.occurred_at)) {
      throw new TypeError('Sales offline Customer360 timeline contains an invalid event');
    }
  }
}

/**
 * Read-only adapter and composition harness for the synthetic PILOT-02 path.
 * It implements only the existing Sales read/context/evidence seams; there is no mutation method.
 */
export class SalesOfflineHarness {
  readonly fixture: SalesOfflineFixture;
  readonly erp_read: ErpReadPort | null;
  readonly context: Pick<SalesContextAggregatorLike, 'verifiedCustomerFor' | 'verifiedTimelineFor'>;
  readonly revenue_evidence: SalesRecommendationRevenueEvidencePort | undefined;
  /** No effect-capable adapter is bound by this harness; this remains empty by construction. */
  readonly effect_dispatches: readonly { readonly skill_id: string }[] = [];

  private readonly readCalls: SalesOfflineReadInput[] = [];

  constructor(options: SalesOfflineHarnessOptions = {}) {
    this.fixture = options.fixture ?? PILOT_02_OFFLINE_FIXTURE;
    validateFixture(this.fixture);

    this.erp_read = options.erp_available === false
      ? null
      : { read: (input) => this.read(input) };

    this.context = {
      verifiedCustomerFor: (tenant_id, correlation_id) => this.customerFor(tenant_id, correlation_id),
      verifiedTimelineFor: (tenant_id, correlation_id) => this.timelineFor(tenant_id, correlation_id),
    };

    if (options.revenue_evidence_available === false || this.fixture.revenue_evidence === null) {
      this.revenue_evidence = undefined;
    } else {
      this.revenue_evidence = { read: (input) => this.readRevenueEvidence(input) };
    }
  }

  get read_calls(): readonly SalesOfflineReadInput[] {
    return this.readCalls;
  }

  /** Compose the real Sales skill registry/engine over this fixture's read-only seams. */
  createSkillServices(overrides: SalesOfflineSkillServiceOverrides = {}): SalesSkillServices {
    const resolve_correlation_id = overrides.resolve_correlation_id ?? (async (tenant_id: string, _run_id: string) => {
      if (tenant_id !== this.fixture.tenant_id) {
        throw new SalesOfflineHarnessError(
          'AUTHORITATIVE_SOURCE_UNAVAILABLE',
          'Sales offline correlation lookup crossed tenant scope',
        );
      }
      return this.fixture.correlation_id;
    });
    const resolve_grant = overrides.resolve_grant ?? (async (tenant_id: string, _agent_id: string) => {
      if (tenant_id !== this.fixture.tenant_id) {
        throw new SalesOfflineHarnessError(
          'AUTHORITATIVE_SOURCE_UNAVAILABLE',
          'Sales offline authority lookup crossed tenant scope',
        );
      }
      return 'AUTH-1' as const;
    });

    const skillOptions: SalesSkillOptions = {
      erp_read: this.erp_read,
      context: this.context,
      resolve_correlation_id,
      resolve_grant,
      ...(this.revenue_evidence === undefined ? {} : { revenue_evidence: this.revenue_evidence }),
    };
    return createSalesSkillServices(skillOptions);
  }

  /** Missing owner-approved floor provenance is a first-class refusal; no P_floor is derived. */
  probeMissingFloorProvenance(): never {
    throw new SalesOfflineHarnessError(
      'P_FLOOR_UNAVAILABLE',
      'No owner-approved floor provenance is bound; the offline harness never derives P_floor',
    );
  }

  /** Probes a registered-but-disabled price or mutation row without dispatching it. */
  probeDisabledSkill(skill_id: string): never {
    if (!SALES_P2_DISABLED_SKILLS.includes(skill_id)) {
      throw new SalesOfflineHarnessError(
        'UNKNOWN_CAPABILITY',
        `Sales offline harness has no refusal probe for ${skill_id}`,
      );
    }
    throw new SalesOfflineHarnessError(
      'SKILL_DISABLED',
      `${skill_id} is prepared for a later gate but disabled in the P2 foundation`,
    );
  }

  private async read(input: SalesOfflineReadInput): Promise<ConnectorReadResult> {
    this.readCalls.push(input.key === undefined ? { tenant_id: input.tenant_id, resource: input.resource } : { ...input });
    if (input.tenant_id !== this.fixture.tenant_id) {
      throw new SalesOfflineHarnessError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Sales offline ERP read crossed tenant scope',
      );
    }

    const envelope = {
      tenant_id: this.fixture.tenant_id,
      snapshot_at: this.fixture.observed_at,
    };
    if (input.resource === 'products') {
      return {
        resource: input.resource,
        tenant_id: this.fixture.tenant_id,
        observed_at: this.fixture.observed_at,
        value: {
          ...envelope,
          items: this.fixture.catalog.map((product) => ({ ...product })),
        },
      };
    }

    if (input.resource === 'inventory' && input.key !== undefined && input.key.trim().length > 0) {
      const item = this.fixture.inventory.find((candidate) => candidate.sku_id === input.key);
      if (item === undefined) {
        throw new SalesOfflineHarnessError(
          'AUTHORITATIVE_SOURCE_UNAVAILABLE',
          'Sales offline ERP inventory has no tenant-scoped record for the requested SKU',
        );
      }
      return {
        resource: input.resource,
        tenant_id: this.fixture.tenant_id,
        observed_at: this.fixture.observed_at,
        value: {
          ...envelope,
          items: [{ ...item }],
        },
      };
    }

    throw new SalesOfflineHarnessError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      `Sales offline ERP resource '${input.resource}' is unavailable`,
    );
  }

  private customerFor(tenant_id: string, correlation_id: string): Customer360Fact | null {
    if (
      tenant_id !== this.fixture.tenant_id
      || correlation_id !== this.fixture.correlation_id
      || this.fixture.customer === null
      || this.fixture.customer.tenant_id !== tenant_id
    ) {
      return null;
    }
    return this.fixture.customer;
  }

  private timelineFor(tenant_id: string, correlation_id: string): CustomerEventTimeline | null {
    if (this.customerFor(tenant_id, correlation_id) === null) return null;
    return this.fixture.timeline;
  }

  private async readRevenueEvidence(input: Parameters<SalesRecommendationRevenueEvidencePort['read']>[0]): Promise<SalesRecommendationRevenueEvidence> {
    if (
      this.fixture.revenue_evidence === null
      || input.tenant_id !== this.fixture.tenant_id
      || this.fixture.customer?.customer_id !== input.customer_id
      || !this.fixture.catalog.some((product) => product.sku === input.sku)
    ) {
      throw new SalesOfflineHarnessError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Sales offline owner-approved revenue evidence is unavailable for this scope',
      );
    }
    return this.fixture.revenue_evidence;
  }
}

export function createSalesOfflineHarness(options: SalesOfflineHarnessOptions = {}): SalesOfflineHarness {
  return new SalesOfflineHarness(options);
}
