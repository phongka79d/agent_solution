import { CONNECTOR_CATALOG, type ConnectorCatalogEntry } from '@agentos/adapters';
import type { CompanyConnectorProjectionSource, ConnectorBindingRecord } from '@agentos/database';
import { isPristineConnectorBinding } from '@agentos/database';

export type IntegrationStatus = 'LIVE' | 'DEMO_MOCK' | 'NOT_CONFIGURED' | 'NOT_INTEGRATED';
export interface IntegrationItem {
  readonly key: string;
  readonly category: string;
  readonly status: IntegrationStatus;
  readonly detail_key: string;
  readonly probe?: {
    readonly outcome: 'PASS' | 'FAIL';
    readonly latency_ms: number | null;
    readonly http_status: number | null;
    readonly error_class: string | null;
    readonly probed_at: string | null;
  };
}
export interface IntegrationProviderSource {
  readonly provider?: string | null;
  readonly configured: boolean;
  readonly demo?: boolean;
}
export type IntegrationBindingSource = ConnectorBindingRecord;
export interface IntegrationsProjectionSources {
  readonly catalog?: readonly ConnectorCatalogEntry[];
  readonly bindings?: readonly IntegrationBindingSource[];
  /** Tenant data class and environment eligibility; explicit bindings still take precedence. */
  readonly demo_erp_eligible?: boolean;
  readonly connectors?: readonly CompanyConnectorProjectionSource[];
  readonly readiness_connectors?: readonly { readonly key: string; readonly class: string }[];
  readonly provider?: IntegrationProviderSource;
}

const CATALOG_CATEGORIES: Record<ConnectorCatalogEntry['category'], string> = {
  ERP_POS: 'data',
  WEB_EVENTS: 'events',
  MESSAGING: 'communications',
  COMMERCE: 'commerce',
  PAYMENT_COMPLIANCE: 'compliance',
};

function categoryFor(key: string): string {
  const entry = CONNECTOR_CATALOG.find((candidate) => candidate.connector_id === key);
  if (entry !== undefined) return CATALOG_CATEGORIES[entry.category];
  const value = key.toLowerCase();
  if (value.includes('shop') || value.includes('commerce')) return 'commerce';
  if (value.includes('erp') || value.includes('adpt-gl-00')) return 'data';
  if (value.includes('event')) return 'events';
  if (value.includes('line') || value.includes('whatsapp')) return 'communications';
  if (value.includes('provider') || value.includes('openai')) return 'ai';
  return 'platform';
}

function safeProviderKey(value: string | null | undefined): string {
  return typeof value === 'string' && /^[a-z0-9._-]{1,64}$/i.test(value) ? value : 'ai-provider';
}
/** Projects connector/provider state and intentionally omits secret_ref, URLs, and key material. */
export function mapIntegrations(sources: IntegrationsProjectionSources): readonly IntegrationItem[] {
  const items: IntegrationItem[] = [];
  const useCatalogBindings = sources.catalog !== undefined || sources.bindings !== undefined;
  if (useCatalogBindings) {
    const catalog = sources.catalog ?? CONNECTOR_CATALOG;
    const bindingById = new Map((sources.bindings ?? []).map((binding) => [binding.connector_id, binding]));
    for (const entry of catalog) {
      const binding = bindingById.get(entry.connector_id);
      const demoFallback = entry.connector_id === 'API-001'
        && sources.demo_erp_eligible === true
        && isPristineConnectorBinding(binding);
      const status: IntegrationStatus = !entry.integrated || binding?.status === 'DISABLED'
        ? 'NOT_INTEGRATED'
        : demoFallback
          ? 'DEMO_MOCK'
          : binding === undefined || binding.status === 'UNBOUND'
            ? 'NOT_CONFIGURED'
            : binding.status !== 'BOUND' || binding.probe_outcome !== 'PASS'
              ? 'NOT_INTEGRATED'
              : binding.mode === 'MOCK'
                ? 'DEMO_MOCK'
                : 'LIVE';
      const probeOutcome = binding?.probe_outcome;
      const probe: IntegrationItem['probe'] = binding === undefined || (probeOutcome !== 'PASS' && probeOutcome !== 'FAIL')
        ? undefined
        : {
            outcome: probeOutcome,
            latency_ms: binding.probe_latency_ms,
            http_status: binding.probe_http_status,
            error_class: binding.probe_error_class,
            probed_at: binding.probed_at,
          };
      items.push({
        key: entry.connector_id,
        category: CATALOG_CATEGORIES[entry.category],
        status,
        detail_key: status === 'NOT_CONFIGURED'
          ? 'company.integrations.not_configured'
          : status === 'NOT_INTEGRATED'
            ? 'company.integrations.not_integrated'
            : status === 'DEMO_MOCK'
              ? 'company.integrations.demo_mock'
              : 'company.integrations.live',
        ...(probe === undefined ? {} : { probe }),
      });
    }
  }
  if (!useCatalogBindings) for (const connector of sources.connectors ?? []) {
    const status: IntegrationStatus = connector.status === 'UNBOUND'
      ? 'NOT_CONFIGURED'
      : connector.status === 'DISABLED'
        ? 'NOT_INTEGRATED'
        : connector.status === 'DEMO_MOCK'
          ? 'DEMO_MOCK'
          : 'LIVE';
    items.push({
      key: connector.connector_id,
      category: categoryFor(connector.connector_id),
      status,
      detail_key: status === 'NOT_CONFIGURED'
        ? 'company.integrations.not_configured'
        : status === 'NOT_INTEGRATED'
          ? 'company.integrations.not_integrated'
          : status === 'DEMO_MOCK'
            ? 'company.integrations.demo_mock'
            : 'company.integrations.live',
    });
  }
  for (const readiness of sources.readiness_connectors ?? []) {
    const status: IntegrationStatus = readiness.class === 'DEMO_MOCK'
      ? 'DEMO_MOCK'
      : readiness.class === 'LIVE'
        ? 'LIVE'
        : 'NOT_CONFIGURED';
    items.push({
      key: readiness.key,
      category: categoryFor(readiness.key),
      status,
      detail_key: status === 'DEMO_MOCK'
        ? 'company.integrations.demo_mock'
        : status === 'LIVE'
          ? 'company.integrations.live'
          : 'company.integrations.not_configured',
    });
  }
  if (sources.provider !== undefined) {
    const status: IntegrationStatus = sources.provider.demo === true
      ? 'DEMO_MOCK'
      : sources.provider.configured
        ? 'LIVE'
        : 'NOT_CONFIGURED';
    items.push({
      key: safeProviderKey(sources.provider.provider),
      category: 'ai',
      status,
      detail_key: status === 'LIVE'
        ? 'company.integrations.live'
        : status === 'DEMO_MOCK'
          ? 'company.integrations.demo_mock'
          : 'company.integrations.not_configured',
    });
  }
  return items;
}

export const projectIntegrations = mapIntegrations;
