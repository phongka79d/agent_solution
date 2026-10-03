/**
 * @file Conversation routes: takeover and durable handoff coordination.
 *
 * Split from `conversations.test.ts`; the sibling file holds the other group exactly once and
 * every assertion body is unchanged.
 */

import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { createCredentialStore } from '../../gateway/principal.js';
import { GatewayRuntime } from '../../gateway/ports.js';
import { registerConversationRoutes } from './conversations.js';

const TENANT = 'tenant-a';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';

function buildTakeoverHarness(options: {
  readonly operator_id?: string;
  readonly release_outcome?: 'EXPIRED' | 'NOT_HELD' | 'HELD_BY_ANOTHER_OPERATOR';
} = {}) {
  const conversation: {
    conversation_id: string;
    tenant_id: string;
    customer_id: string | null;
    channel: 'WEB_CHAT';
    external_thread_id: string;
    active_agent: string;
    state: 'open' | 'paused_takeover' | 'closed';
    takeover_operator_id: string | null;
    last_message_at: string;
    created_at: string;
  } = {
    conversation_id: CONVERSATION_ID,
    tenant_id: TENANT,
    customer_id: null,
    channel: 'WEB_CHAT',
    external_thread_id: 'thread-a',
    active_agent: 'auto',
    state: 'open',
    takeover_operator_id: null,
    last_message_at: '2026-09-23T00:00:00.000Z',
    created_at: '2026-09-23T00:00:00.000Z',
  };
  const lease = { operator_id: 'operator-a', expires_at: '2026-09-23T00:01:00.000Z' };
  const operator_id = options.operator_id ?? 'operator-a';
  const release_outcome = options.release_outcome ?? 'EXPIRED';
  const acquire = vi.fn(async (_input: unknown) => ({
    outcome: 'ACQUIRED' as 'ACQUIRED' | 'RENEWED' | 'HELD_BY_ANOTHER_OPERATOR',
    lease,
  }));
  const release = vi.fn(async (_input: unknown) => ({
    outcome: release_outcome,
    lease: release_outcome === 'HELD_BY_ANOTHER_OPERATOR' ? lease : null,
  }));
  const claim = vi.fn(async (_input: unknown): Promise<'CLAIMED' | 'NO_HANDOFF' | 'HELD_BY_ANOTHER_OPERATOR'> => 'CLAIMED');
  const complete = vi.fn(async (_input: unknown): Promise<'COMPLETED' | 'NO_HANDOFF' | 'NOT_ASSIGNED' | 'HELD_BY_ANOTHER_OPERATOR'> => 'COMPLETED');
  const setState = vi.fn(async (
    _tenant_id: string,
    _conversation_id: string,
    expected_state: 'open' | 'paused_takeover' | 'closed',
    expected_operator_id: string | null,
    state: 'open' | 'paused_takeover' | 'closed',
    operator_id: string | null,
  ) => {
    if (
      conversation.state !== expected_state
      || conversation.takeover_operator_id !== expected_operator_id
    ) {
      return 'CONFLICT';
    }
    conversation.state = state;
    conversation.takeover_operator_id = operator_id;
    return 'UPDATED';
  });
  const clearTakeoverIfOwned = vi.fn(async (
    _tenant_id: string,
    _conversation_id: string,
    operator_id: string,
  ) => {
    if (conversation.state !== 'paused_takeover' || conversation.takeover_operator_id !== operator_id) return false;
    conversation.state = 'open';
    conversation.takeover_operator_id = null;
    return true;
  });
  const runtime = {
    conversations: {
      get: vi.fn(async () => conversation),
      setState,
      clearTakeoverIfOwned,
    },
    takeover: {
      acquire,
      release,
      holder: vi.fn(async () => lease),
    },
    handoffs: { claim, complete },
    audit: { record: vi.fn(async () => undefined) },
    clock: () => new Date('2026-09-23T00:00:00.000Z'),
    ids: () => 'corr-a',
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  registerConversationRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [{
        token: 'operator-token',
        tenant_id: TENANT,
        operator_id,
        permissions: ['conversation:takeover'],
      }],
      sessions: [],
      widgets: [],
    }),
  });
  return { app, acquire, claim, complete, conversation, release, setState, clearTakeoverIfOwned };
}

