import { describe, expect, it } from 'vitest';

import type { RedisInjectedClient } from '@agentos/database';

import { createGatewayComposition } from './composition.js';

const ENV = {
  SESSION_SECRET: 'test-session-secret-000000',
  PLATFORM_SECRET: 'test-platform-secret-00000',
};

const EMPTY_REDIS: RedisInjectedClient = {
  set: async () => null,
  get: async () => null,
  pttl: async () => -2,
  eval: async () => 0,
};

describe('createGatewayComposition', () => {
  it('binds durable intake and approval decisions without Redis', async () => {
    const composition = createGatewayComposition(ENV, { redis: EMPTY_REDIS });

    expect(composition.unbound).not.toContain('runs.reconcile');
    expect(composition.unbound).not.toContain('approvals.decide');
    expect(composition.unbound).not.toContain('runs.start');
    expect(composition.unbound).not.toContain('runs.read');
    expect(composition.unbound).not.toContain('runs.list');
    expect(composition.unbound).not.toContain('approvals.list');
    expect(composition.unbound).not.toContain('identity.resolveCustomer');
    expect(composition.unbound).not.toContain('takeover.acquire/renew/release/holder');

    expect(composition.runtime.runs.reconcile).toBeTypeOf('function');
    expect(composition.runtime.approvals.decide).toBeTypeOf('function');

    await composition.close();
  });

  it('keeps takeover fail-closed when no Redis store is configured', async () => {
    const composition = createGatewayComposition(ENV);

    expect(composition.unbound).toContain('takeover.acquire/renew/release/holder');
    await expect(composition.runtime.takeover.holder('tenant-a', 'conversation-a')).rejects.toMatchObject({
      port: 'takeover.holder',
      name: 'UnboundPortError',
    });

    await composition.close();
  });
});
