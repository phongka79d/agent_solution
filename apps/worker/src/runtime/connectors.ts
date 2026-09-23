import {
  Api001ErpConnector,
  ConnectorRegistry,
  createAdapterDispatcher,
  type ConnectorReadResult,
  type ErpMutationAuthority,
  type HmacSha256Hex,
} from '@agentos/adapters';
import type { IAdapterDispatcher } from '@agentos/core-engine/contracts';
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
 *   environment (`staging`, `sandbox`, `production`) is refused at composition instead of quietly
 *   letting a deployment read inventory and write orders against a fictional provider. The mock-erp
 *   container refuses the same combination, so neither side can be the one that forgets.
 */

/** Environments where a provider is real: a mock system of record may never be bound. */
const MANAGED_ENVS: readonly string[] = ['staging', 'sandbox', 'production'];

/** The API-001 id a planned step names as its `adapter_target`. */
const API_001_CONNECTOR_ID = 'API-001';

/** Header the mock-erp provider verifies its signature under (`services/mock-erp/src/server.mjs`). */
const MOCK_ERP_SIGNATURE_HEADER = 'x-mock-signature';

/** Header the mock-erp provider reads its tenant scope from. */
const ERP_TENANT_HEADER = 'x-tenant-id';

const DEFAULT_ERP_TIMEOUT_MS = 5_000;

export interface WorkerConnectorEnv {
  readonly APP_ENV?: string;
  readonly CARE_TENANT_IDS?: string;
  readonly CARE_KNOWLEDGE_ROOT?: string;
  readonly MOCK_ERP_ENABLED?: string;
  readonly ERP_API_BASE_URL?: string;
  readonly MOCK_SECRET_KEY?: string;
  readonly ERP_TIMEOUT_MS?: string;
}

/** Read interface to the authoritative ERP system of record. */
export interface ErpReadPort {
  read(input: {
    readonly tenant_id: string;
    readonly resource: string;
    readonly key?: string;
  }): Promise<ConnectorReadResult>;
}

export interface WorkerConnectorOptions {
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

/**
 * Binds the connectors this worker process may reach.
 *
 * @param env Process environment; only {@link WorkerConnectorEnv} is read.
 * @param options Host-supplied HMAC, authority and transport.
 * @returns The registry, its dispatcher and the named unbound capabilities.
 * @throws Error when a managed environment enables the mock provider, or when the mock is enabled
 *   without the provider location and shared secret it signs with. Both are composition-time
 *   refusals: a worker that cannot reach its system of record must not start and report healthy.
 */
export function createWorkerConnectors(
  env: WorkerConnectorEnv,
  options: WorkerConnectorOptions,
): WorkerConnectors {
  const app_env = env.APP_ENV ?? '';
  const mock_enabled = env.MOCK_ERP_ENABLED === 'true';
  const registry = new ConnectorRegistry();
  let erp_read: ErpReadPort | null = null;
  const bound: string[] = [];
  const unbound: string[] = [];
  if (mock_enabled && MANAGED_ENVS.includes(app_env)) {
    throw new Error(
      `MOCK_ERP_FORBIDDEN: MOCK_ERP_ENABLED=true is refused for APP_ENV=${app_env}; a managed deployment must reach an audited system of record, not a simulated one`,
    );
  }

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

    // One instance for the process: it holds no state of its own, and a per-call instance would
    // allocate a transport wrapper on every dispatch for no behaviour.
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
      dispatch: (draft) => connector.dispatch(draft),
      read: (input) => connector.read(input),
    });
    bound.push(API_001_CONNECTOR_ID);
    erp_read = connector;
    if (options.authority === undefined) {
      unbound.push(
        'API-001 mutation authority: no approval-backed authority is bound, so every dispatch is refused before the provider is contacted',
      );
    }
  } else {
    unbound.push(
      'API-001: no system of record is bound (MOCK_ERP_ENABLED is not true, and no audited provider transport is configured)',
    );
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
