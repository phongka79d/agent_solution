import { beforeEach, describe, expect, it } from 'vitest';
import {
  createConfiguredSessionStore,
  MemorySessionStore,
  RedisSessionStore,
  type RedisSessionClient,
  type SessionStore,
} from './session-store';

interface TestSession {
  readonly identityId: string;
  readonly expiresAt: number;
  readonly value: string;
}

type StoreKind = 'memory' | 'redis';

const KEY_PREFIX = 'test:tenant:session:';
const STORE_OPTIONS = {
  identityOf: (session: TestSession): string => session.identityId,
  expiresAtOf: (session: TestSession): number => session.expiresAt,
};

class FakeRedisSessionClient implements RedisSessionClient {
  private readonly values = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async del(key: string): Promise<number> {
    return this.values.delete(key) ? 1 : 0;
  }

  async keys(pattern: string): Promise<readonly string[]> {
    if (!pattern.endsWith('*')) return this.values.has(pattern) ? [pattern] : [];
    const prefix = pattern.slice(0, -1);
    return [...this.values.keys()].filter((key) => key.startsWith(prefix));
  }

  async setRaw(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

interface StoreHarness {
  readonly store: SessionStore<TestSession>;
}

function createStore(kind: StoreKind): StoreHarness {
  if (kind === 'memory') return { store: new MemorySessionStore(STORE_OPTIONS) };
  const redis = new FakeRedisSessionClient();
  return {
    store: new RedisSessionStore({ ...STORE_OPTIONS, client: redis, keyPrefix: KEY_PREFIX }),
  };
}

function session(identityId: string, expiresAt: number, value: string): TestSession {
  return { identityId, expiresAt, value };
}

describe.each(['memory', 'redis'] as const)('%s session store contract', (kind) => {
  let harness: StoreHarness;

  beforeEach(() => {
    harness = createStore(kind);
  });

  it('round-trips sessions through set and get', async () => {
    const stored = session('identity-1', 200, 'session-1');

    await harness.store.set('session-1', stored);

    expect(await harness.store.get('session-1')).toEqual(stored);
  });

  it('returns the removed session from delete', async () => {
    const stored = session('identity-1', 200, 'session-1');
    await harness.store.set('session-1', stored);

    expect(await harness.store.delete('session-1')).toEqual(stored);
    expect(await harness.store.get('session-1')).toBeUndefined();
  });

  it('deleteByIdentity removes only that identity\'s sessions', async () => {
    const first = session('identity-1', 200, 'session-1');
    const other = session('identity-2', 200, 'session-2');
    const second = session('identity-1', 200, 'session-3');
    await harness.store.set('session-1', first);
    await harness.store.set('session-2', other);
    await harness.store.set('session-3', second);

    expect(await harness.store.deleteByIdentity('identity-1')).toEqual([first, second]);
    expect(await harness.store.get('session-1')).toBeUndefined();
    expect(await harness.store.get('session-3')).toBeUndefined();
    expect(await harness.store.get('session-2')).toEqual(other);
  });

  it('sweep removes only expired sessions', async () => {
    const expired = session('identity-1', 100, 'expired');
    const active = session('identity-2', 101, 'active');
    await harness.store.set('expired', expired);
    await harness.store.set('active', active);

    expect(await harness.store.sweep(100)).toEqual([expired]);
    expect(await harness.store.get('expired')).toBeUndefined();
    expect(await harness.store.get('active')).toEqual(active);
  });
});

describe('RedisSessionStore specifics', () => {
  it('drops a corrupt JSON entry', async () => {
    const redis = new FakeRedisSessionClient();
    const store = new RedisSessionStore({ ...STORE_OPTIONS, client: redis, keyPrefix: KEY_PREFIX });
    const key = `${KEY_PREFIX}corrupt`;
    await redis.setRaw(key, '{not-json');

    expect(await store.get('corrupt')).toBeUndefined();
    expect(await redis.get(key)).toBeNull();
  });

  it('leaves keys from another prefix untouched', async () => {
    const redis = new FakeRedisSessionClient();
    const store = new RedisSessionStore({ ...STORE_OPTIONS, client: redis, keyPrefix: KEY_PREFIX });
    const otherKey = 'other:session:1';
    const otherSession = session('identity-1', 200, 'other');
    await redis.setRaw(otherKey, JSON.stringify(otherSession));
    await store.set('owned', session('identity-1', 200, 'owned'));

    expect(await store.deleteByIdentity('identity-1')).toEqual([session('identity-1', 200, 'owned')]);
    expect(await redis.get(otherKey)).toBe(JSON.stringify(otherSession));
  });
});

describe('createConfiguredSessionStore', () => {
  it('defaults to MemorySessionStore', () => {
    expect(createConfiguredSessionStore({ ...STORE_OPTIONS, env: {} })).toBeInstanceOf(MemorySessionStore);
  });

  it('selects MemorySessionStore explicitly', () => {
    expect(createConfiguredSessionStore({ ...STORE_OPTIONS, env: { AUTH_SESSION_STORE: 'memory' } })).toBeInstanceOf(MemorySessionStore);
  });

  it('rejects Redis without REDIS_URL', () => {
    expect(() => createConfiguredSessionStore({
      ...STORE_OPTIONS,
      env: { AUTH_SESSION_STORE: 'redis' },
      redisClient: new FakeRedisSessionClient(),
    })).toThrow(/REDIS_URL is required/);
  });

  it('rejects Redis without an injected client', () => {
    expect(() => createConfiguredSessionStore({
      ...STORE_OPTIONS,
      env: { AUTH_SESSION_STORE: 'redis', REDIS_URL: 'redis://test' },
    })).toThrow(/RedisSessionClient is required/);
  });

  it('rejects an unknown store selection', () => {
    expect(() => createConfiguredSessionStore({
      ...STORE_OPTIONS,
      env: { AUTH_SESSION_STORE: 'filesystem' },
    })).toThrow(/memory or redis/);
  });

  it('returns RedisSessionStore for valid Redis configuration', () => {
    expect(createConfiguredSessionStore({
      ...STORE_OPTIONS,
      env: { AUTH_SESSION_STORE: 'redis', REDIS_URL: 'redis://test' },
      redisClient: new FakeRedisSessionClient(),
    })).toBeInstanceOf(RedisSessionStore);
  });
});
