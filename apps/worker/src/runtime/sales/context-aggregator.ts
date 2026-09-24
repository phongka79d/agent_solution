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

export interface SalesCustomerEventTimeline extends CustomerEventTimeline {
  readonly events: readonly CustomerEventTimelineItem[];
}

export interface SalesContextAggregatorRepositories {
  readonly getProfile?: (tenantId: string, customerId: string) => Promise<CustomerProfileRow | null>;
  readonly customerEventRepository?: CustomerEventRepository;
  readonly listTimeline?: (query: CustomerEventTimelineQuery) => Promise<CustomerEventTimeline>;
}

export interface SalesContextAggregatorOptions {
  readonly repositories?: SalesContextAggregatorRepositories;
  readonly now?: () => Date;
  readonly maxMemoryEntries?: number;
}

interface CachedCorrelationEntry {
  readonly tenant_id: string;
  readonly customer: Customer360Fact | null;
  readonly timeline: SalesCustomerEventTimeline | null;
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
  private readonly getProfile: (tenantId: string, customerId: string) => Promise<CustomerProfileRow | null>;
  private readonly listTimeline: (query: CustomerEventTimelineQuery) => Promise<CustomerEventTimeline>;
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
    this.now = options.now ?? (() => new Date());
    this.cache = new BoundedMap(options.maxMemoryEntries ?? 1000);
  }

  verifiedCustomerFor(tenant_id: string, correlation_id: string): Customer360Fact | null {
    const entry = this.cache.get(this.cacheKey(tenant_id, correlation_id));
    return entry?.tenant_id === tenant_id ? entry.customer : null;
  }

  verifiedTimelineFor(tenant_id: string, correlation_id: string): SalesCustomerEventTimeline | null {
    const entry = this.cache.get(this.cacheKey(tenant_id, correlation_id));
    return entry?.tenant_id === tenant_id ? entry.timeline : null;
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

    this.cache.set(this.cacheKey(tenant_id, correlation_id), { tenant_id, customer, timeline });
    const working_memory: WorkingMemoryContext = {
      session_id: subject.session_id,
      last_touch_channel: subject.channel_type,
      turn_count: 1,
      takeover_active: false,
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
