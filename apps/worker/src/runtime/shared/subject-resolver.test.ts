import { describe, expect, it, vi } from 'vitest';
import { OrchestratorError } from '@agentos/core-engine/contracts';
import type { SignalSubject } from '@agentos/core-engine/contracts';
import type { ConversationRecord, CustomerProfileRow } from '@agentos/database';

import { CareContextAggregator } from '../care/context-aggregator.js';
import { SalesContextAggregator } from '../sales/context-aggregator.js';
import { resolveSubject } from './subject-resolver.js';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const CUSTOMER_ID = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';

const profile = (overrides: Partial<CustomerProfileRow> = {}): CustomerProfileRow => ({
  customer_id: CUSTOMER_ID,
  tenant_id: TENANT_ID,
  verified_phone: '+10000000000',
  verified_email: 'verified@example.test',
  total_spent: '120.50',
  order_count: 2,
  rfm_segment_hypothesis: 'LOYAL',
  consent_marketing: true,
  consent_updated_at: new Date('2026-01-01T00:00:00.000Z'),
  suppression_active: false,
  line_user_id: null,
  created_at: new Date('2025-01-01T00:00:00.000Z'),
  ...overrides,
});

const conversation = (overrides: Partial<ConversationRecord> = {}): ConversationRecord => ({
  conversation_id: CONVERSATION_ID,
  tenant_id: TENANT_ID,
  customer_id: CUSTOMER_ID,
  channel: 'web',
  external_thread_id: 'thread-1',
  active_agent: 'CS-01',
  state: 'open',
  takeover_operator_id: null,
  last_message_at: '2026-01-01T00:00:00.000Z',
  created_at: '2025-01-01T00:00:00.000Z',
  ...overrides,
});

const subject: SignalSubject = {
  session_id: 'thread-1',
  conversation_id: CONVERSATION_ID,
  channel_type: 'web',
  channel_identifier: 'thread-1',
  verified_customer_id: CUSTOMER_ID,
};

describe('resolveSubject', () => {
  it('hydrates Care and Sales from the same verified subject and bound conversation', async () => {
    const customerProfile = profile();
    const conversationRow = conversation();
    const getProfile = vi.fn(async () => customerProfile);
    const getConversation = vi.fn(async () => conversationRow);
    const repos = { getProfile, getConversation };

    const care = new CareContextAggregator({
      repositories: { ...repos, findIdentity: async () => null, listMessages: async () => [] },
    });
    const sales = new SalesContextAggregator({
      repositories: { ...repos, listTimeline: async () => ({ items: [], next_cursor: null }) },
      sessionControl: { isTakenOver: async () => false },
    });

    const [careContext, salesContext] = await Promise.all([
      care.hydrateContext(TENANT_ID, subject, 'care-correlation'),
      sales.hydrateContext(TENANT_ID, subject, 'sales-correlation'),
    ]);

    expect(careContext.customer).toEqual(salesContext.customer);
    expect(careContext.customer?.customer_id).toBe(CUSTOMER_ID);
    expect(careContext.working_memory.conversation_id).toBe(CONVERSATION_ID);
    expect(salesContext.working_memory.conversation_id).toBe(CONVERSATION_ID);
    expect(getProfile).toHaveBeenCalledTimes(2);
    expect(getConversation).toHaveBeenCalledTimes(2);
  });

  it('rejects a conversation bound to another customer with a fatal subject mismatch', async () => {
    const failedResolution = resolveSubject(TENANT_ID, subject, {
      getProfile: async () => profile(),
      getConversation: async () => conversation({ customer_id: 'bbbbbbbb-0000-4000-8000-00000000000b' }),
    });
    await expect(failedResolution).rejects.toBeInstanceOf(OrchestratorError);
    await expect(failedResolution).rejects.toMatchObject({ code: 'SUBJECT_BINDING_MISMATCH' });
  });

  it('rejects a conversation that is not bound to the gateway session', async () => {
    await expect(resolveSubject(TENANT_ID, {
      ...subject,
      session_id: 'another-session',
    }, {
      getProfile: async () => profile(),
      getConversation: async () => conversation(),
    })).rejects.toMatchObject({ code: 'SUBJECT_BINDING_MISMATCH' });
  });

  it('keeps a subject without verified_customer_id anonymous and does not look up a customer', async () => {
    const getProfile = vi.fn(async () => profile());
    const anonymous: SignalSubject = {
      session_id: 'session-anon',
      channel_type: 'web',
      channel_identifier: 'same-handle-as-verified-customer',
    };
    const resolved = await resolveSubject(TENANT_ID, anonymous, {
      getProfile,
      getConversation: async () => null,
    });

    expect(resolved.customer).toBeNull();
    expect(getProfile).not.toHaveBeenCalled();
  });

});
