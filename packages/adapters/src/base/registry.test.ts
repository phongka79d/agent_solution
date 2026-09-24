import { describe, expect, it } from 'vitest';

import type { ActionDraft, ExecutionReceipt } from '@agentos/core-engine/contracts';

import type {
  ErpMutationAuthority,
  ErpTransport,
  ErpTransportFailureClass,
} from '../erp/api-001-erp.js';
import {
  Api001ErpConnector,
  ERP_ACTION_PATH_TEMPLATE,
  ERP_READ_RESOURCES,
  ERP_RESOURCE_ROUTES,
  ErpRefusalError,
} from '../erp/api-001-erp.js';
import type { ConnectorDescriptor, RegisteredConnector } from './registry.js';
import { ConnectorRegistry, DuplicateConnectorError, UnknownConnectorError } from './registry.js';

/** One host-side call the transport double observed. */
interface RecordedCall {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: Record<string, unknown>;
}

/** Transport answers the double replays in order; the last one repeats. */
type TransportOutcome =
  | { readonly ok: true; readonly status: number; readonly body: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly failure_class: ErpTransportFailureClass;
      readonly status: number | null;
    };

/** Offline transport double: records every call, answers from the queued outcomes. */
function createTransportDouble(outcomes: readonly TransportOutcome[]): {
  readonly transport: ErpTransport;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let served = 0;
  return {
    calls,
    transport: {
      async request(input) {
        calls.push({
          method: input.method,
          path: input.path,
          ...(input.body === undefined ? {} : { body: input.body }),
        });
        const outcome = outcomes[Math.min(served, outcomes.length - 1)];
        served += 1;
        if (outcome === undefined) {
          throw new Error('transport double was called with no outcome queued');
        }
        return outcome;
      },
    },
  };
}

/** What the authority double saw; recorded so a payload leak into authorization is detectable. */
interface RecordedAuthorization {
  readonly tenant_id: string;
  readonly connector_id: string;
  readonly operation: string;
  readonly effect_key: string;
}

/** Authority double that answers with a fixed verdict and records its inputs. */
function createAuthorityDouble(authorized: boolean): {
  readonly authority: ErpMutationAuthority;
  readonly inputs: RecordedAuthorization[];
} {
  const inputs: RecordedAuthorization[] = [];
  return {
    inputs,
    authority: {
      authorize(input) {
        inputs.push({ ...input });
        return authorized;
      },
    },
  };
}

/** Captures a synchronous throw without a cast, so the guard checks the real class. */
function captureSync(run: () => unknown): unknown {
  try {
    run();
    return null;
  } catch (caught) {
    return caught;
  }
}

/** Captures an async rejection without a cast. */
async function captureRejection(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
    return null;
  } catch (caught) {
    return caught;
  }
}

const descriptor: ConnectorDescriptor = {
  connector_id: 'API-001',
  kind: 'SYSTEM_OF_RECORD',
  provider: 'erp-vendor-fixture [UNCONFIRMED][ASM-001]',
  read_resources: ERP_READ_RESOURCES,
};

/** Minimal registered connector; behavior is irrelevant to the binding-table tests. */
function createFakeConnector(connector_id: string): RegisteredConnector {
  return {
    descriptor: { ...descriptor, connector_id },
    async dispatch(draft: ActionDraft): Promise<ExecutionReceipt> {
      return {
        execution_id: `${connector_id}:${draft.action_id}`,
        adapter_status: 'SUCCESS',
        provider_reference: null,
        response_payload: {},
        latency_ms: 0,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      };
    },
  };
}

const draft: ActionDraft = {
  action_id: '2f1c4f8e-6a5b-4f2e-9d3a-1b7c8e0f4a21',
  run_id: 'run-fixture',
  tenant_id: 'tenant-fixture',
  agent_id: 'CS-01',
  skill_id: 'order-status-write',
  adapter_target: 'API-001',
  step_index: 0,
  mutating: true,
  price_bearing: false,
  request_id: 'request-fixture',
  action_revision: 0,
  effect_key: 'effect-fixture',
  required_authority: 'AUTH-4',
  // `approval_id` here is an attacker-controllable claim, not platform state: authorization must
  // never consult it.
  payload: { order_id: 'SO-1001', approval_id: 'APV-CLAIMED-IN-PAYLOAD' },
};

