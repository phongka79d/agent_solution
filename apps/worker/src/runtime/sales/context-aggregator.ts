/**
 * @file Sales Customer360 context hydration.
 *
 * `SignalSubject.verified_customer_id` is a gateway-resolved customer primary key, not an identity-row id.
 * The tenant-scoped Customer360 profile is fetched only for a well-formed trusted UUID; timeline reads
 * happen only after the returned profile confirms both tenant and customer binding.
 */

import type {
  Customer360Fact,
  HydratedContext,
  IContextAggregator,
  SignalSubject,
  WorkingMemoryContext,
} from '@agentos/core-engine/contracts';
import {
  getProfile as dbGetProfile,
  CustomerEventRepository,
  type CustomerProfileRow,
  type CustomerEventTimeline,
  type CustomerEventTimelineItem,
  type CustomerEventTimelineQuery,
} from '@agentos/database';
import type {
  SalesPurchaseEvidencePort,
  SalesPurchaseEvidenceQuery,
  VerifiedPurchaseEvidence,
} from './agent-runtime.js';
/**
 * Adapts a customer event timeline query function into a typed Sales purchase-evidence port.
 */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

function isValidIsoTimestamp(ts: unknown): ts is string {
  if (typeof ts !== 'string' || !ISO_TIMESTAMP.test(ts.trim())) return false;
  const ms = new Date(ts.trim()).getTime();
  return Number.isFinite(ms) && !isNaN(ms);
}

/**
 * Adapts a customer event timeline query function into a typed Sales purchase-evidence port.
 */
export function createCustomerEventPurchaseEvidencePort(
  listTimeline: (query: CustomerEventTimelineQuery) => Promise<CustomerEventTimeline>,
): SalesPurchaseEvidencePort {
  return {
    async read(query: SalesPurchaseEvidenceQuery): Promise<readonly VerifiedPurchaseEvidence[]> {
      const { tenant_id, customer_id } = query;
      const timeline = await listTimeline({ tenant_id, customer_id, limit: 100 });
      const items = Array.isArray(timeline.items) ? timeline.items : [];
      const purchases: VerifiedPurchaseEvidence[] = [];

      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        const payload = item.payload ?? {};
        const eventName = typeof item.event_name === 'string' ? item.event_name.toLowerCase().trim() : '';

        const rawOrderId =
          (typeof payload.order_id === 'string' && payload.order_id.trim().length > 0 ? payload.order_id.trim() : null) ??
          (typeof payload.purchase_id === 'string' && payload.purchase_id.trim().length > 0 ? payload.purchase_id.trim() : null) ??
          (typeof payload.order_reference === 'string' && payload.order_reference.trim().length > 0 ? payload.order_reference.trim() : null);

        const isPurchaseEventName =
          eventName === 'purchase' ||
          eventName === 'order_placed' ||
          eventName === 'order_created' ||
          eventName === 'order_completed' ||
          eventName === 'order' ||
          eventName.startsWith('order.') ||
          eventName.endsWith('.order') ||
          eventName.includes('purchase');

        const isPurchaseRow = isPurchaseEventName || rawOrderId !== null;
        if (!isPurchaseRow) {
          // Known non-purchase event (e.g. product_view, session, search, click) -> skip
          continue;
        }

        // Purchase-shaped row: must be well-formed; fail closed if malformed
        if (!rawOrderId) {
          throw new Error('purchase evidence missing or stale: purchase evidence missing');
        }

        const rawOrderDate =
          (typeof item.occurred_at === 'string' && item.occurred_at.trim().length > 0 ? item.occurred_at.trim() : null) ??
          (typeof payload.order_date === 'string' && payload.order_date.trim().length > 0 ? payload.order_date.trim() : null) ??
          (typeof payload.created_at === 'string' && payload.created_at.trim().length > 0 ? payload.created_at.trim() : null);

        if (!rawOrderDate || !isValidIsoTimestamp(rawOrderDate)) {
          throw new Error('purchase evidence missing or stale: purchase evidence missing');
        }

        const rawSkus = payload.sku_ids ?? payload.skus ?? payload.items ?? payload.sku_id ?? payload.sku;
        const itemsList: string[] = [];
        if (Array.isArray(rawSkus)) {
          for (const s of rawSkus) {
            if (typeof s === 'string' && s.trim().length > 0) itemsList.push(s.trim());
            else if (s && typeof s === 'object' && 'sku_id' in s && typeof s.sku_id === 'string') {
              itemsList.push(s.sku_id.trim());
            } else if (s && typeof s === 'object' && 'sku' in s && typeof s.sku === 'string') {
              itemsList.push(s.sku.trim());
            }
          }
        } else if (typeof rawSkus === 'string' && rawSkus.trim().length > 0) {
          itemsList.push(rawSkus.trim());
        }

        const quantity =
          typeof payload.quantity === 'number' && Number.isFinite(payload.quantity)
            ? payload.quantity
            : undefined;
        const totalAmount =
          typeof payload.total_amount === 'number' && Number.isFinite(payload.total_amount)
            ? payload.total_amount
            : (typeof payload.amount === 'number' && Number.isFinite(payload.amount) ? payload.amount : undefined);
        const currency =
          typeof payload.currency === 'string' && payload.currency.trim().length > 0
            ? payload.currency.trim()
            : undefined;

        purchases.push({
          order_id: rawOrderId,
          order_date: rawOrderDate,
          ...(itemsList.length > 0 ? { items: itemsList, sku_ids: itemsList } : {}),
          ...(quantity !== undefined ? { quantity } : {}),
          ...(totalAmount !== undefined ? { total_amount: totalAmount } : {}),
          ...(currency !== undefined ? { currency } : {}),
        });
      }

      if (purchases.length === 0) {
        throw new Error('purchase evidence missing or stale: purchase evidence missing');
      }

      return Object.freeze(purchases);
    },
  };
}
export interface SalesCustomerEventTimeline extends CustomerEventTimeline {
  readonly events: readonly CustomerEventTimelineItem[];
}

