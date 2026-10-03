import { describe, expect, it } from 'vitest';

import { CONNECTOR_CATALOG } from './catalog.js';

describe('CONNECTOR_CATALOG', () => {
  it('assigns the documented categories and integration availability', () => {
    expect(CONNECTOR_CATALOG.map(({ connector_id, category, integrated }) => [connector_id, category, integrated])).toEqual([
      ['API-001', 'ERP_POS', true],
      ['API-002', 'WEB_EVENTS', true],
      ['API-003', 'MESSAGING', true],
      ['SHOPIFY', 'COMMERCE', false],
      ['ADPT-GL-001', 'PAYMENT_COMPLIANCE', false],
      ['ADPT-GL-002', 'PAYMENT_COMPLIANCE', false],
      ['ADPT-GL-003', 'PAYMENT_COMPLIANCE', false],
    ]);
  });

  it('publishes the supported API-001 read probes and closed config schemas', () => {
    const erp = CONNECTOR_CATALOG.find(({ connector_id }) => connector_id === 'API-001');
    expect(erp?.probes).toEqual(['catalog', 'inventory', 'customers', 'orders']);
    expect(erp?.config_schema).toMatchObject({ type: 'object', required: ['base_url'], additionalProperties: false });
    expect(CONNECTOR_CATALOG.find(({ connector_id }) => connector_id === 'ADPT-GL-001')?.probes).toEqual([]);
  });
});
