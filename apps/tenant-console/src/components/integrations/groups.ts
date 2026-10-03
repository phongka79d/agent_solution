import type { CompanyConnectorItem, ConnectorProbeCheck } from '../../lib/types/tenant-console';

/** Business groups shown on the Integrations page, in workflow §7.8 order. */
export type IntegrationGroupKey = 'data_orders' | 'messaging' | 'ai' | 'payment_compliance';

export const INTEGRATION_GROUPS: readonly IntegrationGroupKey[] = [
  'data_orders',
  'messaging',
  'ai',
  'payment_compliance',
];

const CATEGORY_GROUP: Readonly<Record<string, IntegrationGroupKey>> = {
  ERP_POS: 'data_orders',
  COMMERCE: 'data_orders',
  MESSAGING: 'messaging',
  WEB_EVENTS: 'messaging',
  PAYMENT_COMPLIANCE: 'payment_compliance',
  AI: 'ai',
};

/** Stable contract between the connector catalog and the four UI groups. */
export function groupForConnector(item: CompanyConnectorItem): IntegrationGroupKey {
  return CATEGORY_GROUP[item.catalog_category] ?? 'ai';
}

export const PROBE_LABEL_KEYS: Readonly<Record<string, string>> = {
  catalog: 'integrations.check.catalog',
  inventory: 'integrations.check.inventory',
  customers: 'integrations.check.customers',
  orders: 'integrations.check.orders',
};

export const OTHER_PROBE_LABEL_KEY = 'integrations.check.other';

export function groupConnectors(
  items: readonly CompanyConnectorItem[],
): ReadonlyMap<IntegrationGroupKey, readonly CompanyConnectorItem[]> {
  const grouped = new Map<IntegrationGroupKey, CompanyConnectorItem[]>();
  for (const group of INTEGRATION_GROUPS) grouped.set(group, []);
  for (const item of items) grouped.get(groupForConnector(item))?.push(item);
  return grouped;
}

/** Maps a failed probe check to one localized reason; PASS returns null. */
export function checkErrorKey(check: ConnectorProbeCheck): string | null {
  if (check.outcome === 'PASS') return null;
  if (check.http_status === 401 || check.http_status === 403) return 'integrations.test.auth_failed';
  switch (check.error_class) {
    case 'TIMEOUT':
      return 'integrations.test.timeout';
    case 'CONFIGURATION_INVALID':
      return 'integrations.test.invalid_config';
    case 'NOT_INTEGRATED':
      return 'integrations.test.not_integrated';
    case 'PROVIDER_REJECTED':
      return 'integrations.test.rejected';
    case 'AUTH_FAILED':
    case 'UNAUTHORIZED':
      return 'integrations.test.auth_failed';
    default:
      return 'integrations.test.connection_failed';
  }
}

export interface ConnectorField {
  readonly key: string;
  readonly required: boolean;
  readonly enumValues: readonly string[];
  readonly format: string | null;
  readonly minLength: number | null;
}

/** Reads the connector's JSON-schema `properties` into the flat descriptors the modal renders. */
export function fieldsFor(item: CompanyConnectorItem): readonly ConnectorField[] {
  const schema = item.config_schema;
  const properties = schema['properties'];
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return [];
  const required = Array.isArray(schema['required'])
    ? (schema['required'] as readonly unknown[]).filter((key): key is string => typeof key === 'string')
    : [];
  const fields: ConnectorField[] = [];
  for (const [key, raw] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue;
    const property = raw as Record<string, unknown>;
    fields.push({
      key,
      required: required.includes(key),
      enumValues: Array.isArray(property['enum'])
        ? (property['enum'] as readonly unknown[]).filter((value): value is string => typeof value === 'string')
        : [],
      format: typeof property['format'] === 'string' ? property['format'] : null,
      minLength: typeof property['minLength'] === 'number' ? property['minLength'] : null,
    });
  }
  return fields;
}