export interface SalesContextAggregatorRepositories {
  readonly getProfile?: (tenantId: string, customerId: string) => Promise<CustomerProfileRow | null>;
  readonly customerEventRepository?: CustomerEventRepository;
  readonly listTimeline?: (query: CustomerEventTimelineQuery) => Promise<CustomerEventTimeline>;
}
export interface SalesSessionControlPort {
  isTakenOver(tenant_id: string, session_id: string): Promise<boolean>;
}

export interface SalesContextAggregatorOptions {
  readonly repositories?: SalesContextAggregatorRepositories;
  readonly sessionControl?: SalesSessionControlPort;
  readonly now?: () => Date;
  readonly maxMemoryEntries?: number;
}

interface CachedCorrelationEntry {
  readonly tenant_id: string;
  readonly customer: Customer360Fact | null;
  readonly timeline: SalesCustomerEventTimeline | null;
  readonly takeover_active: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bounded insertion-ordered map used for recent hydrated correlation contexts. */
export class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly maxSize = 1000) {
    if (!Number.isSafeInteger(maxSize) || maxSize < 1) throw new RangeError('maxSize must be positive');
  }

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, value);
  }
}

export class SalesContextAggregator implements IContextAggregator {
  public readonly unbound: readonly string[];
  private readonly getProfile: (tenantId: string, customerId: string) => Promise<CustomerProfileRow | null>;
  private readonly listTimeline: (query: CustomerEventTimelineQuery) => Promise<CustomerEventTimeline>;
  private readonly sessionControl: SalesSessionControlPort | undefined;
  private readonly now: () => Date;
  private readonly cache: BoundedMap<string, CachedCorrelationEntry>;

