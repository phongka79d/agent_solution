import type { ActionDraft, ExecutionReceipt } from '@agentos/core-engine/contracts';

import type { AdapterPort } from '../base/port.js';
import type { ConnectorReadResult } from '../base/registry.js';

/**
 * The eight API-001 read resource groups (06 §2). The list is closed and exhaustive on purpose: a
 * resource outside it is refused, so no caller can widen the system-of-record surface at runtime.
 */
export const ERP_READ_RESOURCES = [
  'products',
  'prices',
  'inventory',
  'orders',
  'invoices',
  'customers',
  'shipments',
  'returns',
] as const;

/** One of the eight API-001 read resource groups. */
export type ErpReadResource = (typeof ERP_READ_RESOURCES)[number];

/** Wire route for one read resource group. */
export interface ErpResourceRoute {
  readonly method: 'GET' | 'POST';
  readonly path: string;
}

/**
 * Route map for the eight read groups (06 §2). The connector only *names* routes: building an
 * absolute URL, adding headers and signing with `HmacSha256Hex` are host concerns, so the same
 * connector can be pointed at a sandbox or a production host without a code change.
 */
export const ERP_RESOURCE_ROUTES: Readonly<Record<ErpReadResource, ErpResourceRoute>> = {
  products: { method: 'GET', path: '/api/v1/catalog/items' },
  prices: { method: 'POST', path: '/api/v1/prices/lookup' },
  inventory: { method: 'POST', path: '/api/v1/inventory/lookup' },
  orders: { method: 'POST', path: '/api/v1/orders/status' },
  invoices: { method: 'POST', path: '/api/v1/invoices/lookup' },
  customers: { method: 'POST', path: '/api/v1/customers/lookup' },
  shipments: { method: 'POST', path: '/api/v1/shipments/lookup' },
  returns: { method: 'POST', path: '/api/v1/returns/lookup' },
};

/**
 * Mutating boundary for an API-001 dispatch. `06` §2 fixes the read route map but publishes **no**
 * mutating path; `/api/v1/actions/{action_id}` is therefore the connector's action boundary with the
 * provider and remains `[UNCONFIRMED][ASM-001]` until the provider audit closes. It is exported so the
 * host resolves exactly one literal instead of re-deriving a path per call site.
 */
export const ERP_ACTION_PATH_TEMPLATE = '/api/v1/actions/{action_id}';

/** Narrowing guard for the closed read-resource list; unknown strings are refused, never coerced. */
export function isErpReadResource(value: string): value is ErpReadResource {
  return ERP_READ_RESOURCES.some((resource) => resource === value);
}

/** Provider failure classes, copied from the orchestrator's retry vocabulary (06 §8.1, R13). */
export type ErpTransportFailureClass = 'TIMEOUT' | 'PROVIDER_REJECTED' | 'UNKNOWN';

/** One host-side HTTP call. The host owns URL building, tenant header, HMAC and timeouts. */
export interface ErpTransportRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly tenant_id: string;
  readonly body?: Record<string, unknown>;
}

/**
 * Host-implemented wire to API-001. It returns *classified* outcomes rather than throwing, because
 * the connector's job is to convert an outcome into a platform refusal or receipt and only the host
 * knows whether a failure proves the provider rejected the request (`PROVIDER_REJECTED`) or leaves it
 * indeterminate (`TIMEOUT`, `UNKNOWN`).
 *
 * Contract obligations on the host: sign every request with `HmacSha256Hex` using a secret this
 * package never sees, scope every request to the passed `tenant_id`, and return the provider envelope
 * verbatim in `body` — including its own observation timestamp, which the connector refuses to invent.
 */
export interface ErpTransport {
  request(input: ErpTransportRequest): Promise<
    | { readonly ok: true; readonly status: number; readonly body: Record<string, unknown> }
    | {
        readonly ok: false;
        readonly failure_class: ErpTransportFailureClass;
        readonly status: number | null;
      }
  >;
}

/**
 * Server-side authority for mutating the system of record.
 *
 * `authorize` receives identity, not content: it deliberately takes **no caller payload**, so an
 * approval claim embedded in a `payload` can never be consulted — an attacker who controls the
 * payload gains nothing, and only the platform's own authority records can return `true`.
 */
export interface ErpMutationAuthority {
  authorize(input: {
    readonly tenant_id: string;
    readonly connector_id: string;
    readonly operation: string;
    readonly effect_key: string;
  }): boolean;
}

/** Why an API-001 operation was refused. Refusals are typed so callers never parse a message string. */
export type ErpRefusalCode =
  | 'UNKNOWN_RESOURCE'
  | 'TENANT_UNSCOPED'
  | 'AUTHORITY_ABSENT'
  | 'PROVIDER_REJECTED'
  | 'INDETERMINATE_OUTCOME'
  | 'UNOBSERVED_TIMESTAMP';

/**
 * Thrown instead of returning a value whenever API-001 cannot be truthfully observed or may not be
 * reached. A refusal carries no provider payload: the platform records that nothing happened rather
 * than recording a value it did not obtain.
 */
