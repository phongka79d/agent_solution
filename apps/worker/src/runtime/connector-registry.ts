import {
  Api001ErpConnector,
  createConnectorHttpTransport,
  type ConnectorAuthScheme,
  type HmacSha256Hex,
} from '@agentos/adapters';
import type { ConnectorBindingRecord, ConnectorBindingRepository } from '@agentos/database';
import { isPristineConnectorBinding } from '@agentos/database';

import {
  createWorkerConnectors,
  createWorkerErpPort,
  REFUSE_ALL_MUTATIONS,
  type ErpReadPort,
  type WorkerConnectorEnv,
  type WorkerTenantDataClass,
} from './connectors.js';
import { nodeHmacSha256Hex } from './hmac.js';
import type { ErpFetchLike } from './erp-http-transport.js';

const CONNECTOR_ID = 'API-001';
const CACHE_TTL_MS = 30_000;
const AUTH_SCHEMES: readonly ConnectorAuthScheme[] = ['HMAC_MOCK', 'BEARER', 'BASIC'];

export interface ConnectorSecretResolver {
  resolve(tenant_id: string, secret_id: string): Promise<string>;
}

export interface ConnectorRegistryOptions {
  readonly bindings: Pick<ConnectorBindingRepository, 'get'>;
  readonly secrets: ConnectorSecretResolver;
  readonly env: WorkerConnectorEnv;
  readonly dataClassOf: (tenant_id: string) => Promise<WorkerTenantDataClass | null>;
  readonly now?: () => Date;
  /** Host/test seams; production defaults use the Node HMAC implementation and global fetch. */
  readonly hmac?: HmacSha256Hex;
  readonly fetch?: ErpFetchLike;
  readonly buildErpReadPort?: (input: {
    readonly tenant_id: string;
    readonly binding: ConnectorBindingRecord;
    readonly secret: string;
  }) => ErpReadPort | null;
}

export interface ConnectorRegistry {
  erpFor(tenant_id: string): Promise<ErpReadPort | null>;
}

interface CachedBinding {
  readonly key: string;
  readonly expires_at: number;
  readonly port: ErpReadPort;
}

/**
 * Resolves the tenant's ERP connector at task execution time. A verified database binding always
 * takes precedence; only a pristine DEMO tenant may inherit the process environment mock.
 */
export function createConnectorRegistry(options: ConnectorRegistryOptions): ConnectorRegistry {
  const now = options.now ?? (() => new Date());
  const hmac = options.hmac ?? nodeHmacSha256Hex;
  const cache = new Map<string, CachedBinding>();

  return {
    async erpFor(tenant_id): Promise<ErpReadPort | null> {
      if (tenant_id.trim().length === 0) throw new Error('CONNECTOR_TENANT_REQUIRED');

      const binding = await options.bindings.get(tenant_id, CONNECTOR_ID);
      if (binding?.status === 'BOUND') {
        const key = `DB:${binding.version}`;
        const cached = cache.get(tenant_id);
        if (cached?.key === key && cached.expires_at > now().getTime()) return cached.port;

        const port = await createDatabasePort(options, binding, tenant_id, hmac);
        if (port === null) {
          cache.delete(tenant_id);
          return null;
        }
        const scoped = tenantScoped(tenant_id, port);
        cache.set(tenant_id, { key, expires_at: now().getTime() + CACHE_TTL_MS, port: scoped });
        return scoped;
      }

      if (!isPristineConnectorBinding(binding)) {
        cache.delete(tenant_id);
        return null;
      }

      const dataClass = await options.dataClassOf(tenant_id);
      if (dataClass !== 'DEMO') {
        cache.delete(tenant_id);
        return null;
      }

      const key = 'ENV:DEMO_MOCK';
      const cached = cache.get(tenant_id);
      if (cached?.key === key && cached.expires_at > now().getTime()) return cached.port;

      const envConnectors = createWorkerConnectors(options.env, {
        hmac,
        tenantDataClass: 'DEMO',
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      if (envConnectors.erp_read === null) {
        cache.delete(tenant_id);
        return null;
      }
      const scoped = tenantScoped(tenant_id, envConnectors.erp_read);
      cache.set(tenant_id, { key, expires_at: now().getTime() + CACHE_TTL_MS, port: scoped });
      return scoped;
    },
  };
}

async function createDatabasePort(
  options: ConnectorRegistryOptions,
  binding: ConnectorBindingRecord,
  tenant_id: string,
  hmac: HmacSha256Hex,
): Promise<ErpReadPort | null> {
  const base_url = binding.config['base_url'];
  if (typeof base_url !== 'string' || base_url.length === 0 || binding.secret_id === null) return null;

  let secret: string;
  try {
    secret = await options.secrets.resolve(tenant_id, binding.secret_id);
  } catch {
    return null;
  }
  if (secret.length === 0) return null;

  if (options.buildErpReadPort) {
    return options.buildErpReadPort({ tenant_id, binding, secret });
  }

  const configuredScheme = binding.config['auth_scheme'];
  const auth_scheme: ConnectorAuthScheme = AUTH_SCHEMES.includes(configuredScheme as ConnectorAuthScheme)
    ? configuredScheme as ConnectorAuthScheme
    : binding.mode === 'MOCK' ? 'HMAC_MOCK' : 'BEARER';
  try {
    const transport = createConnectorHttpTransport({
      base_url,
      auth_scheme,
      secret,
      tenant_id,
      hmacSha256Hex: hmac,
      ...(options.fetch === undefined ? {} : { fetchImpl: options.fetch }),
    });
    const connector = new Api001ErpConnector({ transport, authority: REFUSE_ALL_MUTATIONS });
    return createWorkerErpPort(connector, transport);
  } catch {
    return null;
  }
}

function tenantScoped(tenant_id: string, port: ErpReadPort): ErpReadPort {
  const cartTransport = port.cart_transport;
  const createOrder = port.createOrder;
  return {
    read(input) {
      if (input.tenant_id !== tenant_id) throw new Error('CONNECTOR_TENANT_SCOPE_MISMATCH');
      return port.read(input);
    },
    ...(port.reconcile === undefined
      ? {}
      : {
          reconcile(input) {
            if (input.tenant_id !== tenant_id) throw new Error('CONNECTOR_TENANT_SCOPE_MISMATCH');
            return port.reconcile!(input);
          },
        }),
    ...(createOrder === undefined
      ? {}
      : {
          createOrder(input) {
            if (input.tenant_id !== tenant_id) throw new Error('CONNECTOR_TENANT_SCOPE_MISMATCH');
            return createOrder(input);
          },
        }),
    ...(cartTransport === undefined
      ? {}
      : {
          cart_transport: {
            request(input) {
              if (input.tenant_id !== tenant_id) {
                return Promise.resolve({ ok: false, failure_class: 'PROVIDER_REJECTED', status: null });
              }
              return cartTransport.request(input);
            },
          },
        }),
  };
}
