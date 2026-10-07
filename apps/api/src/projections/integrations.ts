import type { CompanyConnectorProjectionSource } from '@agentos/database';

export type IntegrationStatus = 'LIVE' | 'DEMO_MOCK' | 'NOT_CONFIGURED' | 'NOT_INTEGRATED';
export interface IntegrationItem {
  readonly key: string;
  readonly category: string;
  readonly status: IntegrationStatus;
  readonly detail_key: string;
}
export interface IntegrationProviderSource {
  readonly provider?: string | null;
  readonly configured: boolean;
  readonly demo?: boolean;
}
export interface IntegrationsProjectionSources {
  readonly connectors?: readonly CompanyConnectorProjectionSource[];
  readonly readiness_connectors?: readonly { readonly key: string; readonly class: string }[];
  readonly provider?: IntegrationProviderSource;
}

function categoryFor(key: string): string {
  const value = key.toLowerCase();
  if (value.includes('shop') || value.includes('commerce')) return 'commerce';
  if (value.includes('erp') || value.includes('adpt-gl-00')) return 'data';
  if (value.includes('event') || value.includes('line') || value.includes('whatsapp')) return 'communications';
  if (value.includes('provider') || value.includes('openai') || value.includes('api-00')) return 'ai';
  return 'platform';
}

function safeProviderKey(value: string | null | undefined): string {
  return typeof value === 'string' && /^[a-z0-9._-]{1,64}$/i.test(value) ? value : 'ai-provider';
}
/** Projects connector/provider state and intentionally omits secret_ref, URLs, and key material. */
export function mapIntegrations(sources: IntegrationsProjectionSources): readonly IntegrationItem[] {
  const items: IntegrationItem[] = [];
  for (const connector of sources.connectors ?? []) {
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
