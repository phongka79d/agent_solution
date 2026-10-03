/**
 * @file Care Context Aggregator (implement/04 §3.2, implement/06 §8.1).
 *
 * Only the gateway-stamped `verified_customer_id`, confirmed by a tenant-scoped
 * customer profile, links a subject to Customer 360. Channel handles never infer
 * identity; an absent verified ID stays anonymous even when a handle has an
 * identity row.
 *
 * Working memory is hydrated directly from the durable conversation state
 * (`agentos.conversations`), where `state === 'paused_takeover'` provides the
 * authoritative takeover flag that survives worker restarts.
 */

import type {
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
import { resolveSubject } from '../shared/subject-resolver.js';

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
}


export class CareContextAggregator implements IContextAggregator {
  private readonly findIdentityFn: (tenantId: string, channelType: string, channelIdentifier: string) => Promise<CustomerIdentityRow | null>;
  private readonly getProfileFn: (tenantId: string, customerId: string) => Promise<CustomerProfileRow | null>;
  private readonly getConversationFn: (tenantId: string, conversationId: string) => Promise<ConversationRecord | null>;
  private readonly listMessagesFn?: (scope: ConversationMessageScope) => Promise<readonly ConversationMessageRecord[]>;
  private readonly now: () => Date;

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
  }

  /** Verified identity row id bound during CONTEXT hydration; read it from checkpoint context. */
  verificationReferenceFor(context: HydratedContext): string | null {
    return context.run_state?.care?.verification_reference ?? null;
  }

  async hydrateContext(
    tenant_id: string,
    subject: SignalSubject,
    correlation_id: string,
  ): Promise<HydratedContext> {
    const resolved = await resolveSubject(tenant_id, subject, {
      getProfile: this.getProfileFn,
      getConversation: this.getConversationFn,
    });
    const customer = resolved.customer;
    let verifiedIdentityId: string | null = null;
    if (customer !== null && subject.channel_type && subject.channel_identifier) {
      try {
        const identity = await this.findIdentityFn(tenant_id, subject.channel_type, subject.channel_identifier);
        if (
          identity !== null
          && identity.verified_at !== null
          && identity.customer_id === customer.customer_id
        ) {
          verifiedIdentityId = identity.id;
        }
      } catch {
        // The gateway-verified customer remains authoritative; identity-row lookup only supplies
        // the legacy reference used by downstream Care checks.
      }
    }

    let turn_count = 1;
    const conversation = resolved.conversation;
    const conversation_id = conversation?.conversation_id;
    const takeover_active = conversation?.state === 'paused_takeover';

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
      run_state: { care: { verification_reference: verifiedIdentityId } },
    };
  }
}

