import { ErpRefusalError } from '@agentos/adapters';

import type { ErpReadPort } from '../connectors.js';
import { SalesSkillToolError } from './skills/quote-payment-guards.js';
import type { SalesOrderPort } from './skills/types.js';

const ORDER_ALLOWED_PAYMENT_METHODS: readonly string[] = Object.freeze([
  'CREDIT_CARD',
  'CVS_COD',
  'LINE_PAY',
  'JKOPAY',
  'STRIPE',
  'PAYPAL',
]);

/** Binds post-approval Sales order writes to the tenant's already-scoped API-001 connector. */
export function createErpSalesOrderPort(erp: ErpReadPort | null | undefined): SalesOrderPort | null {
  const createOrder = erp?.createOrder;
  if (erp === null || erp === undefined || createOrder === undefined) return null;

  return {
    readSupportedPaymentMethods: () => ORDER_ALLOWED_PAYMENT_METHODS,
    async createOrder(input, authorization) {
      if (input.items === undefined || input.items.length === 0) {
        throw new SalesSkillToolError('PRICE_MISMATCH', 'Server-authoritative cart line data is required for order creation');
      }
      try {
        return await createOrder.call(erp, {
          tenant_id: input.tenant_id,
          effect_key: input.effect_key,
          approval_id: authorization.approval_id,
          approval_payload_digest: authorization.approval_payload_digest,
          cart_id: input.cart_id,
          customer_id: input.customer_id,
          items: input.items,
          shipping_address: input.shipping_address,
          payment_method: input.payment_method,
          ...(authorization.signal === undefined ? {} : { signal: authorization.signal }),
        });
      } catch (error) {
        if (error instanceof ErpRefusalError) {
          const code = error.refusal_code === 'INDETERMINATE_OUTCOME'
            ? 'PROVIDER_INDETERMINATE'
            : error.refusal_code === 'PROVIDER_REJECTED'
              ? 'PROVIDER_REJECTED'
              : error.refusal_code === 'AUTHORITY_ABSENT'
                ? 'AUTHORITY_ABSENT'
                : error.refusal_code === 'TENANT_UNSCOPED'
                  ? 'IDENTITY_UNVERIFIED'
                  : 'AUTHORITATIVE_SOURCE_UNAVAILABLE';
          throw new SalesSkillToolError(code, error.detail);
        }
        throw new SalesSkillToolError('AUTHORITATIVE_SOURCE_UNAVAILABLE', 'API-001 order connector failed');
      }
    },
  };
}
