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
  if (typeof invocation.input !== 'object' || invocation.input === null) {
    throw new CareSkillToolError(
      'VALIDATION_FAILED',
      'tool invocation input must be an object',
    );
  }
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

  // 2. Connector read. A transport failure is NOT an authoritative absence: only a provider
  // that answered and rejected the key may be reported as `ORDER_NOT_FOUND`, because the
  // platform must never tell a customer an order does not exist on the strength of a call
  // that never completed (implement/06 §8, NFR-004).
  let readResult;
  try {
    readResult = await erpRead.read({
      tenant_id: input.tenant_id,
      resource: 'orders',
      key: input.order_identifier,
      customer_id: input.customer_id,
    });
  } catch (error) {
    if (error instanceof ErpRefusalError && error.refusal_code === 'PROVIDER_REJECTED') {
      throw new CareSkillToolError(
        'ORDER_NOT_FOUND',
        `ORDER_NOT_FOUND: order ${input.order_identifier} not found in system of record`,
      );
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

  // 3. Owner match (no existence disclosure on mismatch)
  if (order.customer_id !== input.customer_id) {
    throw new CareSkillToolError(
      'ORDER_NOT_FOUND',
      `ORDER_OWNER_MISMATCH: order ${input.order_identifier} not found for customer (no existence disclosure)`,
    );
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
  else if (statusStr === 'DELIVERED' || statusStr === 'COMPLETED') status = 'DELIVERED';
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

  let line_items: Array<{
    sku_id: string;
    product_name: string;
    quantity: number;
    unit_price: number;
    currency: string;
  }>;

  if (Array.isArray(order.line_items) && order.line_items.length > 0) {
    line_items = order.line_items.map((item, idx) => {
      if (
        typeof item?.sku_id !== 'string'
        || typeof item?.product_name !== 'string'
        || typeof item?.quantity !== 'number'
        || !Number.isInteger(item.quantity)
        || item.quantity <= 0
        || typeof item?.unit_price !== 'number'
        || !Number.isFinite(item.unit_price)
        || item.unit_price < 0
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
  } else if (
    typeof order.sku_id === 'string'
    && typeof order.product_name === 'string'
    && typeof order.quantity === 'number'
    && Number.isInteger(order.quantity)
    && order.quantity > 0
    && typeof order.unit_price === 'number'
    && Number.isFinite(order.unit_price)
    && order.unit_price >= 0
    && typeof order.currency === 'string'
  ) {
    line_items = [
      {
        sku_id: order.sku_id,
        product_name: order.product_name,
        quantity: order.quantity,
        unit_price: order.unit_price,
        currency: order.currency,
      },
    ];
  } else {
    throw new CareSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Provider order missing mappable line items',
    );
  }

  const total_price = typeof order.total_price === 'number'
    ? order.total_price
    : (typeof order.total_amount === 'number' ? order.total_amount : null);
  if (total_price === null || !Number.isFinite(total_price) || total_price < 0) {
    throw new CareSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Provider order missing authoritative total price',
    );
  }

  const currency = typeof order.currency === 'string' && order.currency.trim().length > 0
    ? order.currency.trim()
    : null;
  if (!currency) {
    throw new CareSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Provider order missing currency',
    );
  }

  const tracking_number = typeof order.tracking_number === 'string' && order.tracking_number.trim().length > 0
    ? order.tracking_number.trim()
    : null;

  const rawDate = typeof order.order_date === 'string'
    ? order.order_date
    : (typeof order.created_at === 'string' ? order.created_at : null);
  if (!rawDate || isNaN(Date.parse(rawDate))) {
    throw new CareSkillToolError(
      'AUTHORITATIVE_SOURCE_UNAVAILABLE',
      'Provider order missing or invalid order_date timestamp',
    );
  }
  const order_date = rawDate;

  return {
    order_id,
    status,
    line_items,
    total_price,
    currency,
    tracking_number,
    order_date,
  } as TOutput;
}
