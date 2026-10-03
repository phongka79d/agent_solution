import { describe, expect, it, vi } from 'vitest';
import { sessionTakeoverLockKey, type RedisInjectedClient } from '@agentos/database';

import {
  DEFAULT_TAKEOVER_SWEEP_INTERVAL_MS,
  TAKEOVER_EXPIRY_GRACE_MS,
  TAKEOVER_SWEEP_BATCH_LIMIT,
  createTakeoverSweeper,
  type PausedTakeoverRecord,
} from './takeover-sweeper.js';

interface ConversationState {
  conversation_id: string;
  takeover_operator_id: string | null;
  state: 'paused_takeover' | 'open';
}

function takeoverRecord(conversation_id: string, operator_id: string): ConversationState {
  return { conversation_id, takeover_operator_id: operator_id, state: 'paused_takeover' };
}

describe('createTakeoverSweeper', () => {
  it('clears only a lease absent beyond the grace window, preserving live leases and assigned handoffs', async () => {
    const tenant_id = 'tenant-1';
    const orphaned = takeoverRecord('conversation-orphaned', 'operator-orphaned');
    const live = takeoverRecord('conversation-live', 'operator-live');
    const assigned = takeoverRecord('conversation-assigned', 'operator-assigned');
    const conversations = [orphaned, live, assigned];
    const assignedHandoffs = new Set([assigned.conversation_id]);
    const clearOrphanedTakeoverIfOwned = vi.fn(async (
      _tenant_id: string,
      conversation_id: string,
      operator_id: string,
    ) => {
      const conversation = conversations.find((row) => row.conversation_id === conversation_id);
      if (!conversation || assignedHandoffs.has(conversation_id)
        || conversation.state !== 'paused_takeover'
        || conversation.takeover_operator_id !== operator_id) return false;
      conversation.state = 'open';
      conversation.takeover_operator_id = null;
      return true;
    });
    const listPausedTakeovers = vi.fn(async (_tenant_id: string, limit: number) => {
      expect(limit).toBe(TAKEOVER_SWEEP_BATCH_LIMIT);
      return conversations.filter((row) => row.state === 'paused_takeover');
    });
    const liveKey = sessionTakeoverLockKey(tenant_id, live.conversation_id);
    const redisValues = new Map([[liveKey, JSON.stringify({ operator_id: 'operator-live' })]]);
    const redis = {
      get: vi.fn(async (key: string) => redisValues.get(key) ?? null),
      pttl: vi.fn(async (key: string) => redisValues.has(key) ? 10_000 : -2),
      set: vi.fn(),
      eval: vi.fn(),
    } as unknown as RedisInjectedClient;
    let nowMs = 1_000;
    const sweeper = createTakeoverSweeper({
      tenantIds: [tenant_id],
      repository: { listPausedTakeovers, clearOrphanedTakeoverIfOwned },
      redis,
      now: () => new Date(nowMs),
      autoStart: false,
    });

    await sweeper.runOnce();
    expect(clearOrphanedTakeoverIfOwned).not.toHaveBeenCalled();

    nowMs += TAKEOVER_EXPIRY_GRACE_MS;
    await sweeper.runOnce();
    expect(clearOrphanedTakeoverIfOwned).not.toHaveBeenCalled();

    nowMs += 1;
    await sweeper.runOnce();

    expect(clearOrphanedTakeoverIfOwned).toHaveBeenCalledTimes(2);
    expect(clearOrphanedTakeoverIfOwned).toHaveBeenNthCalledWith(
      1,
      tenant_id,
      orphaned.conversation_id,
      'operator-orphaned',
    );
    expect(clearOrphanedTakeoverIfOwned).toHaveBeenNthCalledWith(
      2,
      tenant_id,
      assigned.conversation_id,
      assigned.takeover_operator_id,
    );
    expect(orphaned.state).toBe('open');
    expect(live.state).toBe('paused_takeover');
    expect(assigned.state).toBe('paused_takeover');
    expect(listPausedTakeovers).toHaveBeenCalledTimes(3);
    await sweeper.stop();
  });


  it('continues scanning after a full page so later orphaned conversations are not starved', async () => {
    const tenant_id = 'tenant-paged';
    const liveRows = Array.from({ length: TAKEOVER_SWEEP_BATCH_LIMIT }, (_, index) => ({
      conversation_id: `conversation-${String(index).padStart(3, '0')}`,
      takeover_operator_id: `operator-${index}`,
    }));
    const orphaned: PausedTakeoverRecord = {
      conversation_id: 'conversation-zzz',
      takeover_operator_id: 'operator-orphaned',
    };
    let orphanedStillPaused = true;
    const listPausedTakeovers = vi.fn(async (
      _tenant_id: string,
      limit: number,
      afterConversationId?: string,
    ) => [...liveRows, ...(orphanedStillPaused ? [orphaned] : [])]
      .filter((row) => afterConversationId === undefined || row.conversation_id > afterConversationId)
      .slice(0, limit));
    const clearOrphanedTakeoverIfOwned = vi.fn(async () => {
      orphanedStillPaused = false;
      return true;
    });
    const orphanedKey = sessionTakeoverLockKey(tenant_id, orphaned.conversation_id);
    const redis = {
      get: vi.fn(async (key: string) => key === orphanedKey ? null : '{}'),
      pttl: vi.fn(async () => 10_000),
      set: vi.fn(),
      eval: vi.fn(),
    } as unknown as RedisInjectedClient;
    let nowMs = 1_000;
    const sweeper = createTakeoverSweeper({
      tenantIds: [tenant_id],
      repository: { listPausedTakeovers, clearOrphanedTakeoverIfOwned },
      redis,
      now: () => new Date(nowMs),
      autoStart: false,
    });

    await sweeper.runOnce();
    nowMs += TAKEOVER_EXPIRY_GRACE_MS + 1;
    await sweeper.runOnce();

    expect(listPausedTakeovers).toHaveBeenCalledTimes(4);
    expect(listPausedTakeovers).toHaveBeenNthCalledWith(2, tenant_id, TAKEOVER_SWEEP_BATCH_LIMIT, liveRows.at(-1)?.conversation_id);
    expect(clearOrphanedTakeoverIfOwned).toHaveBeenCalledTimes(1);
    await sweeper.stop();
  });

  it('schedules on the 30-second default cadence', async () => {
    let scheduledTimeout = 0;
    const sweeper = createTakeoverSweeper({
      tenantIds: [],
      repository: {
        listPausedTakeovers: async () => [],
        clearOrphanedTakeoverIfOwned: async () => false,
      },
      redis: { get: async () => null, pttl: async () => -2, set: async () => null, eval: async () => null },
      setInterval: (_handler, timeout) => {
        scheduledTimeout = timeout;
        return {} as NodeJS.Timeout;
      },
    });

    expect(sweeper.intervalMs).toBe(DEFAULT_TAKEOVER_SWEEP_INTERVAL_MS);
    expect(scheduledTimeout).toBe(30_000);
    await sweeper.stop();
  });
});
