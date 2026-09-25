import { once } from 'node:events';
import type { Server } from 'node:http';

import { describe, expect, it } from 'vitest';

import type { ActionDraft, ExecutionReceipt, IAdapterDispatcher } from '@agentos/core-engine/contracts';
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
async function startMockErp(
  envOverrides: Record<string, string> = {},
): Promise<{ readonly server: Server; readonly base_url: string }> {
  const server = mockErp.createServer({
    APP_ENV: 'local',
    MOCK_SECRET_KEY: SECRET,
    SIMULATE_LATENCY_MS: '0',
    SIMULATE_FAILURE_RATE: '0',
    ...envOverrides,
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

interface ProviderReconcileResult {
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE';
  readonly receipt?: ExecutionReceipt;
}

type BoundReconcile = (input: {
  readonly tenant_id: string;
  readonly effect_key: string;
  readonly action_id?: string;
  readonly adapter_target?: string;
  readonly skill_id?: string;
}) => Promise<ProviderReconcileResult>;

/**
 * Asserts the dispatcher has a bound reconcile function and types the provider receipt result.
 */
function assertBoundReconcile(dispatcher: IAdapterDispatcher): BoundReconcile {
  expect(dispatcher.reconcile).toBeDefined();
  if (typeof dispatcher.reconcile !== 'function') {
    throw new Error('dispatcher.reconcile is not defined on bound connectors');
  }
  return dispatcher.reconcile.bind(dispatcher) as BoundReconcile;
}

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

  it('reconciles a swallowed action write via provider GET and returns the authentic provider reference', async () => {
    // Simulate a dropped response after the mock system of record records the mutation write
    const { server, base_url } = await startMockErp({ SIMULATE_SWALLOW_AFTER_WRITE: '1' });
    try {
      const connectors = createWorkerConnectors(
        { ...LOCAL_ENV, ERP_API_BASE_URL: base_url },
        { hmac: nodeHmacSha256Hex, authority: { authorize: () => true } },
      );
      const reconcile = assertBoundReconcile(connectors.dispatcher);

      const actionDraft = draft({
        action_id: '33333333-3333-4333-8333-333333333333',
        effect_key: 'effect-swallowed-post',
      });

      // The initial POST mutation writes into mock-erp, but the response is swallowed (504 UNKNOWN)
      const dispatchReceipt = await connectors.dispatcher.dispatch(actionDraft);
      expect(dispatchReceipt.adapter_status).toBe('TIMEOUT');
      expect(dispatchReceipt.provider_reference).toBeNull();
      expect(dispatchReceipt.response_payload).toMatchObject({
        failure_class: 'UNKNOWN',
        provider_status: 504,
      });

      // Provider-proof reconciliation: dispatcher.reconcile queries GET /api/v1/actions/{action_id}.
      // The provider confirms the action was recorded, proving success and providing the durable reference.
      const reconciled = await reconcile({
        tenant_id: actionDraft.tenant_id,
        effect_key: actionDraft.effect_key,
        action_id: actionDraft.action_id,
      });

      expect(reconciled.outcome).toBe('SUCCEEDED');
      expect(reconciled.receipt).toBeDefined();
      expect(reconciled.receipt?.adapter_status).toBe('SUCCESS');
      expect(reconciled.receipt?.provider_reference).toBe(
        `MOCK-ERP:${TENANT}:${actionDraft.action_id}`,
      );
      expect(reconciled.receipt?.execution_id).toBe(`API-001:${actionDraft.action_id}:reconciled`);
      expect(reconciled.receipt?.response_payload).toMatchObject({
        provider_status: 200,
        reconciled: true,
        provider_envelope: {
          action_id: actionDraft.action_id,
          tenant_id: TENANT,
          status: 'accepted',
          provider_reference: `MOCK-ERP:${TENANT}:${actionDraft.action_id}`,
        },
      });
      // The receipt is strictly from the provider GET response — no operator receipt path
      expect(reconciled.receipt).not.toHaveProperty('operator_receipt');
    } finally {
      server.close();
    }
  });

  it('reconciles an unknown action via provider GET and returns FAILED/absence without an operator receipt', async () => {
    const { server, base_url } = await startMockErp();
    try {
      const connectors = createWorkerConnectors(
        { ...LOCAL_ENV, ERP_API_BASE_URL: base_url },
        { hmac: nodeHmacSha256Hex, authority: { authorize: () => true } },
      );
      const reconcile = assertBoundReconcile(connectors.dispatcher);

      // Reconciling an action that was never dispatched to the provider
      const absent = await reconcile({
        tenant_id: TENANT,
        effect_key: 'effect-never-dispatched',
        action_id: '44444444-4444-4444-8444-444444444444',
      });

      // Provider confirms 404 absence: outcome is FAILED, and no operator receipt is created or returned
      expect(absent.outcome).toBe('FAILED');
      expect(absent.receipt).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it('enforces tenant scoping on provider reconciliation and rejects cross-tenant or unscoped attempts', async () => {
    const { server, base_url } = await startMockErp();
    try {
      const connectors = createWorkerConnectors(
        { ...LOCAL_ENV, ERP_API_BASE_URL: base_url },
        { hmac: nodeHmacSha256Hex, authority: { authorize: () => true } },
      );
      const reconcile = assertBoundReconcile(connectors.dispatcher);

      const actionDraft = draft({
        action_id: '55555555-5555-4555-8555-555555555555',
        effect_key: 'effect-tenant-scoped',
        tenant_id: TENANT,
      });

      // Successfully dispatch an action under tenant A
      const dispatchReceipt = await connectors.dispatcher.dispatch(actionDraft);
      expect(dispatchReceipt.adapter_status).toBe('SUCCESS');

      // Tenant A can reconcile its own action
      const ownReconciled = await reconcile({
        tenant_id: TENANT,
        effect_key: actionDraft.effect_key,
        action_id: actionDraft.action_id,
      });
      expect(ownReconciled.outcome).toBe('SUCCEEDED');
      expect(ownReconciled.receipt?.provider_reference).toBe(
        `MOCK-ERP:${TENANT}:${actionDraft.action_id}`,
      );

      // Tenant B querying the same action_id must observe absence (FAILED) due to tenant isolation in the provider
      const otherTenant = '00000000-0000-4000-8000-000000000002';
      const crossTenant = await reconcile({
        tenant_id: otherTenant,
        effect_key: actionDraft.effect_key,
        action_id: actionDraft.action_id,
      });
      expect(crossTenant.outcome).toBe('FAILED');
      expect(crossTenant.receipt).toBeUndefined();

      // An unscoped reconciliation request (empty tenant_id) is refused fail-closed before transport
      await expect(
        reconcile({
          tenant_id: '',
          effect_key: actionDraft.effect_key,
          action_id: actionDraft.action_id,
        }),
      ).rejects.toBeInstanceOf(ErpRefusalError);
      await expect(
        reconcile({
          tenant_id: '',
          effect_key: actionDraft.effect_key,
          action_id: actionDraft.action_id,
        }),
      ).rejects.toThrow(/TENANT_UNSCOPED/);
    } finally {
      server.close();
    }
  });

  it('preserves fail-closed indeterminate outcome when provider reconciliation is inconclusive', async () => {
    // 100% failure rate causes mock-erp to return 504 UNKNOWN on GET
    const { server, base_url } = await startMockErp({ SIMULATE_FAILURE_RATE: '1' });
    try {
      const connectors = createWorkerConnectors(
        { ...LOCAL_ENV, ERP_API_BASE_URL: base_url },
        { hmac: nodeHmacSha256Hex, authority: { authorize: () => true } },
      );
      const reconcile = assertBoundReconcile(connectors.dispatcher);

      const indeterminate = await reconcile({
        tenant_id: TENANT,
        effect_key: 'effect-inconclusive',
        action_id: '66666666-6666-4666-8666-666666666666',
      });

      expect(indeterminate.outcome).toBe('INDETERMINATE');
      expect(indeterminate.receipt).toBeUndefined();
    } finally {
      server.close();
    }
  });
});
