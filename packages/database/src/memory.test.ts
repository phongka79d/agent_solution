import { describe, expect, it } from 'vitest';

import type { RedisInjectedClient } from './contracts/index.js';
import * as qdrant from './memory/qdrant.js';
import * as redis from './memory/redis.js';

const {
  EFFECT_RESERVATION_TTL_SECONDS,
  SESSION_MUTEX_TTL_MS,
  SESSION_TAKEOVER_LOCK_TTL_MS,
  TASK_LEASE_TTL_MS,
  acquireSessionMutex,
  effectReservationKey,
  rateLimitKey,
  releaseSessionMutex,
  reserveEffectKey,
  sessionMutexKey,
  sessionTakeoverLockKey,
  taskLeaseKey,
  workingMemoryKey,
} = redis;

const {
  APPROVED_DOCUMENT_STATUS,
  KNOWLEDGE_NAMESPACES,
  KNOWLEDGE_PAYLOAD_INDEXES,
  SECOND_BRAIN_COLLECTION,
  buildCustomerKnowledgeFilter,
  buildOrganizationalKnowledgeFilter,
} = qdrant;

const TENANT = '01920000-0000-7000-8000-00000000000a';
const OTHER_TENANT = '01920000-0000-7000-8000-00000000000b';
const SESSION = 'session-1';

const CANONICAL_NAMESPACES: readonly string[] = [
  'company',
  'customer',
  'product',
  'brand',
  'marketing',
  'sales',
  'customer-care',
  'policy',
];

const BLANK_SEGMENTS: readonly string[] = ['', '   '];

interface RedisCommand {
  readonly command: 'set' | 'get' | 'eval';
  readonly key: string;
  readonly args: ReadonlyArray<string | number>;
  readonly keys: number;
  readonly script?: string;
}

/**
 * In-memory Redis stand-in. It models the two behaviours the helpers depend on:
 * `SET ... NX` refuses an existing key, and the release script deletes only when the
 * stored value equals the caller's token. TTLs are not simulated: the tests expire a
 * key by deleting it from `store`.
 */
class FakeRedisClient implements RedisInjectedClient {
  readonly calls: RedisCommand[] = [];
  readonly store = new Map<string, string>();

  async set(
    key: string,
    value: string,
    ...args: ReadonlyArray<string | number>
  ): Promise<string | null> {
    this.calls.push({ command: 'set', key, args: [value, ...args], keys: 1 });

    if (args.includes('NX') && this.store.has(key)) {
      return null;
    }

    this.store.set(key, value);

    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    this.calls.push({ command: 'get', key, args: [], keys: 1 });

    return this.store.get(key) ?? null;
  }

  async eval(
    script: string,
    numberOfKeys: number,
    ...args: ReadonlyArray<string | number>
  ): Promise<unknown> {
    const [key, token] = args;
    this.calls.push({
      command: 'eval',
      key: String(key ?? ''),
      args,
      keys: numberOfKeys,
      script,
    });

    if (key === undefined || token === undefined) {
      return 0;
    }

    if (this.store.get(String(key)) === String(token)) {
      this.store.delete(String(key));

      return 1;
    }

    return 0;
  }
}

