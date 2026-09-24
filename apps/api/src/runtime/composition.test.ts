import { describe, expect, it } from 'vitest';

import type { RedisInjectedClient } from '@agentos/database';

import { createGatewayComposition, UnboundPortError } from './composition.js';

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
  it('refuses intake and decisions without a worker execution graph', async () => {
    const composition = createGatewayComposition(ENV, { redis: EMPTY_REDIS });

    expect(composition.unbound).toEqual(['runs.reconcile', 'approvals.decide']);
    expect(composition.unbound).not.toContain('runs.start');
    expect(composition.unbound).not.toContain('runs.read');
    expect(composition.unbound).not.toContain('runs.list');
    expect(composition.unbound).not.toContain('approvals.list');
    expect(composition.unbound).not.toContain('identity.resolveCustomer');
    expect(composition.unbound).not.toContain('takeover.acquire/renew/release/holder');

    await expect(
      composition.runtime.identity.resolveCustomer({
        tenant_id: 'tenant-a',
        session_id: 'session-a',
        channel_type: 'WEB_CHAT',
      }),
    ).resolves.toEqual({ customer_id: null, verdict: 'UNRESOLVED' });
    await expect(composition.runtime.takeover.holder('tenant-a', 'conversation-a')).resolves.toBeNull();

    await expect(
      composition.runtime.approvals.decide({
        tenant_id: 'tenant-a',
        approval_id: 'approval-a',
        run_id: 'run-a',
        effect_key: 'effect-a',
        expected_payload_sha256: 'a'.repeat(64),
        decision: 'APPROVE',
        operator_id: 'operator-a',
        reason: 'approved',
      }),
    ).rejects.toBeInstanceOf(UnboundPortError);

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
