import { ErpRefusalError } from '@agentos/adapters';
import type { SkillToolInvocation } from '@agentos/skills';

import type { ErpReadPort } from '../../connectors.js';
import { CareSkillToolError } from './errors.js';
import type { VerifiedCustomerIdentity } from './types.js';

/** Executes the API-001 order lookup with the existing verification and mapping rules. */
export async function handleOrderConnector<TOutput>(
  invocation: SkillToolInvocation<unknown>,
  erpRead: ErpReadPort,
  findVerifiedIdentity: (tenant_id: string, id: string) => Promise<VerifiedCustomerIdentity | null>,
): Promise<TOutput> {
  const input = invocation.input as {
    readonly tenant_id: string;
    readonly order_identifier: string;
    readonly customer_id: string;
    readonly verification_reference: string;
    readonly verification_status: string;
  };
  const contextTenantId = invocation.context?.tenant_id;
  if (typeof contextTenantId !== 'string' || contextTenantId.length === 0 || input.tenant_id !== contextTenantId) {
    throw new CareSkillToolError(
      'TENANT_SCOPE_MISMATCH',
      'order lookup tenant_id must match the orchestrator-bound tenant',
    );
  }

  // 1. Server-side verification FIRST (ZERO connector calls made if this fails)
  if (input.verification_status !== 'VERIFIED') {
    throw new CareSkillToolError(
      'IDENTITY_UNVERIFIED',
      'verification_status must be VERIFIED for order lookup',
    );
  }

  const identity = await findVerifiedIdentity(input.tenant_id, input.verification_reference);
  if (
    !identity
    || identity.verified_at === null
    || identity.verified_at === undefined
    || identity.customer_id !== input.customer_id
  ) {
    throw new CareSkillToolError(
      'IDENTITY_UNVERIFIED',
      'verification_reference does not resolve server-side to a verified identity matching customer_id',
    );
  }

  // 2. Connector read. Only a confirmed provider 404 is an authoritative absence. Any other
  // provider rejection or transport failure remains unavailable; neither can establish a miss.
  let readResult;
  try {
    readResult = await erpRead.read({
      tenant_id: input.tenant_id,
      resource: 'orders',
      key: input.order_identifier,
      customer_id: input.customer_id,
    });
  } catch (error) {
    if (
      error instanceof ErpRefusalError
      && error.refusal_code === 'PROVIDER_REJECTED'
      && error.detail.endsWith('status 404')
    ) {
      return { result: 'ORDER_NOT_FOUND' } as TOutput;
    }
    // The read is effect-free: a timeout, 5xx or unconfirmed network response can be retried.
    // Do not flatten that transport failure into a deterministic missing-source refusal.
    if (error instanceof ErpRefusalError && error.refusal_code === 'INDETERMINATE_OUTCOME') {
      throw new CareSkillToolError('PROVIDER_UNAVAILABLE', 'The order provider could not confirm the read');
    }

    throw new CareSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      `the order lookup for ${input.order_identifier} produced no confirmed outcome (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }

  const order = readResult.value;
  if (!order || typeof order !== 'object') {
    throw new CareSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Provider response did not contain an order object',
    );
  }

  // 3. The provider must identify an owner before a mismatch can safely be normalized.
  if (typeof order.customer_id !== 'string' || order.customer_id.trim().length === 0) {
    throw new CareSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Provider order missing authoritative customer_id',
    );
  }
  if (order.customer_id !== input.customer_id) {
    return { result: 'ORDER_NOT_FOUND' } as TOutput;
  }
  // 4. Closed documented mapping to skill output DTO (no synthesized values)
  const order_id = typeof order.order_id === 'string' && order.order_id.trim().length > 0
    ? order.order_id.trim()
    : null;
  if (!order_id) {
    throw new CareSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Provider order missing authoritative order_id',
    );
  }

  const rawStatus = (order.fulfillment_status ?? order.status);
  const statusStr = typeof rawStatus === 'string' ? rawStatus.toUpperCase().trim() : '';
  let status: 'PENDING' | 'PROCESSING' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED' | 'RETURNED' | null = null;
  if (statusStr === 'SHIPPED' || statusStr === 'FULFILLED') status = 'SHIPPED';
  else if (statusStr === 'DELIVERED') status = 'DELIVERED';
  else if (statusStr === 'PAID' || statusStr === 'CONFIRMED') status = 'PROCESSING';
  else if (statusStr === 'PENDING') status = 'PENDING';
  else if (statusStr === 'PROCESSING') status = 'PROCESSING';
  else if (statusStr === 'CANCELLED' || statusStr === 'CANCELED') status = 'CANCELLED';
  else if (statusStr === 'RETURNED') status = 'RETURNED';

  if (!status) {
    throw new CareSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      `Unmappable provider order status: ${String(rawStatus)}`,
    );
  }

  // Status lookups only require the authoritative owner, reference, and status; never invent omitted details.

  let line_items: Array<{
    sku_id: string;
    product_name: string;
    quantity: number;
    unit_price: number;
    currency: string;
  }> | undefined;
  const hasSingleLineItem = order.sku_id !== undefined
    || order.product_name !== undefined
    || order.quantity !== undefined
    || order.unit_price !== undefined;

  if (Array.isArray(order.line_items)) {
    line_items = order.line_items.map((item, idx) => {
      if (
        typeof item?.sku_id !== 'string'
        || typeof item?.product_name !== 'string'
        || typeof item?.quantity !== 'number'
        || !Number.isInteger(item.quantity)
        || typeof item?.unit_price !== 'number'
        || typeof item?.currency !== 'string'
      ) {
        throw new CareSkillToolError(
          'AUTHORITATIVE_SOURCE_UNAVAILABLE',
          `Line item at index ${idx} missing required fields or has invalid types`,
        );
      }
      return {
        sku_id: item.sku_id,
        product_name: item.product_name,
        quantity: item.quantity,
        unit_price: item.unit_price,
        currency: item.currency,
      };
    });
  } else if (order.line_items !== undefined) {
    throw new CareSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Provider order line_items is not an array',
    );
  } else if (hasSingleLineItem) {
    if (
      typeof order.sku_id !== 'string'
      || typeof order.product_name !== 'string'
      || typeof order.quantity !== 'number'
      || !Number.isInteger(order.quantity)
      || typeof order.unit_price !== 'number'
      || typeof order.currency !== 'string'
    ) {
      throw new CareSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Provider order contains incomplete line-item details',
      );
    }
    line_items = [{
      sku_id: order.sku_id,
      product_name: order.product_name,
      quantity: order.quantity,
      unit_price: order.unit_price,
      currency: order.currency,
    }];
  }

  const total_price = typeof order.total_price === 'number'
    ? order.total_price
    : (typeof order.total_amount === 'number' ? order.total_amount : undefined);
  const currency = typeof order.currency === 'string' && order.currency.trim().length > 0
    ? order.currency.trim()
    : undefined;
  const tracking_number = order.tracking_number === null
    ? null
    : typeof order.tracking_number === 'string'
      ? (order.tracking_number.trim().length > 0 ? order.tracking_number.trim() : null)
      : undefined;

  const rawDate = typeof order.order_date === 'string'
    ? order.order_date
    : (typeof order.created_at === 'string' ? order.created_at : null);
  let order_date: string | undefined;
  if (rawDate !== null) {
    if (isNaN(Date.parse(rawDate))) {
      throw new CareSkillToolError(
        'AUTHORITATIVE_SOURCE_UNAVAILABLE',
        'Provider order has an invalid order_date timestamp',
      );
    }
    order_date = rawDate;
  } else if (order.order_date !== undefined || order.created_at !== undefined) {
    throw new CareSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Provider order has an invalid order_date timestamp',
    );
  }

  return {
    order_id,
    status,
    ...(line_items === undefined ? {} : { line_items }),
    ...(total_price === undefined ? {} : { total_price }),
    ...(currency === undefined ? {} : { currency }),
    ...(tracking_number === undefined ? {} : { tracking_number }),
    ...(order_date === undefined ? {} : { order_date }),
  } as TOutput;
}