describe('redis key builders', () => {
  it('builds one tenant-scoped key per contract pattern', () => {
    expect(sessionMutexKey(TENANT, SESSION)).toBe(`tenant:${TENANT}:session:${SESSION}:mutex`);
    expect(sessionTakeoverLockKey(TENANT, SESSION)).toBe(
      `tenant:${TENANT}:session:${SESSION}:takeover_lock`,
    );
    expect(effectReservationKey(TENANT, 'effect-1')).toBe(`tenant:${TENANT}:effect:effect-1`);
    expect(taskLeaseKey(TENANT, 'run-1')).toBe(`tenant:${TENANT}:task:run-1:lease`);
    expect(rateLimitKey(TENANT, 'orders', '1m')).toBe(`tenant:${TENANT}:ratelimit:orders:1m`);
    expect(workingMemoryKey(TENANT, SESSION)).toBe(`tenant:${TENANT}:wm:${SESSION}`);
  });

  it('refuses a blank tenant instead of falling back to a shared key', () => {
    for (const blank of BLANK_SEGMENTS) {
      expect(() => sessionMutexKey(blank, SESSION)).toThrow('TENANT_CONTEXT_REQUIRED');
      expect(() => sessionTakeoverLockKey(blank, SESSION)).toThrow('TENANT_CONTEXT_REQUIRED');
      expect(() => effectReservationKey(blank, 'effect-1')).toThrow('TENANT_CONTEXT_REQUIRED');
      expect(() => taskLeaseKey(blank, 'run-1')).toThrow('TENANT_CONTEXT_REQUIRED');
      expect(() => rateLimitKey(blank, 'orders', '1m')).toThrow('TENANT_CONTEXT_REQUIRED');
      expect(() => workingMemoryKey(blank, SESSION)).toThrow('TENANT_CONTEXT_REQUIRED');
    }
  });

  it('refuses a blank key segment instead of collapsing callers onto one key', () => {
    for (const blank of BLANK_SEGMENTS) {
      expect(() => sessionMutexKey(TENANT, blank)).toThrow(/REQUIRED/);
      expect(() => sessionTakeoverLockKey(TENANT, blank)).toThrow(/REQUIRED/);
      expect(() => effectReservationKey(TENANT, blank)).toThrow(/REQUIRED/);
      expect(() => taskLeaseKey(TENANT, blank)).toThrow(/REQUIRED/);
      expect(() => rateLimitKey(TENANT, blank, '1m')).toThrow(/REQUIRED/);
      expect(() => rateLimitKey(TENANT, 'orders', blank)).toThrow(/REQUIRED/);
      expect(() => workingMemoryKey(TENANT, blank)).toThrow(/REQUIRED/);
    }
  });

  it('scopes every key to exactly one tenant', () => {
    const keys = [
      sessionMutexKey(TENANT, SESSION),
      sessionTakeoverLockKey(TENANT, SESSION),
      effectReservationKey(TENANT, 'effect-1'),
      taskLeaseKey(TENANT, 'run-1'),
      rateLimitKey(TENANT, 'orders', '1m'),
      workingMemoryKey(TENANT, SESSION),
    ];

    for (const key of keys) {
      expect(key.startsWith(`tenant:${TENANT}:`)).toBe(true);
      expect(key).not.toContain(OTHER_TENANT);
    }
  });

  it('exports only the four approved lease TTLs and no working-memory or rate-limit constant', () => {
    expect(SESSION_MUTEX_TTL_MS).toBe(30_000);
    expect(SESSION_TAKEOVER_LOCK_TTL_MS).toBe(60_000);
    expect(EFFECT_RESERVATION_TTL_SECONDS).toBe(259_200);
    expect(TASK_LEASE_TTL_MS).toBe(30_000);

    const approvedLeaseTtls = new Set<number>([
      SESSION_MUTEX_TTL_MS,
      SESSION_TAKEOVER_LOCK_TTL_MS,
      EFFECT_RESERVATION_TTL_SECONDS,
      TASK_LEASE_TTL_MS,
    ]);
    const numericExports = Object.entries(redis).filter((entry) => typeof entry[1] === 'number');

    // Working-memory retention is ASM-005 and the request rate is ASM-002: both are
    // tenant policy, so an exported numeric constant here would freeze an unapproved
    // value into the package.
    expect(numericExports.filter((entry) => !approvedLeaseTtls.has(Number(entry[1])))).toEqual([]);
    expect(
      numericExports.filter(([name]) => /wm|working.?memory|scratchpad|rate.?limit/i.test(name)),
    ).toEqual([]);
  });
});

