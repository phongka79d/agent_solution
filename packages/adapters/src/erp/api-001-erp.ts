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

/** Encodes an action id as one path segment; provider action identity is not a URL fragment. */
function actionPath(action_id: string): string {
  return ERP_ACTION_PATH_TEMPLATE.replace('{action_id}', encodeURIComponent(action_id));
}

/** Provider failure classes, copied from the orchestrator's retry vocabulary (06 §8.1, R13). */
export type ErpTransportFailureClass = 'TIMEOUT' | 'PROVIDER_REJECTED' | 'UNKNOWN';

/** One host-side HTTP call. The host owns URL building, tenant header, HMAC and timeouts. */
export interface ErpTransportRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly tenant_id: string;
  readonly body?: Record<string, unknown>;
  /** Provider idempotency key; API-001 transports it as the `idempotency-key` header. */
  readonly idempotency_key?: string;
  /** Abort signal from the orchestrator's registry deadline guard. */
  readonly signal?: AbortSignal;
}
/** One explicitly priced cart line; the provider, not the caller, resolves its unit price. */
export interface ErpCreateOrderLine {
  readonly sku_id: string;
  readonly quantity: number;
}

/** AUTH-4 request passed only after the Sales skill engine verifies the bound approval payload. */
export interface ErpCreateOrderInput {
  readonly tenant_id: string;
  readonly effect_key: string;
  readonly approval_id: string;
  readonly approval_payload_digest: string;
  readonly cart_id: string;
  readonly customer_id: string;
  readonly items: readonly ErpCreateOrderLine[];
  readonly shipping_address: Record<string, unknown>;
  readonly payment_method: 'CREDIT_CARD' | 'CVS_COD' | 'LINE_PAY' | 'JKOPAY' | 'STRIPE' | 'PAYPAL';
  readonly signal?: AbortSignal;
}

/** Canonical order receipt returned to the Sales skill from API-001. */
export interface ErpCreatedOrder {
  readonly order_id: string;
  readonly order_number: string;
  readonly total_amount: number;
  readonly currency: string;
  readonly status: 'DRAFT' | 'PENDING_PAYMENT' | 'CONFIRMED';
  readonly created_at: string;
}

const ERP_ORDER_CREATE_PATH = '/api/v1/orders';
const ERP_ORDER_RECONCILE_PATH = '/api/v1/orders/reconcile';


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
const ORDER_CREATED_AT_FIELDS = ['created_at', 'order_date', 'snapshot_at'] as const;
const ORDER_PAYMENT_METHODS: Readonly<Record<string, true>> = {
  CREDIT_CARD: true,
  CVS_COD: true,
  LINE_PAY: true,
  JKOPAY: true,
  STRIPE: true,
  PAYPAL: true,
};

function orderOutput(body: Record<string, unknown>): ErpCreatedOrder | null {
  const order_id = body.order_id;
  const order_number = body.order_number;
  const total_amount = body.total_amount;
  const currency = body.currency;
  const observed_at = firstStringField(body, ORDER_CREATED_AT_FIELDS);
  const provider_status = body.status;
  const status = provider_status === 'DRAFT' || provider_status === 'CONFIRMED'
    ? provider_status
    : provider_status === 'CREATED' || provider_status === 'PENDING_PAYMENT'
      ? 'PENDING_PAYMENT'
      : undefined;
  if (
    typeof order_id !== 'string'
    || order_id.trim().length === 0
    || typeof order_number !== 'string'
    || order_number.trim().length === 0
    || typeof total_amount !== 'number'
    || !Number.isFinite(total_amount)
    || total_amount < 0
    || typeof currency !== 'string'
    || currency.trim().length === 0
    || observed_at === null
    || Number.isNaN(Date.parse(observed_at))
    || status === undefined
  ) {
    return null;
  }
  return { order_id, order_number, total_amount, currency, status, created_at: observed_at };
}

