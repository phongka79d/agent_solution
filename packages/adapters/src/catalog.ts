export type ConnectorCategory = 'ERP_POS' | 'WEB_EVENTS' | 'MESSAGING' | 'COMMERCE' | 'PAYMENT_COMPLIANCE';
export type ConnectorAuthScheme = 'HMAC_MOCK' | 'BEARER' | 'BASIC';
export type ConnectorProbe = 'catalog' | 'inventory' | 'customers' | 'orders';

export interface ConnectorCatalogEntry {
  readonly connector_id: string;
  readonly display_key: string;
  readonly category: ConnectorCategory;
  readonly integrated: boolean;
  readonly config_schema: Readonly<Record<string, unknown>>;
  readonly auth_schemes: readonly ConnectorAuthScheme[];
  readonly probes: readonly ConnectorProbe[];
}

const objectSchema = (properties: Readonly<Record<string, unknown>>, required: readonly string[] = []): Readonly<Record<string, unknown>> => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

/** Stable connector metadata for configuration forms and persisted bindings. */
export const CONNECTOR_CATALOG: readonly ConnectorCatalogEntry[] = Object.freeze([
  {
    connector_id: 'API-001',
    display_key: 'connectors.api001',
    category: 'ERP_POS',
    integrated: true,
    config_schema: objectSchema({
      base_url: { type: 'string', format: 'uri' },
      auth_scheme: { type: 'string', enum: ['HMAC_MOCK', 'BEARER', 'BASIC'] },
    }, ['base_url']),
    auth_schemes: ['HMAC_MOCK', 'BEARER', 'BASIC'],
    probes: ['catalog', 'inventory', 'customers', 'orders'],
  },
  {
    connector_id: 'API-002',
    display_key: 'connectors.api002',
    category: 'WEB_EVENTS',
    integrated: true,
    config_schema: objectSchema({ endpoint_url: { type: 'string', format: 'uri' } }, ['endpoint_url']),
    auth_schemes: ['HMAC_MOCK', 'BEARER'],
    probes: [],
  },
  {
    connector_id: 'API-003',
    display_key: 'connectors.api003',
    category: 'MESSAGING',
    integrated: true,
    config_schema: objectSchema({ channel: { type: 'string', minLength: 1 } }, ['channel']),
    auth_schemes: ['HMAC_MOCK', 'BEARER'],
    probes: [],
  },
  {
    connector_id: 'SHOPIFY',
    display_key: 'connectors.shopify',
    category: 'COMMERCE',
    integrated: false,
    config_schema: objectSchema({ shop_domain: { type: 'string', minLength: 1 } }, ['shop_domain']),
    auth_schemes: ['BEARER'],
    probes: ['catalog', 'inventory', 'orders'],
  },
  ...(['ADPT-GL-001', 'ADPT-GL-002', 'ADPT-GL-003'] as const).map((connector_id) => ({
    connector_id,
    display_key: `connectors.${connector_id.toLowerCase()}`,
    category: 'PAYMENT_COMPLIANCE' as const,
    integrated: false,
    config_schema: objectSchema({}),
    auth_schemes: [] as const,
    probes: [] as const,
  })),
]);
