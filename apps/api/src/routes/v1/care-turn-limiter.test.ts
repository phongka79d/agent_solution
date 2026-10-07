import { describe, expect, it } from 'vitest';
import { InMemoryTurnRateLimiter } from './care-turn.js';

describe('InMemoryTurnRateLimiter', () => {
  it('validates constructor parameters', () => {
    expect(() => new InMemoryTurnRateLimiter({ capacity: 0 })).toThrow(TypeError);
    expect(() => new InMemoryTurnRateLimiter({ capacity: -5 })).toThrow(TypeError);
    expect(() => new InMemoryTurnRateLimiter({ refill_per_second: -1 })).toThrow(TypeError);
    expect(() => new InMemoryTurnRateLimiter({ max_buckets: 0 })).toThrow(TypeError);
    expect(() => new InMemoryTurnRateLimiter({ stale_after_ms: -100 })).toThrow(TypeError);
  });

  it('allows consumption up to capacity and rejects when tokens are exhausted', () => {
    let now = 1000;
    const limiter = new InMemoryTurnRateLimiter({
      capacity: 3,
      refill_per_second: 1,
      clock: () => new Date(now),
    });

    expect(limiter.consume('t1', 's1')).toBe(true);
    expect(limiter.consume('t1', 's1')).toBe(true);
    expect(limiter.consume('t1', 's1')).toBe(true);
    expect(limiter.consume('t1', 's1')).toBe(false);

    // After 1 second, 1 token is refilled
    now += 1000;
    expect(limiter.consume('t1', 's1')).toBe(true);
    expect(limiter.consume('t1', 's1')).toBe(false);
  });

  it('prunes stale buckets when max_buckets capacity is reached', () => {
    let now = 1000;
    const limiter = new InMemoryTurnRateLimiter({
      capacity: 5,
      max_buckets: 3,
      stale_after_ms: 5000,
      clock: () => new Date(now),
    });

    expect(limiter.consume('t1', 's1')).toBe(true);
    expect(limiter.consume('t1', 's2')).toBe(true);
    expect(limiter.consume('t1', 's3')).toBe(true);
    expect(limiter.size).toBe(3);

    // Advance time past stale threshold for s1, s2
    now += 6000;

    // Consuming a 4th session triggers pruning of stale s1 and s2
    expect(limiter.consume('t1', 's4')).toBe(true);
    // s1 and s2 were pruned, s3 and s4 remain
    expect(limiter.size).toBeLessThanOrEqual(3);
  });

  it('evicts oldest buckets when max_buckets is exceeded and buckets are not yet stale', () => {
    const now = 1000;
    const limiter = new InMemoryTurnRateLimiter({
      capacity: 5,
      max_buckets: 2,
      stale_after_ms: 100000,
      clock: () => new Date(now),
    });

    expect(limiter.consume('t1', 's1')).toBe(true);
    expect(limiter.consume('t1', 's2')).toBe(true);
    expect(limiter.size).toBe(2);

    // Inserting s3 causes eviction of oldest to stay bounded
    expect(limiter.consume('t1', 's3')).toBe(true);
    expect(limiter.size).toBeLessThanOrEqual(2);
  });
});
