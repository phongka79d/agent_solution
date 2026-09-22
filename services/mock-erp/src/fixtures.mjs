/** Synthetic local/CI fixtures. Not customer data and not an approved price floor. */
export const TENANT_ID = '00000000-0000-4000-8000-000000000001';

export const CATALOG_ITEM = Object.freeze({
  tenant_id: TENANT_ID,
  product_id: 'prod-local-1',
  sku: 'SKU-LOCAL-1',
  name: 'Synthetic local fixture',
  currency: 'TWD',
  original_list_price: 100,
  is_active: true,
});

export const WAREHOUSE = Object.freeze({
  warehouse_id: 'WH-1',
  warehouse_name: 'Local fixture warehouse',
  physical_qty: 7,
  reserved_qty: 2,
  available_to_promise: 5,
});

export const CUSTOMER = Object.freeze({
  tenant_id: TENANT_ID,
  customer_id: 'cust-local-1',
  name: 'Synthetic Customer',
  email: 'cust-local-1@example.invalid',
  phone: '+15555550100',
  credit_status: 'NORMAL',
  customer_tier: 'STANDARD',
});

export const CANONICAL_EVENTS = Object.freeze([
  'session',
  'product_view',
  'search',
  'click',
  'add_to_cart',
  'checkout',
  'purchase',
]);