describe('conversation takeover durable handoff coordination', () => {
  it('claims a queued handoff without re-writing the conversation outside the claim transaction', async () => {
    const { app, claim, setState } = buildTakeoverHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/takeover',
      headers: { authorization: 'Bearer operator-token' },
      payload: { reason: 'customer requested a person', takeover_mode: 'FULL_CONTROL' },
    });
    expect(response.statusCode).toBe(200);
    expect(claim).toHaveBeenCalledWith({
      tenant_id: TENANT,
      conversation_id: CONVERSATION_ID,
      operator_id: 'operator-a',
    });
    expect(setState).not.toHaveBeenCalled();
    await app.close();
  });

  it('uses the manual takeover path only when no durable handoff exists', async () => {
    const { app, claim, setState } = buildTakeoverHarness();
    claim.mockResolvedValue('NO_HANDOFF');
    const response = await app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/takeover',
      headers: { authorization: 'Bearer operator-token' },
      payload: { reason: 'manual review', takeover_mode: 'FULL_CONTROL' },
    });
    expect(response.statusCode).toBe(200);
    expect(setState).toHaveBeenCalledWith(
      TENANT,
      CONVERSATION_ID,
      'open',
      null,
      'paused_takeover',
      'operator-a',
    );
    await app.close();
  });

  it('returns a version conflict and releases a new lease when the state compare-and-set loses', async () => {
    const { app, claim, release, setState } = buildTakeoverHarness();
    claim.mockResolvedValue('NO_HANDOFF');
    setState.mockResolvedValueOnce('CONFLICT');

    const response = await app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/takeover',
      headers: { authorization: 'Bearer operator-token' },
      payload: { reason: 'manual review', takeover_mode: 'FULL_CONTROL' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error_code).toBe('VERSION_CONFLICT');
    expect(release).toHaveBeenCalledOnce();
    await app.close();
  });

  it('releases only a newly acquired Redis lease when durable claim fails', async () => {
    const acquired = buildTakeoverHarness();
    acquired.claim.mockRejectedValue(new Error('database unavailable'));
    await acquired.app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/takeover',
      headers: { authorization: 'Bearer operator-token' },
      payload: { reason: 'manual review', takeover_mode: 'FULL_CONTROL' },
    });
    expect(acquired.release).toHaveBeenCalledOnce();
    await acquired.app.close();

    const renewed = buildTakeoverHarness();
    renewed.acquire.mockResolvedValue({
      outcome: 'RENEWED',
      lease: { operator_id: 'operator-a', expires_at: '2026-09-23T00:01:00.000Z' },
    });
    renewed.claim.mockRejectedValue(new Error('database unavailable'));
    await renewed.app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/takeover',
      headers: { authorization: 'Bearer operator-token' },
      payload: { reason: 'manual review', takeover_mode: 'FULL_CONTROL' },
    });
    expect(renewed.release).not.toHaveBeenCalled();
    await renewed.app.close();
  });

  it('leaves conversation ownership unchanged when Redis lease acquisition fails', async () => {
    const { app, acquire, claim, conversation, setState } = buildTakeoverHarness();
    conversation.state = 'paused_takeover';
    const before = {
      state: conversation.state,
      takeover_operator_id: conversation.takeover_operator_id,
    };
    acquire.mockRejectedValue(new Error('Redis unavailable'));

    const response = await app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/takeover',
      headers: { authorization: 'Bearer operator-token' },
      payload: { reason: 'manual review', takeover_mode: 'FULL_CONTROL' },
    });

    expect(response.statusCode).not.toBe(200);

    expect(claim).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
    expect(conversation.state).toBe(before.state);
    expect(conversation.takeover_operator_id).toBe(before.takeover_operator_id);
    await app.close();
  });

  it('returns bot control only through the assigned handoff completion transaction', async () => {
    const { app, complete, conversation, release, setState } = buildTakeoverHarness();
    conversation.state = 'paused_takeover';
    conversation.takeover_operator_id = 'operator-a';
    const response = await app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/resume',
      headers: { authorization: 'Bearer operator-token' },
      payload: { handoff_summary: 'resolved with the customer' },
    });
    expect(response.statusCode).toBe(200);
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(complete.mock.invocationCallOrder[0]!);
    expect(complete).toHaveBeenCalledWith({
      tenant_id: TENANT,
      conversation_id: CONVERSATION_ID,
      operator_id: 'operator-a',
      completion_summary: 'resolved with the customer',
    });
    expect(setState).not.toHaveBeenCalled();
    await app.close();
  });

  it('uses the compare-and-clear resume path only when no durable handoff exists', async () => {
    const { app, clearTakeoverIfOwned, complete, conversation, setState } = buildTakeoverHarness();
    conversation.state = 'paused_takeover';
    conversation.takeover_operator_id = 'operator-a';
    complete.mockResolvedValue('NO_HANDOFF');
    const response = await app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/resume',
      headers: { authorization: 'Bearer operator-token' },
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(clearTakeoverIfOwned).toHaveBeenCalledWith(TENANT, CONVERSATION_ID, 'operator-a');
    expect(setState).not.toHaveBeenCalled();
    await app.close();
  });
  it('treats an expired lease as released when the owning operator resumes', async () => {
    const { app, complete, clearTakeoverIfOwned, conversation, release, setState } = buildTakeoverHarness();
    conversation.state = 'paused_takeover';
    conversation.takeover_operator_id = 'operator-a';
    release.mockResolvedValue({ outcome: 'NOT_HELD', lease: null });
    complete.mockResolvedValue('NO_HANDOFF');

    const response = await app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/resume',
      headers: { authorization: 'Bearer operator-token' },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(clearTakeoverIfOwned).toHaveBeenCalledWith(TENANT, CONVERSATION_ID, 'operator-a');
    expect(setState).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses to complete a queued handoff not assigned to the operator', async () => {
    const { app, complete, conversation, setState } = buildTakeoverHarness();
    conversation.state = 'paused_takeover';
    conversation.takeover_operator_id = 'operator-a';
    complete.mockResolvedValue('NOT_ASSIGNED');
    const response = await app.inject({
      method: 'POST',
      url: '/conversations/' + CONVERSATION_ID + '/resume',
      headers: { authorization: 'Bearer operator-token' },
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error_code).toBe('TAKEOVER_LEASE_LOST');
    expect(setState).not.toHaveBeenCalled();
    await app.close();
  });
});
