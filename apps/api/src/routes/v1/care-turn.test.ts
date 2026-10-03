import type { RedisInjectedClient } from '@agentos/database';
import { describe, expect, it } from 'vitest';

import { InMemoryTurnRateLimiter, RedisTurnRateLimiter } from './care-turn.js';

describe('InMemoryTurnRateLimiter bucket retention', () => {
  it('expires idle buckets before the size limit is reached', () => {
    let now_ms = 0;
    const limiter = new InMemoryTurnRateLimiter({
      capacity: 1,
      refill_per_second: 0,
      idle_ttl_ms: 100,
      max_buckets: 3,
      clock: () => new Date(now_ms),
    });

    expect(limiter.consume('tenant-a', 'session-a')).toBe(true);
    now_ms = 50;
    expect(limiter.consume('tenant-a', 'session-b')).toBe(true);
    now_ms = 101;
    expect(limiter.consume('tenant-a', 'session-c')).toBe(true);
    now_ms = 102;
    expect(limiter.consume('tenant-a', 'session-a')).toBe(true);
  });

  it('evicts the least recently used bucket when at capacity', () => {
    let now_ms = 0;
    const limiter = new InMemoryTurnRateLimiter({
      capacity: 1,
      refill_per_second: 0,
      idle_ttl_ms: 10_000,
      max_buckets: 2,
      clock: () => new Date(now_ms),
    });

    expect(limiter.consume('tenant-a', 'session-a')).toBe(true);
    now_ms = 1;
    expect(limiter.consume('tenant-a', 'session-b')).toBe(true);
    now_ms = 2;
    expect(limiter.consume('tenant-a', 'session-a')).toBe(false);
    now_ms = 3;
    expect(limiter.consume('tenant-a', 'session-c')).toBe(true);
    now_ms = 4;
    expect(limiter.consume('tenant-a', 'session-a')).toBe(false);
    now_ms = 5;
    expect(limiter.consume('tenant-a', 'session-b')).toBe(true);
  });
});

describe('RedisTurnRateLimiter', () => {
  it('shares atomic bucket state across limiter instances while keeping tenant/session keys isolated', async () => {
    let now_ms = 0;
    const buckets = new Map<string, { tokens: number; last_refill_ms: number; expires_at: number }>();
    const redis = {
      async eval(
        _script: string,
        numberOfKeys: number,
        ...args: ReadonlyArray<string | number>
      ): Promise<unknown> {
        if (numberOfKeys !== 1) throw new Error('expected one Redis key');
        const key = args[0];
        const capacity = args[1];
        const refill_per_second = args[2];
        const idle_ttl_ms = args[3];
        if (
          typeof key !== 'string'
          || typeof capacity !== 'number'
          || typeof refill_per_second !== 'number'
          || typeof idle_ttl_ms !== 'number'
        ) {
          throw new Error('unexpected Redis token bucket arguments');
        }

        const stored = buckets.get(key);
        const bucket = stored !== undefined && stored.expires_at > now_ms
          ? stored
          : { tokens: capacity, last_refill_ms: now_ms, expires_at: now_ms + idle_ttl_ms };
        const elapsed_ms = Math.max(0, now_ms - bucket.last_refill_ms);
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsed_ms * refill_per_second / 1000);
        bucket.last_refill_ms = now_ms;
        const allowed = bucket.tokens >= 1;
        if (allowed) bucket.tokens -= 1;
        bucket.expires_at = now_ms + idle_ttl_ms;
        buckets.set(key, bucket);
        return allowed ? 1 : 0;
      },
    } satisfies Pick<RedisInjectedClient, 'eval'>;
    const firstProcess = new RedisTurnRateLimiter(redis, {
      capacity: 1,
      refill_per_second: 1,
      idle_ttl_ms: 2_000,
    });
    const secondProcess = new RedisTurnRateLimiter(redis, {
      capacity: 1,
      refill_per_second: 1,
      idle_ttl_ms: 2_000,
    });

    expect(await firstProcess.consume('tenant-a', 'session-a')).toBe(true);
    expect(await secondProcess.consume('tenant-a', 'session-a')).toBe(false);
    expect(await secondProcess.consume('tenant-b', 'session-a')).toBe(true);
    now_ms = 1_000;
    expect(await secondProcess.consume('tenant-a', 'session-a')).toBe(true);
  });
});