describe('ConnectorRegistry', () => {
  it('refuses an unregistered connector id and carries the id on the error', () => {
    const registry = new ConnectorRegistry();
    registry.register(createFakeConnector('API-001'));

    const caught = captureSync(() => registry.resolve('API-999'));

    expect(caught).toBeInstanceOf(UnknownConnectorError);
    if (!(caught instanceof UnknownConnectorError)) {
      throw new Error('expected an UnknownConnectorError');
    }
    expect(caught.connector_id).toBe('API-999');
    expect(registry.has('API-999')).toBe(false);
  });

  it('resolves nothing from an empty registry — there is no default connector', () => {
    const registry = new ConnectorRegistry();

    expect(registry.has('API-001')).toBe(false);
    expect(registry.ids()).toEqual([]);
    expect(captureSync(() => registry.resolve('API-001'))).toBeInstanceOf(UnknownConnectorError);
  });

  it('refuses a duplicate connector id', () => {
    const registry = new ConnectorRegistry();
    registry.register(createFakeConnector('API-001'));

    const caught = captureSync(() => registry.register(createFakeConnector('API-001')));

    expect(caught).toBeInstanceOf(DuplicateConnectorError);
    if (!(caught instanceof DuplicateConnectorError)) {
      throw new Error('expected a DuplicateConnectorError');
    }
    expect(caught.connector_id).toBe('API-001');
    // The first binding survives: a collision never silently re-points an authorized target.
    expect(registry.resolve('API-001').descriptor.connector_id).toBe('API-001');
  });

  it('lists ids in insertion order', () => {
    const registry = new ConnectorRegistry();
    registry.register(createFakeConnector('API-003'));
    registry.register(createFakeConnector('API-001'));
    registry.register(createFakeConnector('ADPT-GL-002'));

    expect(registry.ids()).toEqual(['API-003', 'API-001', 'ADPT-GL-002']);
  });
});