export class ErpRefusalError extends Error {
  readonly refusal_code: ErpRefusalCode;
  readonly adapter_id: string;
  /** Caller-safe detail; never contains credentials or the raw provider envelope. */
  readonly detail: string;

  constructor(refusal_code: ErpRefusalCode, adapter_id: string, detail: string) {
    super(`${adapter_id} refused (${refusal_code}): ${detail}`);
    this.name = 'ErpRefusalError';
    this.refusal_code = refusal_code;
    this.adapter_id = adapter_id;
    this.detail = detail;
  }
}

/** Injected collaborators. Both are host-supplied; the connector owns no state of its own. */
export interface Api001ErpConnectorDeps {
  readonly transport: ErpTransport;
  readonly authority: ErpMutationAuthority;
}

/** Fields the provider envelope may use for its own observation time; first present one wins. */
const OBSERVED_AT_FIELDS = ['snapshot_at', 'updated_at', 'observed_at'] as const;

/** Fields the provider envelope may use for its own document reference; absence yields `null`. */
const PROVIDER_REFERENCE_FIELDS = ['provider_reference', 'document_number', 'reference'] as const;

/** First string value among `fields`, or `null`. Never substitutes a locally generated value. */
function firstStringField(
  body: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const value = body[field];
    if (typeof value === 'string' && value.length > 0) {
      return value;
    }
  }
  return null;
}

/** Builds the host request, omitting `body` entirely when there is nothing to send. */
function requestOf(
  input: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly tenant_id: string;
  },
  body: Record<string, unknown> | null,
): ErpTransportRequest {
  if (body === null) {
    return { method: input.method, path: input.path, tenant_id: input.tenant_id };
  }
  return { method: input.method, path: input.path, tenant_id: input.tenant_id, body };
}

/**
 * API-001 ERP/POS connector: the authoritative system-of-record boundary (06 §2).
 *
 * Zero state, zero caching, fully deterministic: every read reaches the transport (so no read is ever
 * served from a stale entry) and every mutation is authorized server-side before the provider is
 * contacted. The connector derives no price floor, grants no authority, manufactures no consent or
 * identity, and never retries an indeterminate effect — those decisions belong to the orchestrator.
 */
export class Api001ErpConnector implements AdapterPort {
  /** Stable connector id, matching the `adapter_target` an API-001 `PlannedStep` names. */
  readonly adapterId = 'API-001';

  private readonly transport: ErpTransport;
  private readonly authority: ErpMutationAuthority;

  constructor(deps: Api001ErpConnectorDeps) {
    this.transport = deps.transport;
    this.authority = deps.authority;
  }

  /**
   * Reads one of the eight API-001 resource groups for a single tenant.
   *
   * @throws ErpRefusalError `UNKNOWN_RESOURCE` before any transport call, `INDETERMINATE_OUTCOME` /
   * `PROVIDER_REJECTED` on a failed request, `UNOBSERVED_TIMESTAMP` when the provider envelope omits
   * its own observation time — in every case no value is returned.
   */
  async read(input: {
    readonly tenant_id: string;
    readonly resource: string;
    readonly key?: string;
  }): Promise<ConnectorReadResult> {
    if (input.tenant_id.length === 0) {
      throw new ErpRefusalError(
        'TENANT_UNSCOPED',
        this.adapterId,
        'read requires a tenant id from the authenticated principal',
      );
    }

    const { resource } = input;
    if (!isErpReadResource(resource)) {
      throw new ErpRefusalError(
        'UNKNOWN_RESOURCE',
        this.adapterId,
        `'${resource}' is not one of the eight API-001 read groups`,
      );
    }

    const route = ERP_RESOURCE_ROUTES[resource];
    // API-001 inventory lookup accepts a SKU list, while other resource groups retain the
    // connector's generic key envelope. Keep the projection here at the named route boundary.
    const body = input.key === undefined
      ? null
      : resource === 'inventory'
        ? { tenant_id: input.tenant_id, sku_ids: [input.key] }
        : { key: input.key };
    const result = await this.transport.request(
      requestOf({ method: route.method, path: route.path, tenant_id: input.tenant_id }, body),
    );

    if (!result.ok) {
      const confirmed = result.failure_class === 'PROVIDER_REJECTED';
      throw new ErpRefusalError(
        confirmed ? 'PROVIDER_REJECTED' : 'INDETERMINATE_OUTCOME',
        this.adapterId,
        confirmed
          ? `provider rejected the ${resource} read with status ${String(result.status)}`
          : `the ${resource} read outcome is unconfirmed (${result.failure_class})`,
      );
    }

    const observed_at = firstStringField(result.body, OBSERVED_AT_FIELDS);
    if (observed_at === null) {
      throw new ErpRefusalError(
        'UNOBSERVED_TIMESTAMP',
        this.adapterId,
        `provider envelope for '${resource}' carries no observation timestamp`,
      );
    }

    return {
      resource,
      value: result.body,
      observed_at,
      tenant_id: input.tenant_id,
    };
  }

