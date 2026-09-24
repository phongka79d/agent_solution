import { once } from 'node:events';
import type { Server } from 'node:http';

import { describe, expect, it } from 'vitest';

import type { ActionDraft } from '@agentos/core-engine/contracts';
import { ErpRefusalError } from '@agentos/adapters';

import { createWorkerConnectors, REFUSE_ALL_MUTATIONS } from './connectors.js';
import { nodeHmacSha256Hex } from './hmac.js';

/**
 * The real mock-erp service, loaded as JavaScript: it is the local/CI system of record this worker
 * is configured against, and exercising it over HTTP is what makes this an integration test rather
 * than a registry assertion.
 *
 * A static import cannot express this: the module is a `.mjs` service outside this package's
 * `rootDir`, untyped and never emitted by `tsc`, so the specifier is resolved from `import.meta.url`
 * — the same pattern the API boot uses for its own `.mjs` boot modules.
 */
interface MockErpModule {
  createServer(
    env: Record<string, string>,
    deps?: Record<string, unknown>,
  ): Server & { address(): { port: number } | null };
}

const MOCK_ERP_MODULE = new URL('../../../../services/mock-erp/src/server.mjs', import.meta.url).href;
const mockErp = (await import(MOCK_ERP_MODULE)) as MockErpModule;

const SECRET = 'worker-mock-erp-secret-value-1234';
const TENANT = '00000000-0000-4000-8000-000000000001';

/** A local/CI provider the worker may reach. */
async function startMockErp(): Promise<{ readonly server: Server; readonly base_url: string }> {
  const server = mockErp.createServer({
    APP_ENV: 'local',
    MOCK_SECRET_KEY: SECRET,
    SIMULATE_LATENCY_MS: '0',
    SIMULATE_FAILURE_RATE: '0',
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('mock-erp did not bind a TCP port');
  }

  return { server, base_url: `http://127.0.0.1:${address.port}/api/v1` };
}

/** A draft as the orchestrator's dispatch guard would hand it over (`04` §4.2). */
function draft(overrides: Partial<ActionDraft> = {}): ActionDraft {
  return {
    action_id: '11111111-1111-4111-8111-111111111111',
    run_id: '22222222-2222-4222-8222-222222222222',
    tenant_id: TENANT,
    agent_id: 'SALES_ORCHESTRATOR',
    skill_id: 'sales.offer',
    adapter_target: 'API-001',
    step_index: 0,
    mutating: true,
    price_bearing: true,
    request_id: 'req-1',
    action_revision: 0,
    effect_key: 'effect-abc',
    required_authority: 'AUTH-3',
    payload: { tenant_id: TENANT, sku_id: 'SKU-LOCAL-1' },
    ...overrides,
  } as ActionDraft;
}

const LOCAL_ENV = {
  APP_ENV: 'local',
  MOCK_ERP_ENABLED: 'true',
  ERP_API_BASE_URL: 'http://placeholder.invalid/api/v1',
  MOCK_SECRET_KEY: SECRET,
};

describe('createWorkerConnectors', () => {
  it('reaches the local system of record through the registered API-001 connector', async () => {
    const { server, base_url } = await startMockErp();
    try {
      const connectors = createWorkerConnectors(
        { ...LOCAL_ENV, ERP_API_BASE_URL: base_url },
        { hmac: nodeHmacSha256Hex, authority: { authorize: () => true } },
      );

      const receipt = await connectors.dispatcher.dispatch(draft());

      expect(connectors.bound).toEqual(['API-001']);
      expect(receipt.adapter_status).toBe('SUCCESS');
      expect(receipt.provider_reference).toBe(`MOCK-ERP:${TENANT}:11111111-1111-4111-8111-111111111111`);
    } finally {
      server.close();
    }
  });

  it('refuses a target that is not registered before any transport call', async () => {
    const connectors = createWorkerConnectors(LOCAL_ENV, {
      hmac: nodeHmacSha256Hex,
      authority: { authorize: () => true },
      fetch: () => Promise.reject(new Error('the transport must not be reached')),
    });

    await expect(
      connectors.dispatcher.dispatch(draft({ adapter_target: 'API-999' })),
    ).rejects.toThrow(/CONNECTOR_NOT_FOUND/);
  });

  it('refuses a mutation when no server-side authority is bound', async () => {
    const connectors = createWorkerConnectors(LOCAL_ENV, {
      hmac: nodeHmacSha256Hex,
      fetch: () => Promise.reject(new Error('the transport must not be reached')),
    });

    expect(connectors.unbound.join(' ')).toMatch(/mutation authority/);
    await expect(connectors.dispatcher.dispatch(draft())).rejects.toBeInstanceOf(ErpRefusalError);
    expect(REFUSE_ALL_MUTATIONS.authorize({ tenant_id: TENANT, connector_id: 'API-001', operation: 'x', effect_key: 'y' })).toBe(false);
  });

  it('refuses a mock system of record in a managed environment', () => {
    for (const app_env of ['staging', 'sandbox', 'production']) {
      expect(() =>
        createWorkerConnectors({ ...LOCAL_ENV, APP_ENV: app_env }, { hmac: nodeHmacSha256Hex }),
      ).toThrow(/MOCK_ERP_FORBIDDEN/);
    }
  });

  it('refuses an enabled mock without the provider location or shared secret', () => {
    const incomplete: readonly Record<string, string>[] = [
      { ...LOCAL_ENV, ERP_API_BASE_URL: '' },
      { ...LOCAL_ENV, MOCK_SECRET_KEY: 'too-short' },
    ];

    for (const env of incomplete) {
      expect(() => createWorkerConnectors(env, { hmac: nodeHmacSha256Hex })).toThrow(/REQUIRED/);
    }
  });

  it('binds nothing when no provider is configured, and names what is missing', async () => {
    const connectors = createWorkerConnectors({ APP_ENV: 'ci' }, { hmac: nodeHmacSha256Hex });

    expect(connectors.bound).toEqual([]);
    expect(connectors.erp_read).toBeNull();
    expect(connectors.unbound).toHaveLength(1);
    expect(connectors.unbound[0]).toMatch(/API-001/);
    await expect(connectors.dispatcher.dispatch(draft())).rejects.toThrow(/CONNECTOR_NOT_FOUND/);
  });

  it('exposes erp_read which performs signed read against the provider', async () => {
    const { server, base_url } = await startMockErp();
    try {
      const connectors = createWorkerConnectors(
        { ...LOCAL_ENV, ERP_API_BASE_URL: base_url, CARE_KNOWLEDGE_ROOT: '/custom/root' },
        { hmac: nodeHmacSha256Hex, authority: { authorize: () => true } },
      );

      expect(connectors.erp_read).not.toBeNull();
      const result = await connectors.erp_read!.read({
        tenant_id: '11111111-1111-1111-1111-111111111111',
        resource: 'orders',
        key: 'ORD-A-1',
      });

      expect(result.resource).toBe('orders');
      expect(result.observed_at).toBeDefined();
      expect(result.value.order_id).toBe('ORD-A-1');
      expect(result.value.customer_id).toBe('aaaaaaaa-0000-4000-8000-00000000000a');
      expect(result.value.logical_customer_ref).toBe('cust-a');
    } finally {
      server.close();
    }
  });
});
