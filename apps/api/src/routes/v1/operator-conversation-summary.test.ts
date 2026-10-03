import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import type { CompanyCrmConversationSummaryRow } from '@agentos/database';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerOperatorConversationRoutes } from './operator-conversations.js';
import { deriveConversationOwnership } from '../../projections/conversation-summary.js';

const TENANT = 'tenant-a';
const TOKEN = 'takeover-reader';
const CUSTOMER_READER_TOKEN = 'customer-reader';
const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

const summary: CompanyCrmConversationSummaryRow = {
  conversation_id: CONVERSATION_ID,
  customer_id: 'customer-1',
  channel: 'WEB_CHAT',
  state: 'paused_takeover',
  active_agent: 'care-agent',
  takeover_operator_id: null,
  last_message_at: '2026-09-28T00:00:00.000Z',
  verified_phone: '+886912345678',
  verified_email: 'alice@example.com',
  customer_display_name: 'Alice',
  customer_tier: 'standard',
  customer_classification: 'UNKNOWN',
};

function buildHarness() {
  const runtime = {
    companyCrm: { getConversationSummary: async () => summary },
    takeover: { holder: async () => null },
    conversations: {},
    audit: { record: async () => undefined },
    ids: () => 'corr-summary-1',
    clock: () => new Date('2026-09-28T00:00:00.000Z'),
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerOperatorConversationRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [
        { token: TOKEN, tenant_id: TENANT, operator_id: 'operator-1', permissions: ['conversation:takeover'] },
        { token: CUSTOMER_READER_TOKEN, tenant_id: TENANT, operator_id: 'operator-2', permissions: ['customer:read'] },
      ],
      sessions: [],
      widgets: [],
    }),
  });
  return app;
}

describe('conversation summary route', () => {
  it('requires conversation:takeover and masks contacts with unknown classification explicit', async () => {
    const app = buildHarness();
    try {
      const allowed = await app.inject({
        method: 'GET',
        url: `/conversations/${CONVERSATION_ID}/summary`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      const denied = await app.inject({
        method: 'GET',
        url: `/conversations/${CONVERSATION_ID}/summary`,
        headers: { authorization: `Bearer ${CUSTOMER_READER_TOKEN}` },
      });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toMatchObject({
        conversation_id: CONVERSATION_ID,
        customer: {
          display_name: 'Alice',
          classification: 'UNCLASSIFIED',
          email: 'a***@e***.com',
          phone: '***5678',
        },
        ownership: 'PAUSED_ORPHAN',
        owner: null,
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error_code).toBe('INSUFFICIENT_AUTHORITY');
    } finally {
      await app.close();
    }
  });

  it('derives all six ownership states from stored state, handoffs and live leases', () => {
    const now = new Date('2026-09-28T00:00:00.000Z');
    const base = {
      has_enqueued_handoff: false,
      has_assigned_handoff: false,
      lease: null,
      requesting_operator_id: 'operator-1',
      now,
    };
    const cases = [
      { input: { ...base, state: 'open' }, expected: 'AI_ACTIVE' },
      { input: { ...base, state: 'open', has_enqueued_handoff: true }, expected: 'NEEDS_HUMAN' },
      {
        input: {
          ...base,
          state: 'paused_takeover',
          lease: { operator_id: 'operator-1', expires_at: '2026-09-28T00:01:00.000Z' },
        },
        expected: 'HUMAN_ME',
      },
      {
        input: {
          ...base,
          state: 'paused_takeover',
          lease: { operator_id: 'operator-2', expires_at: '2026-09-28T00:01:00.000Z' },
        },
        expected: 'HUMAN_OTHER',
      },
      {
        input: {
          ...base,
          state: 'paused_takeover',
          lease: { operator_id: 'operator-1', expires_at: '2026-09-27T23:59:59.999Z' },
        },
        expected: 'PAUSED_ORPHAN',
      },
      {
        input: {
          ...base,
          state: 'closed',
          lease: { operator_id: 'operator-1', expires_at: '2026-09-28T00:01:00.000Z' },
        },
        expected: 'CLOSED',
      },
      {
        input: { ...base, state: 'paused_takeover', has_assigned_handoff: true },
        expected: 'NEEDS_HUMAN',
      },
    ] as const;
    const projections = cases.map(({ input }) => deriveConversationOwnership(input));

    expect(projections.map(({ ownership }) => ownership)).toEqual(cases.map(({ expected }) => expected));
    expect(projections[0]?.owner).toBeNull();
    expect(projections[1]?.owner).toBeNull();
    expect(projections[2]?.owner).toEqual({
      operator_id: 'operator-1',
      display_name: null,
      lease_expires_at: '2026-09-28T00:01:00.000Z',
    });
    expect(projections[3]?.owner?.operator_id).toBe('operator-2');
    expect(projections[4]?.owner).toBeNull();
    expect(projections[5]?.owner).toBeNull();
    expect(projections[6]?.owner).toBeNull();
  });

});
