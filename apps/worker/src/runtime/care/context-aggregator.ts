/**
 * @file Care Context Aggregator (implement/04 §3.2, implement/06 §8.1).
 *
 * Invariant:
 * Only server-verified identity bindings (`verified_at != null`) link a channel
 * conversation to a Customer 360 profile. Unverified handles, absent identities,
 * or customer assertions inside message payloads are strictly ignored, leaving
 * `customer = null` (anonymous session).
 *
 * Working memory is hydrated directly from the durable conversation state
 * (`agentos.conversations`), where `state === 'paused_takeover'` provides the
 * authoritative takeover flag that survives worker restarts.
 */

import type {
  Customer360Fact,
  HydratedContext,
  IContextAggregator,
  SignalSubject,
  WorkingMemoryContext,
} from '@agentos/core-engine/contracts';
import {
  findIdentity as dbFindIdentity,
  getProfile as dbGetProfile,
  ConversationRepository,
  type CustomerIdentityRow,
  type CustomerProfileRow,
  type ConversationRecord,
  type ConversationMessageRecord,
  type ConversationMessageScope,
} from '@agentos/database';

export interface CareContextAggregatorRepositories {
  readonly findIdentity?: ((tenantId: string, channelType: string, channelIdentifier: string) => Promise<CustomerIdentityRow | null>) | undefined;
  readonly getProfile?: ((tenantId: string, customerId: string) => Promise<CustomerProfileRow | null>) | undefined;
  readonly conversationRepository?: ConversationRepository | undefined;
  readonly getConversation?: ((tenantId: string, conversationId: string) => Promise<ConversationRecord | null>) | undefined;
  readonly listMessages?: ((scope: ConversationMessageScope) => Promise<readonly ConversationMessageRecord[]>) | undefined;
}

export interface CareContextAggregatorOptions {
  readonly repositories?: CareContextAggregatorRepositories | undefined;
  readonly now?: (() => Date) | undefined;
  readonly maxMemoryEntries?: number | undefined;
}

/**
 * Bounded Map eviction helper to prevent memory leaks while keeping recent verification references.
 */
class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly maxSize: number = 1000) {}

  get(key: K): V | undefined {
    return this.map.get(key);
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) {
        this.map.delete(oldest);
      }
    }
    this.map.set(key, value);
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

export class CareContextAggregator implements IContextAggregator {
  private readonly findIdentityFn: (tenantId: string, channelType: string, channelIdentifier: string) => Promise<CustomerIdentityRow | null>;
  private readonly getProfileFn: (tenantId: string, customerId: string) => Promise<CustomerProfileRow | null>;
  private readonly getConversationFn: (tenantId: string, conversationId: string) => Promise<ConversationRecord | null>;
  private readonly listMessagesFn?: (scope: ConversationMessageScope) => Promise<readonly ConversationMessageRecord[]>;
  private readonly now: () => Date;
  private readonly verificationReferences: BoundedMap<string, string | null>;

  constructor(options: CareContextAggregatorOptions = {}) {
    const repos = options.repositories;
    this.findIdentityFn = repos?.findIdentity ?? dbFindIdentity;
    this.getProfileFn = repos?.getProfile ?? dbGetProfile;

    if (repos?.getConversation) {
      this.getConversationFn = repos.getConversation;
    } else if (repos?.conversationRepository) {
      const cr = repos.conversationRepository;
      this.getConversationFn = (t, c) => cr.get(t, c);
    } else {
      const defaultConvRepo = new ConversationRepository();
      this.getConversationFn = (t, c) => defaultConvRepo.get(t, c);
    }

    if (repos?.listMessages) {
      this.listMessagesFn = repos.listMessages;
    } else if (repos?.conversationRepository) {
      const cr = repos.conversationRepository;
      this.listMessagesFn = (s) => cr.listMessages(s);
    } else {
      const defaultConvRepo = new ConversationRepository();
      this.listMessagesFn = (s) => defaultConvRepo.listMessages(s);
    }

    this.now = options.now ?? (() => new Date());
    this.verificationReferences = new BoundedMap<string, string | null>(options.maxMemoryEntries ?? 1000);
    this.verificationReferenceFor = Object.freeze(this.verificationReferenceFor.bind(this));
  }

  /** id of the verified customer_identities row resolved during hydrateContext, keyed by correlation_id; null when the session is unverified. */
  verificationReferenceFor(correlation_id: string): string | null {
    return this.verificationReferences.get(correlation_id) ?? null;
  }

  async hydrateContext(
    tenant_id: string,
    subject: SignalSubject,
    correlation_id: string,
  ): Promise<HydratedContext> {
    let customer: Customer360Fact | null = null;
    let verifiedIdentityId: string | null = null;

    if (subject.channel_type && subject.channel_identifier) {
      try {
        const identity = await this.findIdentityFn(tenant_id, subject.channel_type, subject.channel_identifier);
        if (identity && identity.verified_at != null && identity.customer_id) {
          verifiedIdentityId = identity.id;
          const profile = await this.getProfileFn(tenant_id, identity.customer_id);
          if (profile) {
            customer = {
              customer_id: profile.customer_id,
              tenant_id: profile.tenant_id,
              verified_phone: profile.verified_phone ?? null,
              verified_email: profile.verified_email ?? null,
              total_spent: Number(profile.total_spent ?? 0),
              order_count: Number(profile.order_count ?? 0),
              rfm_segment_hypothesis: profile.rfm_segment_hypothesis ?? 'UNKNOWN',
              consent_marketing: Boolean(profile.consent_marketing),
              consent_updated_at: profile.consent_updated_at instanceof Date
                ? profile.consent_updated_at.toISOString()
                : (profile.consent_updated_at ? String(profile.consent_updated_at) : null),
              suppression_active: Boolean(profile.suppression_active),
              created_at: profile.created_at instanceof Date
                ? profile.created_at.toISOString()
                : (profile.created_at ? String(profile.created_at) : this.now().toISOString()),
            };
          }
        }
      } catch {
        // On query failure, fail closed to anonymous customer
        customer = null;
        verifiedIdentityId = null;
      }
    }

    this.verificationReferences.set(correlation_id, verifiedIdentityId);

    let turn_count = 1;
    let takeover_active = false;
    let conversation_id: string | undefined;

    if (subject.conversation_id && subject.channel_identifier) {
      try {
        const conversation = await this.getConversationFn(tenant_id, subject.conversation_id);
        if (
          conversation !== null &&
          conversation.tenant_id === tenant_id &&
          conversation.conversation_id === subject.conversation_id &&
          conversation.channel === subject.channel_type &&
          conversation.external_thread_id === subject.channel_identifier
        ) {
          conversation_id = conversation.conversation_id;
          takeover_active = conversation.state === 'paused_takeover';
        }
      } catch {
        // Without a verified persisted binding, no conversation history or handoff identity is exposed.
      }
    }

    if (conversation_id !== undefined && this.listMessagesFn) {
      try {
        const messages = await this.listMessagesFn({
          tenant_id,
          conversation_id,
          limit: 100,
        });
        if (Array.isArray(messages) && messages.length > 0) {
          turn_count = messages.length;
        }
      } catch {
        turn_count = 1;
      }
    }

    const working_memory: WorkingMemoryContext = {
      session_id: subject.session_id,
      ...(conversation_id === undefined ? {} : { conversation_id }),
      last_touch_channel: subject.channel_type,
      turn_count,
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
}