describe('Api001ErpConnector', () => {
  it('declares exactly the eight API-001 read groups and a route for each', () => {
    expect(ERP_READ_RESOURCES).toEqual([
      'products',
      'prices',
      'inventory',
      'orders',
      'invoices',
      'customers',
      'shipments',
      'returns',
    ]);
    expect(Object.keys(ERP_RESOURCE_ROUTES).sort()).toEqual([...ERP_READ_RESOURCES].sort());
    expect(ERP_RESOURCE_ROUTES.products).toEqual({ method: 'GET', path: '/api/v1/catalog/items' });
  });

  it('refuses an unknown read resource without touching the transport', async () => {
    const { transport, calls } = createTransportDouble([
      { ok: true, status: 200, body: { snapshot_at: '2026-09-22T00:00:00.000Z' } },
    ]);
    const connector = new Api001ErpConnector({
      transport,
      authority: createAuthorityDouble(true).authority,
    });

    const caught = await captureRejection(() =>
      connector.read({ tenant_id: 'tenant-fixture', resource: 'payroll' }),
    );

    expect(caught).toBeInstanceOf(ErpRefusalError);
    if (!(caught instanceof ErpRefusalError)) {
      throw new Error('expected an ErpRefusalError');
    }
    expect(caught.refusal_code).toBe('UNKNOWN_RESOURCE');
    expect(calls).toHaveLength(0);
  });

  it('refuses a failed read and never yields a value', async () => {
    const indeterminate = createTransportDouble([
      { ok: false, failure_class: 'TIMEOUT', status: null },
    ]);
    const rejected = createTransportDouble([
      { ok: false, failure_class: 'PROVIDER_REJECTED', status: 422 },
    ]);

    const timeoutError = await captureRejection(() =>
      new Api001ErpConnector({
        transport: indeterminate.transport,
        authority: createAuthorityDouble(true).authority,
      }).read({ tenant_id: 'tenant-fixture', resource: 'inventory' }),
    );
    const rejectedError = await captureRejection(() =>
      new Api001ErpConnector({
        transport: rejected.transport,
        authority: createAuthorityDouble(true).authority,
      }).read({ tenant_id: 'tenant-fixture', resource: 'inventory' }),
    );

    expect(timeoutError).toBeInstanceOf(ErpRefusalError);
    expect(rejectedError).toBeInstanceOf(ErpRefusalError);
    if (!(timeoutError instanceof ErpRefusalError) || !(rejectedError instanceof ErpRefusalError)) {
      throw new Error('expected ErpRefusalError for both failed reads');
    }
    // An unconfirmed outcome and a confirmed rejection are different refusals: only the second is
    // known to be side-effect-free.
    expect(timeoutError.refusal_code).toBe('INDETERMINATE_OUTCOME');
    expect(rejectedError.refusal_code).toBe('PROVIDER_REJECTED');
    expect(indeterminate.calls).toHaveLength(1);
    expect(rejected.calls).toHaveLength(1);
  });

  it('maps inventory keys to the API-001 tenant-scoped SKU lookup DTO', async () => {
    const { transport, calls } = createTransportDouble([
      {
        ok: true,
        status: 200,
        body: {
          snapshot_at: '2026-09-22T01:02:03.000Z',
          tenant_id: 'tenant-fixture',
          items: [{ sku_id: 'SKU-1', tenant_id: 'tenant-fixture', total_available_to_promise: 7 }],
        },
      },
    ]);
    const connector = new Api001ErpConnector({ transport, authority: createAuthorityDouble(true).authority });

    const result = await connector.read({ tenant_id: 'tenant-fixture', resource: 'inventory', key: 'SKU-1' });

    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/v1/inventory/lookup',
        body: { tenant_id: 'tenant-fixture', sku_ids: ['SKU-1'] },
      },
    ]);
    expect(result.value).toEqual({
      snapshot_at: '2026-09-22T01:02:03.000Z',
      tenant_id: 'tenant-fixture',
      items: [{ sku_id: 'SKU-1', tenant_id: 'tenant-fixture', total_available_to_promise: 7 }],
    });
    expect(result.observed_at).toBe('2026-09-22T01:02:03.000Z');
  });

  it('refuses a dispatch with no server-side authority without touching the transport', async () => {
    const { transport, calls } = createTransportDouble([
      { ok: true, status: 200, body: { document_number: 'SO-1001' } },
    ]);
    const authorityDouble = createAuthorityDouble(false);
    const connector = new Api001ErpConnector({
      transport,
      authority: authorityDouble.authority,
    });

    const caught = await captureRejection(() => connector.dispatch(draft));

    expect(caught).toBeInstanceOf(ErpRefusalError);
    if (!(caught instanceof ErpRefusalError)) {
      throw new Error('expected an ErpRefusalError');
    }
    expect(caught.refusal_code).toBe('AUTHORITY_ABSENT');
    expect(calls).toHaveLength(0);
    // The claim embedded in `payload` never reaches authorization: only identity and the effect key
    // are visible to it, so an approval claim cannot buy an effect.
    expect(authorityDouble.inputs).toHaveLength(1);
    const authorization = authorityDouble.inputs[0];
    expect(Object.keys(authorization ?? {}).sort()).toEqual([
      'connector_id',
      'effect_key',
      'operation',
      'tenant_id',
    ]);
    expect(authorization?.connector_id).toBe('API-001');
    expect(authorization?.tenant_id).toBe('tenant-fixture');
    expect(authorization?.effect_key).toBe(draft.effect_key);
    expect(authorization?.operation).toBe(draft.action_id);
  });

  it('reaches the provider exactly once for an authorized dispatch', async () => {
    const { transport, calls } = createTransportDouble([
      {
        ok: true,
        status: 201,
        body: { document_number: 'SO-1001', accepted: true },
      },
    ]);
    const connector = new Api001ErpConnector({
      transport,
      authority: createAuthorityDouble(true).authority,
    });

    const receipt = await connector.dispatch(draft);

    expect(calls).toEqual([
      { method: 'POST', path: ERP_ACTION_PATH_TEMPLATE.replace('{action_id}', draft.action_id) },
    ]);
    expect(receipt.adapter_status).toBe('SUCCESS');
    expect(receipt.execution_id).toBe(`API-001:${draft.action_id}:${draft.action_revision}`);
    // A success claim carries the provider's own durable reference.
    expect(receipt.provider_reference).toBe('SO-1001');
    expect(receipt.response_payload.provider_status).toBe(201);
  });

  it('never claims success when the provider outcome is unconfirmed', async () => {
    const { transport, calls } = createTransportDouble([
      { ok: false, failure_class: 'UNKNOWN', status: null },
    ]);
    const connector = new Api001ErpConnector({
      transport,
      authority: createAuthorityDouble(true).authority,
    });

    const receipt = await connector.dispatch(draft);

    expect(calls).toHaveLength(1);
    expect(receipt.adapter_status).toBe('TIMEOUT');
    expect(receipt.provider_reference).toBeNull();
    expect(receipt.response_payload.failure_class).toBe('UNKNOWN');
  });
});