/** Builds the host request, omitting `body` and `signal` when there is nothing to send. */
function requestOf(
  input: {
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly tenant_id: string;
    readonly signal?: AbortSignal;
  },
  body: Record<string, unknown> | null,
): ErpTransportRequest {
  return {
    method: input.method,
    path: input.path,
    tenant_id: input.tenant_id,
    ...(body === null ? {} : { body }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
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
    readonly customer_id?: string;
    readonly signal?: AbortSignal;
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
    // Each route publishes the body its own resource expects: inventory takes a SKU list, prices
    // takes a single `sku_id`, and customer-owned documents require their customer_id.
    if (
      (resource === 'orders' || resource === 'shipments' || resource === 'returns')
      && (input.key === undefined || input.customer_id === undefined || input.customer_id.trim().length === 0)
    ) {
      throw new ErpRefusalError(
        'TENANT_UNSCOPED',
        this.adapterId,
        `${resource} reads require a server-resolved customer_id`,
      );
    }
    const body = input.key === undefined
      ? null
      : resource === 'inventory'
        ? { tenant_id: input.tenant_id, sku_ids: [input.key] }
        : resource === 'prices'
          ? { tenant_id: input.tenant_id, sku_id: input.key }
          : resource === 'orders' || resource === 'shipments' || resource === 'returns'
            ? { key: input.key, customer_id: input.customer_id }
            : { key: input.key };
    const result = await this.transport.request(
      requestOf({
        method: route.method,
        path: route.path,
        tenant_id: input.tenant_id,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }, body),
    );

    if (!result.ok || result.status >= 400) {
      const failure_class = result.ok ? 'PROVIDER_REJECTED' : result.failure_class;
      const status = result.ok ? result.status : result.status;
      const confirmed = failure_class === 'PROVIDER_REJECTED';
      throw new ErpRefusalError(
        confirmed ? 'PROVIDER_REJECTED' : 'INDETERMINATE_OUTCOME',
        this.adapterId,
        confirmed
          ? `provider rejected the ${resource} read with status ${String(status)}`
          : `the ${resource} read outcome is unconfirmed (${failure_class})`,
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
   * Creates a server-priced order only from the Sales skill's post-AUTH-4 call. The skill runtime
   * verifies `approval_id` against the exact bound payload digest before invoking this port.
   */
  async createOrder(input: ErpCreateOrderInput): Promise<ErpCreatedOrder> {
    if (input.tenant_id.trim().length === 0) {
      throw new ErpRefusalError('TENANT_UNSCOPED', this.adapterId, 'order creation requires an authenticated tenant');
    }
    if (
      input.effect_key.trim().length === 0
      || input.approval_id.trim().length === 0
      || !/^[a-f0-9]{64}$/i.test(input.approval_payload_digest)
    ) {
      throw new ErpRefusalError('AUTHORITY_ABSENT', this.adapterId, 'order creation requires the verified approval identity');
    }
    if (
      input.cart_id.trim().length === 0
      || input.customer_id.trim().length === 0
      || typeof input.shipping_address !== 'object'
      || input.shipping_address === null
      || Array.isArray(input.shipping_address)
      || !Object.hasOwn(ORDER_PAYMENT_METHODS, input.payment_method)
      || input.items.length === 0
      || input.items.length > 50
    ) {
      throw new ErpRefusalError('PROVIDER_REJECTED', this.adapterId, 'order input is missing required cart, customer, address, payment, or line data');
    }
    for (const item of input.items) {
      if (
        typeof item !== 'object'
        || item === null
        || Array.isArray(item)
        || Object.keys(item).some((key) => key !== 'sku_id' && key !== 'quantity')
        || typeof item.sku_id !== 'string'
        || item.sku_id.trim().length === 0
        || !Number.isSafeInteger(item.quantity)
        || item.quantity < 1
      ) {
        throw new ErpRefusalError('PROVIDER_REJECTED', this.adapterId, 'order line must contain only a SKU and positive quantity');
      }
    }

    const result = await this.transport.request({
      method: 'POST',
      path: ERP_ORDER_CREATE_PATH,
      tenant_id: input.tenant_id,
      idempotency_key: input.effect_key,
      body: {
        tenant_id: input.tenant_id,
        cart_id: input.cart_id,
        customer_id: input.customer_id,
        items: input.items,
        shipping_address: input.shipping_address,
        payment_method: input.payment_method,
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (!result.ok || result.status >= 400) {
      const failure_class = result.ok ? 'PROVIDER_REJECTED' : result.failure_class;
      throw new ErpRefusalError(
        failure_class === 'PROVIDER_REJECTED' ? 'PROVIDER_REJECTED' : 'INDETERMINATE_OUTCOME',
        this.adapterId,
        failure_class === 'PROVIDER_REJECTED'
          ? `provider rejected order creation with status ${String(result.status)}`
          : `order creation outcome is unconfirmed (${failure_class})`,
      );
    }
    const order = orderOutput(result.body);
    if (order === null) {
      throw new ErpRefusalError(
        'INDETERMINATE_OUTCOME',
        this.adapterId,
        'provider accepted order creation but returned an incomplete order receipt',
      );
    }
    return order;
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
  async dispatch(draft: ActionDraft, options?: { readonly signal?: AbortSignal }): Promise<ExecutionReceipt> {
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

    const path = actionPath(draft.action_id);
    const result = await this.transport.request(
      requestOf({
        method: 'POST',
        path,
        tenant_id,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      }, draft.payload),
    );

    if (!result.ok || result.status >= 400) {
      const failure_class = result.ok ? 'PROVIDER_REJECTED' : result.failure_class;
      return this.failureReceipt(
        draft,
        failure_class === 'PROVIDER_REJECTED' ? 'ERROR' : 'TIMEOUT',
        failure_class,
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
    readonly skill_id?: string;
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

    if (input.skill_id === 'skill.sales.create_order') {
      const result = await this.transport.request({
        method: 'POST',
        path: ERP_ORDER_RECONCILE_PATH,
        tenant_id: input.tenant_id,
        body: { tenant_id: input.tenant_id, idempotency_key: input.effect_key },
      });
      if (result.status === 404) {
        return { outcome: 'FAILED' };
      }
      if (!result.ok || result.status !== 200) {
        return { outcome: 'INDETERMINATE' };
      }
      const order = orderOutput(result.body);
      if (order === null) {
        return { outcome: 'INDETERMINATE' };
      }
      const receipt: ExecutionReceipt = {
        execution_id: `${this.adapterId}:${input.effect_key}:reconciled`,
        adapter_status: 'SUCCESS',
        provider_reference: order.order_id,
        response_payload: { ...order },
        latency_ms: 0,
        token_usage: { prompt: 0, completion: 0, total_cost_usd: 0 },
      };
      return { outcome: 'SUCCEEDED', receipt };
    }

    let targetId = input.action_id ?? input.effect_key;
    let path = actionPath(targetId);
    let result = await this.transport.request(
      requestOf({ method: 'GET', path, tenant_id: input.tenant_id }, null),
    );

    if (result.status === 404 && input.action_id && input.effect_key && input.action_id !== input.effect_key) {
      targetId = input.effect_key;
      path = actionPath(targetId);
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

    if (result.status === 404) {
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