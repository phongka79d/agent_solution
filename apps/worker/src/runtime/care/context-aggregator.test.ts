import { describe, expect, it } from 'vitest';
import type { SignalSubject } from '@agentos/core-engine/contracts';
import type {
  ConversationMessageRecord,
  ConversationRecord,
  CustomerIdentityRow,
  CustomerProfileRow,
} from '@agentos/database';

import { CareContextAggregator } from './context-aggregator.js';

describe('CareContextAggregator', () => {
  const tenant_id = '00000000-0000-4000-8000-000000000001';
  const correlation_id = 'corr-123';

  it('attaches customer profile ONLY on server-verified identity binding', async () => {
    const verifiedIdentity: CustomerIdentityRow = {
      id: 'ident-1',
      tenant_id,
      customer_id: 'cust-100',
      channel_type: 'web',
      channel_identifier: 'session-user-1',
      identifier_hash: 'hash-1',
      is_primary: true,
      verified_at: new Date('2026-09-01T00:00:00Z'),
      created_at: new Date('2026-09-01T00:00:00Z'),
    };

    const customerProfile: CustomerProfileRow = {
      customer_id: 'cust-100',
      tenant_id,
      verified_phone: '+1234567890',
      verified_email: 'user@example.com',
      total_spent: '150.50',
      order_count: 3,
      rfm_segment_hypothesis: 'CHAMPION',
      consent_marketing: true,
      consent_updated_at: new Date('2026-09-01T00:00:00Z'),
      suppression_active: false,
      line_user_id: null,
      created_at: new Date('2026-09-01T00:00:00Z'),
    };

    const aggregator = new CareContextAggregator({
      repositories: {
        findIdentity: async () => verifiedIdentity,
        getProfile: async () => customerProfile,
        getConversation: async () => null,
      },
    });

    const subject: SignalSubject = {
      session_id: 'sess-1',
      channel_type: 'web',
      channel_identifier: 'session-user-1',
    };

    const context = await aggregator.hydrateContext(tenant_id, subject, correlation_id);

    expect(context.customer).not.toBeNull();
    expect(context.customer?.customer_id).toBe('cust-100');
    expect(context.customer?.total_spent).toBe(150.50);
    expect(context.customer?.order_count).toBe(3);
    expect(context.customer?.rfm_segment_hypothesis).toBe('CHAMPION');
    expect(context.customer?.consent_marketing).toBe(true);

    // verificationReferenceFor returns the verified identity row id
    expect(aggregator.verificationReferenceFor(correlation_id)).toBe('ident-1');
  });

  it('leaves customer = null when identity is unverified or missing', async () => {
    const unverifiedIdentity: CustomerIdentityRow = {
      id: 'ident-2',
      tenant_id,
      customer_id: 'cust-200',
      channel_type: 'web',
      channel_identifier: 'anon-user',
      identifier_hash: 'hash-2',
      is_primary: false,
      verified_at: null,
      created_at: new Date('2026-09-01T00:00:00Z'),
    };

    const aggregator = new CareContextAggregator({
      repositories: {
        findIdentity: async () => unverifiedIdentity,
        getProfile: async () => null,
        getConversation: async () => null,
      },
    });

    const subject: SignalSubject = {
      session_id: 'sess-2',
      channel_type: 'web',
      channel_identifier: 'anon-user',
    };

    const context = await aggregator.hydrateContext(tenant_id, subject, correlation_id);

    expect(context.customer).toBeNull();
    // verificationReferenceFor returns null for unverified session
    expect(aggregator.verificationReferenceFor(correlation_id)).toBeNull();
  });

  it('verificationReferenceFor returns null when identity lookup fails or throws', async () => {
    const aggregator = new CareContextAggregator({
      repositories: {
        findIdentity: async () => {
          throw new Error('Database connection failed');
        },
        getProfile: async () => null,
        getConversation: async () => null,
      },
    });

    const subject: SignalSubject = {
      session_id: 'sess-err',
      channel_type: 'web',
      channel_identifier: 'err-user',
    };

    const context = await aggregator.hydrateContext(tenant_id, subject, 'corr-fail');
    expect(context.customer).toBeNull();
    expect(aggregator.verificationReferenceFor('corr-fail')).toBeNull();
  });

  it('evicts oldest entries in bounded memory when max capacity is reached', async () => {
    const verifiedIdentity: CustomerIdentityRow = {
      id: 'ident-bound',
      tenant_id,
      customer_id: 'cust-bound',
      channel_type: 'web',
      channel_identifier: 'user',
      identifier_hash: 'hash',
      is_primary: true,
      verified_at: new Date('2026-09-01T00:00:00Z'),
      created_at: new Date('2026-09-01T00:00:00Z'),
    };

    const aggregator = new CareContextAggregator({
      repositories: {
        findIdentity: async () => verifiedIdentity,
        getProfile: async () => null,
        getConversation: async () => null,
      },
      maxMemoryEntries: 2,
    });

    const subject: SignalSubject = {
      session_id: 'sess-b',
      channel_type: 'web',
      channel_identifier: 'user',
    };

    await aggregator.hydrateContext(tenant_id, subject, 'corr-1');
    await aggregator.hydrateContext(tenant_id, subject, 'corr-2');
    expect(aggregator.verificationReferenceFor('corr-1')).toBe('ident-bound');
    expect(aggregator.verificationReferenceFor('corr-2')).toBe('ident-bound');

    // Third insertion evicts oldest ('corr-1')
    await aggregator.hydrateContext(tenant_id, subject, 'corr-3');
    expect(aggregator.verificationReferenceFor('corr-1')).toBeNull();
    expect(aggregator.verificationReferenceFor('corr-2')).toBe('ident-bound');
    expect(aggregator.verificationReferenceFor('corr-3')).toBe('ident-bound');
  });

  it('hydrates takeover and message history only through the canonical tenant-bound conversation UUID', async () => {
    const pausedConversation: ConversationRecord = {
      conversation_id: '22222222-2222-4222-8222-222222222222',
      tenant_id,
      customer_id: 'cust-100',
      channel: 'web',
      external_thread_id: 'thread-1',
      active_agent: 'CS-01',
      state: 'paused_takeover',
      takeover_operator_id: 'operator-1',
      last_message_at: '2026-09-01T12:00:00Z',
      created_at: '2026-09-01T10:00:00Z',
    };
    const messages: readonly ConversationMessageRecord[] = [
      {
        message_id: 'msg-1',
        sender_type: 'customer',
        sender_id: 'user-1',
        content: 'Help with my order',
        created_at: '2026-09-01T10:00:00Z',
      },
      {
        message_id: 'msg-2',
        sender_type: 'agent',
        sender_id: 'CS-01',
        content: 'Sure, what is the order number?',
        created_at: '2026-09-01T10:01:00Z',
      },
      {
        message_id: 'msg-3',
        sender_type: 'customer',
        sender_id: 'user-1',
        content: 'ORD-999',
        created_at: '2026-09-01T10:02:00Z',
      },
    ];
    let conversationLookupId: string | undefined;
    let historyLookupId: string | undefined;

    const aggregator = new CareContextAggregator({
      repositories: {
        findIdentity: async () => null,
        getProfile: async () => null,
        getConversation: async (_tenant_id, conversation_id) => {
          conversationLookupId = conversation_id;
          return pausedConversation;
        },
        listMessages: async (scope) => {
          historyLookupId = scope.conversation_id;
          return messages;
        },
      },
    });
    const subject: SignalSubject = {
      session_id: 'thread-1',
      conversation_id: pausedConversation.conversation_id,
      channel_type: 'web',
      channel_identifier: 'thread-1',
    };

    const context = await aggregator.hydrateContext(tenant_id, subject, correlation_id);

    expect(conversationLookupId).toBe(pausedConversation.conversation_id);
    expect(historyLookupId).toBe(pausedConversation.conversation_id);
    expect(context.working_memory.session_id).toBe('thread-1');
    expect(context.working_memory.conversation_id).toBe(pausedConversation.conversation_id);
    expect(context.working_memory.takeover_active).toBe(true);
    expect(context.working_memory.turn_count).toBe(3);
  });

  it.each([
    ['tenant', { tenant_id: 'different-tenant' }],
    ['channel', { channel: 'LINE' }],
    ['thread', { external_thread_id: 'different-thread' }],
  ] as const)('does not expose history or handoff identity when the persisted %s binding differs', async (_kind, mismatch) => {
    const conversation: ConversationRecord = {
      conversation_id: '22222222-2222-4222-8222-222222222222',
      tenant_id,
      customer_id: null,
      channel: 'web',
      external_thread_id: 'thread-1',
      active_agent: 'CS-01',
      state: 'paused_takeover',
      takeover_operator_id: 'operator-1',
      last_message_at: '2026-09-01T12:00:00Z',
      created_at: '2026-09-01T10:00:00Z',
    };
    const mismatchedConversation: ConversationRecord = { ...conversation, ...mismatch };
    let historyReads = 0;
    const aggregator = new CareContextAggregator({
      repositories: {
        findIdentity: async () => null,
        getProfile: async () => null,
        getConversation: async () => mismatchedConversation,
        listMessages: async () => {
          historyReads += 1;
          return [];
        },
      },
    });
    const subject: SignalSubject = {
      session_id: 'thread-1',
      conversation_id: conversation.conversation_id,
      channel_type: 'web',
      channel_identifier: 'thread-1',
    };

    const context = await aggregator.hydrateContext(tenant_id, subject, correlation_id);

    expect(context.working_memory.conversation_id).toBeUndefined();
    expect(context.working_memory.takeover_active).toBe(false);
    expect(context.working_memory.turn_count).toBe(1);
    expect(historyReads).toBe(0);
  });
});