describe('session mutex (injected client)', () => {
  it('acquires a free mutex and lets only the owning token release it', async () => {
    const client = new FakeRedisClient();
    const key = sessionMutexKey(TENANT, SESSION);
    const token = 'lock-owner-1';

    await expect(acquireSessionMutex(client, TENANT, SESSION, token)).resolves.toBe(true);

    const acquireCall = client.calls.find((call) => call.command === 'set');
    expect(acquireCall?.key).toBe(key);
    expect(acquireCall?.args).toEqual([token, 'PX', SESSION_MUTEX_TTL_MS, 'NX']);

    await expect(acquireSessionMutex(client, TENANT, SESSION, 'lock-owner-2')).resolves.toBe(false);
    await expect(releaseSessionMutex(client, TENANT, SESSION, 'lock-owner-2')).resolves.toBe(false);
    expect(client.store.has(key)).toBe(true);

    await expect(releaseSessionMutex(client, TENANT, SESSION, token)).resolves.toBe(true);
    expect(client.store.has(key)).toBe(false);
  });

  it('sends a release script that deletes only when the stored token matches', async () => {
    const client = new FakeRedisClient();

    await acquireSessionMutex(client, TENANT, SESSION, 'lock-owner-1');
    await releaseSessionMutex(client, TENANT, SESSION, 'lock-owner-1');

    const releaseCall = client.calls.find((call) => call.command === 'eval');
    expect(releaseCall?.keys).toBe(1);
    expect(releaseCall?.key).toBe(sessionMutexKey(TENANT, SESSION));
    expect(releaseCall?.args).toEqual([sessionMutexKey(TENANT, SESSION), 'lock-owner-1']);

    const script = releaseCall?.script ?? '';
    expect(script).toMatch(/redis\.call\(\s*["']get["']\s*,\s*KEYS\[1\]\s*\)/);
    expect(script).toMatch(/ARGV\[1\]/);
    expect(script).toMatch(/redis\.call\(\s*["']del["']\s*,\s*KEYS\[1\]\s*\)/);
  });

  it('refuses the mutex operations without a tenant, without touching the client', async () => {
    const client = new FakeRedisClient();

    await expect(acquireSessionMutex(client, '   ', SESSION, 'token')).rejects.toThrow(
      'TENANT_CONTEXT_REQUIRED',
    );
    await expect(releaseSessionMutex(client, '', SESSION, 'token')).rejects.toThrow(
      'TENANT_CONTEXT_REQUIRED',
    );

    expect(client.calls).toEqual([]);
  });
});

describe('effect reservation (injected client)', () => {
  it('reserves once, replays the same payload and refuses a different payload', async () => {
    const client = new FakeRedisClient();
    const payload = { orderId: 'ORD-1', amount: '100.00' };

    await expect(reserveEffectKey(client, TENANT, 'effect-1', payload)).resolves.toEqual({
      isNew: true,
      status: 'PENDING',
    });

    const reserveCall = client.calls.find((call) => call.command === 'set');
    expect(reserveCall?.key).toBe(effectReservationKey(TENANT, 'effect-1'));
    expect(reserveCall?.args.slice(1)).toEqual(['EX', EFFECT_RESERVATION_TTL_SECONDS, 'NX']);

    await expect(reserveEffectKey(client, TENANT, 'effect-1', payload)).resolves.toEqual({
      isNew: false,
      status: 'PENDING',
    });

    await expect(
      reserveEffectKey(client, TENANT, 'effect-1', { orderId: 'ORD-2', amount: '100.00' }),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('reserves again once the key has expired', async () => {
    const client = new FakeRedisClient();

    await reserveEffectKey(client, TENANT, 'effect-1', { orderId: 'ORD-1' });
    client.store.delete(effectReservationKey(TENANT, 'effect-1'));

    await expect(reserveEffectKey(client, TENANT, 'effect-1', { orderId: 'ORD-2' })).resolves.toEqual(
      { isNew: true, status: 'PENDING' },
    );
  });

  it('refuses a reservation without a tenant', async () => {
    const client = new FakeRedisClient();

    await expect(reserveEffectKey(client, '', 'effect-1', {})).rejects.toThrow(
      'TENANT_CONTEXT_REQUIRED',
    );
    expect(client.calls).toEqual([]);
  });
});

describe('qdrant knowledge filters', () => {
  it('keeps the collection, namespace and payload-index contract', () => {
    expect(SECOND_BRAIN_COLLECTION).toBe('second_brain_knowledge');
    expect(APPROVED_DOCUMENT_STATUS).toBe('approved');
    expect([...KNOWLEDGE_NAMESPACES].sort()).toEqual([...CANONICAL_NAMESPACES].sort());
    expect([...KNOWLEDGE_PAYLOAD_INDEXES]).toEqual([
      'tenant_id',
      'namespace',
      'document_status',
      'file_path',
    ]);
  });

  it('requires tenant, namespace and approved status for organizational knowledge', () => {
    for (const namespace of KNOWLEDGE_NAMESPACES) {
      const filter = buildOrganizationalKnowledgeFilter({ tenantId: TENANT, namespace });

      expect(filter.must).toHaveLength(3);
      expect(filter.must).toContainEqual({ key: 'tenant_id', match: { value: TENANT } });
      expect(filter.must).toContainEqual({ key: 'namespace', match: { value: namespace } });
      expect(filter.must).toContainEqual({ key: 'document_status', match: { value: 'approved' } });
    }
  });

  it('binds customer knowledge to the same tenant, namespace and approval filter', () => {
    const filter = buildCustomerKnowledgeFilter({
      tenantId: TENANT,
      customerId: 'customer-1',
      namespace: 'customer',
    });

    expect(filter.must).toHaveLength(4);
    expect(filter.must).toContainEqual({ key: 'tenant_id', match: { value: TENANT } });
    expect(filter.must).toContainEqual({ key: 'namespace', match: { value: 'customer' } });
    expect(filter.must).toContainEqual({ key: 'customer_id', match: { value: 'customer-1' } });
    expect(filter.must).toContainEqual({ key: 'document_status', match: { value: 'approved' } });
  });

  it('refuses a filter without a tenant', () => {
    expect(() =>
      buildOrganizationalKnowledgeFilter({ tenantId: '  ', namespace: 'policy' }),
    ).toThrow('TENANT_CONTEXT_REQUIRED');
    expect(() =>
      buildCustomerKnowledgeFilter({ tenantId: '', customerId: 'customer-1', namespace: 'customer' }),
    ).toThrow('TENANT_CONTEXT_REQUIRED');
  });

  it('refuses a customer filter without a customer', () => {
    expect(() =>
      buildCustomerKnowledgeFilter({ tenantId: TENANT, customerId: '   ', namespace: 'customer' }),
    ).toThrow('CUSTOMER_CONTEXT_REQUIRED');
  });

  it('refuses a namespace outside the eight-folder hierarchy', () => {
    expect(() =>
      buildOrganizationalKnowledgeFilter({ tenantId: TENANT, namespace: 'secrets' as never }),
    ).toThrow('KNOWLEDGE_NAMESPACE_INVALID');
    expect(() =>
      buildCustomerKnowledgeFilter({
        tenantId: TENANT,
        customerId: 'customer-1',
        namespace: 'secrets' as never,
      }),
    ).toThrow('KNOWLEDGE_NAMESPACE_INVALID');
  });

  it('exposes no unfiltered search helper and no vector client', () => {
    expect(Object.keys(qdrant).filter((name) => /search|client|query/i.test(name))).toEqual([]);
  });
});