  constructor(options: SalesContextAggregatorOptions = {}) {
    const repositories = options.repositories;
    this.getProfile = repositories?.getProfile ?? dbGetProfile;
    if (repositories?.listTimeline) this.listTimeline = repositories.listTimeline;
    else {
      const repository = repositories?.customerEventRepository ?? new CustomerEventRepository();
      this.listTimeline = (query) => repository.listTimeline(query);
    }
    this.sessionControl = options.sessionControl;
    this.now = options.now ?? (() => new Date());
    this.cache = new BoundedMap(options.maxMemoryEntries ?? 1000);

    if (!this.sessionControl) {
      this.unbound = Object.freeze([
        'sessionControl: no session-control takeover authority is bound; fail-closed takeover_active=true',
      ]);
    } else {
      this.unbound = Object.freeze([]);
    }
  }

  verifiedCustomerFor(tenant_id: string, correlation_id: string): Customer360Fact | null {
    const entry = this.cache.get(this.cacheKey(tenant_id, correlation_id));
    return entry?.tenant_id === tenant_id ? entry.customer : null;
  }

  verifiedTimelineFor(tenant_id: string, correlation_id: string): SalesCustomerEventTimeline | null {
    const entry = this.cache.get(this.cacheKey(tenant_id, correlation_id));
    return entry?.tenant_id === tenant_id ? entry.timeline : null;
  }

  takeoverActiveFor(tenant_id: string, correlation_id: string): boolean {
    const entry = this.cache.get(this.cacheKey(tenant_id, correlation_id));
    if (!entry || entry.tenant_id !== tenant_id) {
      return true;
    }
    return entry.takeover_active;
  }

  createPurchaseEvidencePort(): SalesPurchaseEvidencePort {
    return createCustomerEventPurchaseEvidencePort(this.listTimeline);
  }

  async hydrateContext(
    tenant_id: string,
    subject: SignalSubject,
    correlation_id: string,
  ): Promise<HydratedContext> {
    let customer: Customer360Fact | null = null;
    let timeline: SalesCustomerEventTimeline | null = null;
    const customer_id = subject.verified_customer_id;

    // A caller payload cannot set this server-resolved subject field. Reject malformed IDs before
    // any repository call; tenant-scoped profile lookup is the authoritative binding check.
    if (typeof customer_id === 'string' && UUID.test(customer_id)) {
      try {
        const profile = await this.getProfile(tenant_id, customer_id);
        if (profile?.tenant_id === tenant_id && profile.customer_id === customer_id) {
          customer = {
            customer_id: profile.customer_id,
            tenant_id: profile.tenant_id,
            verified_phone: profile.verified_phone ?? null,
            verified_email: profile.verified_email ?? null,
            total_spent: Number(profile.total_spent),
            order_count: profile.order_count,
            rfm_segment_hypothesis: profile.rfm_segment_hypothesis,
            consent_marketing: profile.consent_marketing,
            consent_updated_at: profile.consent_updated_at?.toISOString() ?? null,
            suppression_active: profile.suppression_active,
            created_at: profile.created_at.toISOString(),
          };

          try {
            const result = await this.listTimeline({ tenant_id, customer_id, limit: 100 });
            const items = Array.isArray(result.items) ? result.items : [];
            timeline = { items, events: items, next_cursor: result.next_cursor ?? null };
          } catch {
            timeline = null;
          }
        }
      } catch {
        // A failed or unavailable authoritative read does not produce partial customer context.
        customer = null;
        timeline = null;
      }
    }

    let takeover_active = true;
    if (this.sessionControl) {
      try {
        takeover_active = await this.sessionControl.isTakenOver(tenant_id, subject.session_id);
      } catch {
        takeover_active = true;
      }
    }

    this.cache.set(this.cacheKey(tenant_id, correlation_id), {
      tenant_id,
      customer,
      timeline,
      takeover_active,
    });
    const working_memory: WorkingMemoryContext = {
      session_id: subject.session_id,
      last_touch_channel: subject.channel_type,
      turn_count: 1,
      takeover_active,
    };

    return {
      correlation_id,
      tenant_id,
      customer,
      working_memory,
      knowledge_citations: [],
      hydrated_at: this.now().toISOString(),
    };
  }

  private cacheKey(tenant_id: string, correlation_id: string): string {
    return `${tenant_id}\u0000${correlation_id}`;
  }
}
