import {
  Api001ErpConnector,
  ConnectorRegistry,
  createAdapterDispatcher,
  type ConnectorReadResult,
  type ErpCreateOrderInput,
  type ErpCreatedOrder,
  type ErpMutationAuthority,
  type ErpTransportFailureClass,
  type ErpTransportRequest,
  type HmacSha256Hex,
} from '@agentos/adapters';
import type { ExecutionReceipt, IAdapterDispatcher } from '@agentos/core-engine/contracts';
import { OrchestratorError } from '@agentos/core-engine/contracts';

import { createErpHttpTransport, type ErpFetchLike } from './erp-http-transport.js';

/**
 * Connector binding for the worker (`06` §2, §4.2).
 *
 * The worker is the process that reaches a provider, so this module is where a connector id becomes
 * a reachable transport. Two rules are load-bearing:
 *
 * - **Nothing is reachable by default.** The registry starts empty; every id in it was bound here
 *   from explicit configuration. An action naming anything else is refused before a socket opens.
 * - **A mock system of record is a local/CI privilege.** `MOCK_ERP_ENABLED=true` in a managed
 *   environment is allowed only after the tenant registry proves DEMO scope. Binding an env mock
 *   process-wide would let one tenant's connector leak into another tenant's execution.
 */

/** A process environment mock is reachable only after the tenant registry proves DEMO scope. */
export type WorkerTenantDataClass = 'PRODUCTION' | 'DEMO' | 'TEST';

/** The API-001 id a planned step names as its `adapter_target`. */
const API_001_CONNECTOR_ID = 'API-001';

/** Header the mock-erp provider verifies its signature under (`services/mock-erp/src/server.mjs`). */
const MOCK_ERP_SIGNATURE_HEADER = 'x-mock-signature';

/** Header the mock-erp provider reads its tenant scope from. */
const ERP_TENANT_HEADER = 'x-tenant-id';

const DEFAULT_ERP_TIMEOUT_MS = 5_000;

export interface WorkerConnectorEnv {
  readonly APP_ENV?: string;
  readonly WORKER_TENANT_IDS?: string;
  readonly KNOWLEDGE_TENANT_IDS?: string;
  readonly KNOWLEDGE_ROOT?: string;
  readonly MOCK_ERP_ENABLED?: string;
  readonly ERP_API_BASE_URL?: string;
  readonly MOCK_SECRET_KEY?: string;
  readonly QUOTE_SIGNING_SECRET?: string;
  readonly ERP_TIMEOUT_MS?: string;
}

export type ErpCartTransportResult =
  | { readonly ok: true; readonly status: number; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly failure_class: ErpTransportFailureClass; readonly status: number | null };

export interface ErpCartTransport {
  request(input: ErpTransportRequest): Promise<ErpCartTransportResult>;
}

/** Read interface to the authoritative ERP system of record. */
export interface ErpReadPort {
  read(input: {
    readonly tenant_id: string;
    readonly resource: string;
    readonly key?: string;
    readonly customer_id?: string;
    readonly signal?: AbortSignal;
  }): Promise<ConnectorReadResult>;
  reconcile?(input: {
    readonly tenant_id: string;
    readonly effect_key: string;
    readonly action_id?: string;
    readonly adapter_target?: string;
    readonly skill_id?: string;
  }): Promise<{
    readonly outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE';
    readonly receipt?: ExecutionReceipt;
  }>;
  createOrder?(input: ErpCreateOrderInput): Promise<ErpCreatedOrder>;
  /** Authenticated transport for API-002 carts on this tenant's bound ERP endpoint. */
  readonly cart_transport?: ErpCartTransport | undefined;
}

export interface WorkerConnectorOptions {
  /** Tenant class used when explicitly composing the process-env demo fallback. */
  readonly tenantDataClass?: WorkerTenantDataClass | undefined;
  /** HMAC primitive from the host; the adapters package stays crypto-free. */
  readonly hmac: HmacSha256Hex;
  /**
   * Server-side authority for mutating the system of record. It receives identity, never payload:
   * a claim embedded in a draft cannot authorize itself. The default refuses every mutation, so an
   * unbounded authority fails closed rather than sending an unauthorized write.
   */
  readonly authority?: ErpMutationAuthority;
  /** Transport override, used by tests to reach an in-process mock. */
  readonly fetch?: ErpFetchLike;
}
export interface WorkerConnectors {
  readonly registry: ConnectorRegistry;
  /** The engine-facing dispatcher over this registry, with unknown targets refused before transport. */
  readonly dispatcher: IAdapterDispatcher;
  /** Authoritative ERP read boundary when bound; null when no ERP connector is configured. */
  readonly erp_read: ErpReadPort | null;
  /** Connector ids reachable in this process, in registration order. */
  readonly bound: readonly string[];
  /** Capabilities this build does not bind, named for the boot log and the report. */
  readonly unbound: readonly string[];
}