  /**
   * Sends one already-authorized action draft to API-001.
   *
   * The authority check runs first and receives no payload-derived field — deliberately, so a claim
   * such as `approval_id` inside `payload` cannot influence authorization; only platform-side records
   * can. A refused mutation never reaches the transport, and an unconfirmed outcome is reported as
   * `TIMEOUT` rather than success, because the orchestrator reconciles an indeterminate effect and
   * must never see a success claim it cannot back with a provider reference.
   */
  async dispatch(draft: ActionDraft): Promise<ExecutionReceipt> {
    const tenant_id = draft.tenant_id;
    if (tenant_id.length === 0) {
      throw new ErpRefusalError(
        'TENANT_UNSCOPED',
        this.adapterId,
        'dispatch requires a tenant id from the authenticated principal',
      );
    }

    const authorized = this.authority.authorize({
      tenant_id,
      connector_id: this.adapterId,
      operation: draft.action_id,
      effect_key: draft.effect_key,
    });

    if (!authorized) {
      throw new ErpRefusalError(
        'AUTHORITY_ABSENT',
        this.adapterId,
        `no server-side authority for action '${draft.action_id}' on tenant '${tenant_id}'`,
      );
    }

    const path = ERP_ACTION_PATH_TEMPLATE.replace('{action_id}', draft.action_id);
    const result = await this.transport.request(
      requestOf({ method: 'POST', path, tenant_id }, draft.payload),
    );

    if (!result.ok) {
      return this.failureReceipt(
        draft,
        result.failure_class === 'PROVIDER_REJECTED' ? 'ERROR' : 'TIMEOUT',
        result.failure_class,
        result.status,
      );
    }

    return {
      execution_id: `${this.adapterId}:${draft.action_id}:${draft.action_revision}`,
      adapter_status: 'SUCCESS',
      provider_reference: firstStringField(result.body, PROVIDER_REFERENCE_FIELDS),
      // The provider envelope is retained verbatim under its own key: reconciliation compares what the
      // provider actually said, not a projection of it.
      response_payload: { provider_status: result.status, provider_envelope: result.body },
      latency_ms: 0,
      token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
    };
  }

  /**
   * Reconciles an effect outcome with the provider by querying the action endpoint.
   * Uses GET /api/v1/actions/{action_id} to observe whether the action was recorded by the provider.
   */
  async reconcile(input: {
    readonly tenant_id: string;
    readonly effect_key: string;
    readonly action_id?: string;
  }): Promise<{
    readonly outcome: 'SUCCEEDED' | 'FAILED' | 'INDETERMINATE';
    readonly receipt?: ExecutionReceipt;
  }> {
    if (input.tenant_id.length === 0) {
      throw new ErpRefusalError(
        'TENANT_UNSCOPED',
        this.adapterId,
        'reconcile requires a tenant id from the authenticated principal',
      );
    }

    let targetId = input.action_id ?? input.effect_key;
    let path = ERP_ACTION_PATH_TEMPLATE.replace('{action_id}', targetId);
    let result = await this.transport.request(
      requestOf({ method: 'GET', path, tenant_id: input.tenant_id }, null),
    );

    if (!result.ok && result.status === 404 && input.action_id && input.effect_key && input.action_id !== input.effect_key) {
      targetId = input.effect_key;
      path = ERP_ACTION_PATH_TEMPLATE.replace('{action_id}', targetId);
      result = await this.transport.request(
        requestOf({ method: 'GET', path, tenant_id: input.tenant_id }, null),
      );
    }

    if (result.ok && result.status === 200) {
      const provider_reference = firstStringField(result.body, PROVIDER_REFERENCE_FIELDS);
      return {
        outcome: 'SUCCEEDED',
        receipt: {
          execution_id: `${this.adapterId}:${targetId}:reconciled`,
          adapter_status: 'SUCCESS',
          provider_reference,
          response_payload: { provider_status: result.status, provider_envelope: result.body, reconciled: true },
          latency_ms: 0,
          token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
        },
      };
    }

    if (!result.ok && result.status === 404) {
      return { outcome: 'FAILED' };
    }

    return { outcome: 'INDETERMINATE' };
  }

  /**
   * Receipt for a dispatch that reached the provider but was not confirmed. `latency_ms` is 0 because
   * this package has no clock: a fabricated duration would be indistinguishable from a measurement.
   */
  private failureReceipt(
    draft: ActionDraft,
    adapter_status: 'ERROR' | 'TIMEOUT',
    failure_class: ErpTransportFailureClass,
    status: number | null,
  ): ExecutionReceipt {
    return {
      execution_id: `${this.adapterId}:${draft.action_id}:${draft.action_revision}`,
      adapter_status,
      provider_reference: null,
      response_payload: { failure_class, provider_status: status },
      latency_ms: 0,
      token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
    };
  }
}