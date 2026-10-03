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
  ConversationRepository,
  CustomerEventRepository,
  type ConversationRecord,
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
import { resolveSubject } from '../shared/subject-resolver.js';
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
  readonly getConversation?: (tenantId: string, conversationId: string) => Promise<ConversationRecord | null>;
  readonly conversationRepository?: ConversationRepository;
  readonly customerEventRepository?: CustomerEventRepository;
  readonly listTimeline?: (query: CustomerEventTimelineQuery) => Promise<CustomerEventTimeline>;
}
export interface SalesSessionControlPort {
  isTakenOver(tenant_id: string, session_id: string): Promise<boolean>;
}
function isSalesCustomerEventTimeline(value: unknown): value is SalesCustomerEventTimeline {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<SalesCustomerEventTimeline>;
  return Array.isArray(candidate.items)
    && Array.isArray(candidate.events)
    && (candidate.next_cursor === null || typeof candidate.next_cursor === 'string');
}

export interface SalesContextAggregatorOptions {
  readonly repositories?: SalesContextAggregatorRepositories;
  readonly sessionControl?: SalesSessionControlPort;
  readonly now?: () => Date;
}


export class SalesContextAggregator implements IContextAggregator {
  public readonly unbound: readonly string[];
  private readonly getProfile: (tenantId: string, customerId: string) => Promise<CustomerProfileRow | null>;
  private readonly listTimeline: (query: CustomerEventTimelineQuery) => Promise<CustomerEventTimeline>;
  private readonly getConversation: (tenantId: string, conversationId: string) => Promise<ConversationRecord | null>;
  private readonly sessionControl: SalesSessionControlPort | undefined;
  private readonly now: () => Date;

  constructor(options: SalesContextAggregatorOptions = {}) {
    const repositories = options.repositories;
    this.getProfile = repositories?.getProfile ?? dbGetProfile;
    if (repositories?.getConversation) this.getConversation = repositories.getConversation;
    else {
      const conversationRepository = repositories?.conversationRepository ?? new ConversationRepository();
      this.getConversation = (tenantId, conversationId) => conversationRepository.get(tenantId, conversationId);
    }
    if (repositories?.listTimeline) this.listTimeline = repositories.listTimeline;
    else {
      const repository = repositories?.customerEventRepository ?? new CustomerEventRepository();
      this.listTimeline = (query) => repository.listTimeline(query);
    }
    this.sessionControl = options.sessionControl;
    this.now = options.now ?? (() => new Date());

    if (!this.sessionControl) {
      this.unbound = Object.freeze([
        'sessionControl: no session-control takeover authority is bound; fail-closed takeover_active=true',
      ]);
    } else {
      this.unbound = Object.freeze([]);
    }
  }

  verifiedCustomerFor(context: HydratedContext): Customer360Fact | null {
    return context.customer?.tenant_id === context.tenant_id ? context.customer : null;
  }

  verifiedTimelineFor(context: HydratedContext): SalesCustomerEventTimeline | null {
    const timeline = context.run_state?.sales?.timeline;
    return isSalesCustomerEventTimeline(timeline) ? timeline : null;
  }

  takeoverActiveFor(context: HydratedContext): boolean {
    return context.working_memory.takeover_active;
  }

  createPurchaseEvidencePort(): SalesPurchaseEvidencePort {
    return createCustomerEventPurchaseEvidencePort(this.listTimeline);
  }

  async hydrateContext(
    tenant_id: string,
    subject: SignalSubject,
    correlation_id: string,
  ): Promise<HydratedContext> {
    const resolved = await resolveSubject(tenant_id, subject, {
      getProfile: this.getProfile,
      getConversation: this.getConversation,
    });
    const customer = resolved.customer;
    let timeline: SalesCustomerEventTimeline | null = null;

    if (customer !== null) {
      try {
        const result = await this.listTimeline({
          tenant_id,
          customer_id: customer.customer_id,
          limit: 100,
        });
        const items = Array.isArray(result.items) ? result.items : [];
        timeline = { items, events: items, next_cursor: result.next_cursor ?? null };
      } catch {
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

    const working_memory: WorkingMemoryContext = {
      session_id: subject.session_id,
      ...(resolved.conversation === null ? {} : { conversation_id: resolved.conversation.conversation_id }),
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
      run_state: {
        sales: {
          timeline,
          ...(resolved.default_shipping_address === undefined
            ? {}
            : { default_shipping_address: resolved.default_shipping_address }),
        },
      },
    };
  }
}