/** Refuses every mutation. Named so a boot log and a report can say which authority is missing. */
export const REFUSE_ALL_MUTATIONS: ErpMutationAuthority = {
  authorize: () => false,
};

/** Keeps DB bindings and the pristine DEMO fallback on the same ERP/cart/order capability surface. */
export function createWorkerErpPort(
  connector: Api001ErpConnector,
  transport: ErpCartTransport,
): ErpReadPort {
  return {
    read: (input) => connector.read(input),
    reconcile: (input) => connector.reconcile(input),
    createOrder: (input) => connector.createOrder(input),
    cart_transport: transport,
  };
}

/**
 * Composes an environment connector for one explicitly authorized tenant class.
 *
 * Process-wide callers must omit `tenantDataClass`; the environment mock is then unreachable.
 * The tenant registry supplies `DEMO` only after checking the tenant's immutable data class.
 *
 * @param env Process environment; only {@link WorkerConnectorEnv} is read.
 * @param options Host-supplied HMAC, authority, transport and tenant-class gate.
 * @returns The registry, its dispatcher and the named unbound capabilities.
 * @throws Error when a DEMO fallback is enabled without a valid provider location or shared secret.
 */
export function createWorkerConnectors(
  env: WorkerConnectorEnv,
  options: WorkerConnectorOptions,
): WorkerConnectors {
  const mock_requested = env.MOCK_ERP_ENABLED === 'true';
  const mock_enabled = mock_requested && options.tenantDataClass === 'DEMO';
  const registry = new ConnectorRegistry();
  let erp_read: ErpReadPort | null = null;
  const bound: string[] = [];
  const unbound: string[] = [];

  if (mock_enabled) {
    const base_url = env.ERP_API_BASE_URL;
    const secret = env.MOCK_SECRET_KEY;

    if (base_url === undefined || base_url.length === 0) {
      throw new Error(
        'ERP_API_BASE_URL_REQUIRED: MOCK_ERP_ENABLED=true without ERP_API_BASE_URL would leave the connector unreachable at dispatch time',
      );
    }
    if (secret === undefined || secret.length < 16) {
      throw new Error(
        'MOCK_SECRET_KEY_REQUIRED: MOCK_ERP_ENABLED=true needs the shared provider secret (at least 16 characters); the refusal never prints its value',
      );
    }

    const transport = createErpHttpTransport({
      base_url,
      hmac_secret: secret,
      hmac: options.hmac,
      timeout_ms: parseTimeout(env.ERP_TIMEOUT_MS),
      tenant_header: ERP_TENANT_HEADER,
      signature_header: MOCK_ERP_SIGNATURE_HEADER,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });

    // This instance is exposed only to the tenant registry after DEMO data-class resolution.
    const connector = new Api001ErpConnector({
      transport,
      authority: options.authority ?? REFUSE_ALL_MUTATIONS,
    });

    registry.register({
      descriptor: {
        connector_id: API_001_CONNECTOR_ID,
        kind: 'SYSTEM_OF_RECORD',
        provider: 'mock-erp (local/ci only)',
        read_resources: [],
      },
      dispatch: (draft, options) => connector.dispatch(draft, options),
      read: (input) => connector.read(input),
      reconcile: (input) => connector.reconcile(input),
    });
    bound.push(API_001_CONNECTOR_ID);
    erp_read = createWorkerErpPort(connector, transport);
    if (options.authority === undefined) {
      unbound.push(
        'API-001 mutation authority: no approval-backed authority is bound, so every dispatch is refused before the provider is contacted',
      );
    }
  } else {
    const reason = mock_requested && options.tenantDataClass !== 'DEMO'
      ? 'process environment mock is restricted to DEMO tenant data'
      : 'MOCK_ERP_ENABLED is not true, and no audited provider transport is configured';
    unbound.push(`API-001: no system of record is bound (${reason})`);
  }

  const dispatcher = createAdapterDispatcher({
    registry,
    // The owning layer's error vocabulary (`04` §4.2): the engine must see a connector refusal as a
    // planning failure, not as a transport error it might retry.
    refuseUnknownTarget: (connector_id) =>
      new OrchestratorError(
        'CONNECTOR_NOT_FOUND',
        `no connector is registered for adapter_target ${connector_id}; the action is not dispatched`,
      ),
  });

  return { registry, dispatcher, erp_read, bound, unbound };
}

/** Reads the request deadline; an unparseable value is refused rather than silently defaulted. */
function parseTimeout(value: string | undefined): number {
  if (value === undefined || value === '') return DEFAULT_ERP_TIMEOUT_MS;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error('ERP_TIMEOUT_MS_INVALID: ERP_TIMEOUT_MS must be a positive integer');
  }

  return parsed;
}
