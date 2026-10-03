'use client';

import { can } from '@agentos/ui-foundation/auth';
import { t } from '@agentos/ui-foundation/i18n';
import {
  AdvancedDetails,
  Button,
  ConfirmDialog,
  Drawer,
  EmptyState,
  ErrorBanner,
  KeyValueList,
  PageHeader,
  SectionHeader,
  Skeleton,
  StatusBadge,
  Toast,
} from '@agentos/ui-foundation/react';
import { statusView } from '@agentos/ui-foundation/status';
import { useEffect, useState } from 'react';
import Link from 'next/link';

import type {
  CompanyConnectorItem,
  ConnectorProbeResult,
} from '../../lib/types/tenant-console';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import { useSession } from '../auth/SessionProvider';
import { ConnectModal } from '../integrations/ConnectModal';
import { INTEGRATION_GROUPS, groupConnectors, type IntegrationGroupKey } from '../integrations/groups';
import { TestResultPanel } from '../integrations/TestResultPanel';

interface CardTest { readonly pending: boolean; readonly result: ConnectorProbeResult | null; readonly error: unknown }

const GROUP_HINT_KEYS: Readonly<Record<IntegrationGroupKey, string>> = {
  data_orders: 'integrations.group.data_orders.hint',
  messaging: 'integrations.group.messaging.hint',
  ai: 'integrations.group.ai.hint',
  payment_compliance: 'integrations.group.payment_compliance.hint',
};

function formatTimestamp(value: string | null): string {
  if (value === null) return t('integrations.never_checked');
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('vi-VN');
}

function connectorStatus(item: CompanyConnectorItem): string {
  const binding = item.binding;
  if (!item.integrated || binding === null) return item.status;
  if (binding.status === 'BOUND') {
    if (binding.probe?.outcome !== 'PASS') return 'NOT_INTEGRATED';
    return binding.mode === 'MOCK' ? 'DEMO_MOCK' : 'LIVE';
  }
  if (binding.status === 'DEGRADED' && binding.probe?.outcome === 'FAIL') return 'ERROR';
  return binding.status;
}

export function IntegrationsPage() {
  const session = useSession();
  const canManage = can(session, 'integration:manage');
  const [items, setItems] = useState<readonly CompanyConnectorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [editing, setEditing] = useState<CompanyConnectorItem | null>(null);
  const [details, setDetails] = useState<CompanyConnectorItem | null>(null);
  const [cards, setCards] = useState<Record<string, CardTest>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void tenantConsoleClient.getCompanyIntegrations().then((response) => {
      if (!cancelled) setItems(response.items);
    }).catch((caught: unknown) => {
      if (!cancelled) setError(caught);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, []);

  function applyBinding(connectorId: string, binding: CompanyConnectorItem['binding']): void {
    setItems((previous) => previous.map((item) => item.connector_id === connectorId ? { ...item, binding } : item));
  }

  async function runTest(item: CompanyConnectorItem): Promise<void> {
    setCards((previous) => ({ ...previous, [item.connector_id]: { pending: true, result: null, error: null } }));
    try {
      const result = await tenantConsoleClient.testCompanyIntegration(item.connector_id);
      applyBinding(item.connector_id, result.binding);
      setCards((previous) => ({ ...previous, [item.connector_id]: { pending: false, result, error: null } }));
    } catch (error) {
      setCards((previous) => ({ ...previous, [item.connector_id]: { pending: false, result: null, error } }));
    }
  }

  async function disconnect(item: CompanyConnectorItem): Promise<void> {
    setDisconnecting(true);
    try {
      const response = await tenantConsoleClient.disconnectCompanyIntegration(
        item.connector_id,
        item.binding?.version ?? 1,
      );
      applyBinding(item.connector_id, response.binding);
      setDetails(null);
      setNotice(t('integrations.disconnect.done'));
    } catch (caught) {
      setDetails(null);
      setCards((previous) => ({ ...previous, [item.connector_id]: { pending: false, result: null, error: caught } }));
    } finally {
      setDisconnecting(false);
    }
  }

  const grouped = groupConnectors(items);

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={t('nav.integrations')}
        title={t('integrations.title')}
        description={t('integrations.description')}
      />
      {notice === null ? null : <Toast tone="success" message={notice} onDismiss={() => setNotice(null)} />}
      {error === null ? null : <ErrorBanner error={error} onRetry={() => window.location.reload()} />}
      {loading ? (
        <Skeleton variant="card" />
      ) : items.length === 0 && error === null ? (
        <EmptyState title={t('integrations.empty')} />
      ) : (
        INTEGRATION_GROUPS.map((group) => {
          const connectors = grouped.get(group) ?? [];
          return (
            <section key={group} className="ui-section-card">
              <SectionHeader title={t(`integrations.group.${group}`)} description={t(GROUP_HINT_KEYS[group])} />
              <div className="grid gap-4 p-5 md:grid-cols-2">
                {connectors.map((item) => (
                  <IntegrationCard
                    key={item.connector_id}
                    item={item}
                    canManage={canManage}
                    test={cards[item.connector_id]}
                    onConnect={() => setEditing(item)}
                    onTest={() => void runTest(item)}
                    onDetails={() => setDetails(item)}
                  />
                ))}
                {connectors.length === 0 ? <EmptyGroupCard group={group} /> : null}
              </div>
            </section>
          );
        })
      )}
      <ConnectModal
        open={editing !== null}
        item={editing}
        onClose={() => setEditing(null)}
        onSaved={(connectorId, binding) => applyBinding(connectorId, binding)}
      />
      <DetailsDrawer
        item={details}
        canManage={canManage}
        disconnecting={disconnecting}
        onClose={() => setDetails(null)}
        onDisconnect={(item) => void disconnect(item)}
      />
    </div>
  );
}

interface IntegrationCardProps {
  readonly item: CompanyConnectorItem;
  readonly canManage: boolean;
  readonly test: CardTest | undefined;
  readonly onConnect: () => void;
  readonly onTest: () => void;
  readonly onDetails: () => void;
}

function IntegrationCard({ item, canManage, test, onConnect, onTest, onDetails }: IntegrationCardProps) {
  const view = statusView('connector', connectorStatus(item));
  const lastCheck = item.binding?.probe?.probed_at ?? item.probe?.probed_at ?? null;
  const canConnect = canManage && item.integrated && item.binding !== null;
  const canTest = canManage && item.integrated && item.probes.length > 0;

  return (
    <article className="rounded-xl border border-line p-4" data-testid={`connector-card-${item.connector_id}`}>
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold text-ink">{t(item.display_key)}</h3>
        <StatusBadge tone={view.tone} label={t(view.label_key)} />
      </div>
      <p className="mt-2 text-sm text-muted">{t(`${item.display_key}.purpose`)}</p>
      <p className="mt-3 text-xs text-muted">
        {`${t('integrations.last_check')}: ${formatTimestamp(lastCheck)}`}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" disabled={!canConnect} onClick={onConnect}>{t('integrations.action.connect')}</Button>
        <Button size="sm" variant="secondary" disabled={!canTest} onClick={onTest}>{t('integrations.action.test')}</Button>
        <Button size="sm" variant="ghost" onClick={onDetails}>{t('integrations.action.details')}</Button>
      </div>
      {test === undefined ? null : (
        <div className="mt-4">
          <TestResultPanel result={test.result} pending={test.pending} error={test.error} />
        </div>
      )}
    </article>
  );
}

function EmptyGroupCard({ group }: { readonly group: IntegrationGroupKey }) {
  return (
    <article className="rounded-xl border border-dashed border-line p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="font-semibold text-ink">{t(`integrations.group.${group}`)}</h3>
        <StatusBadge tone={statusView('connector', 'NOT_INTEGRATED').tone} label={t('integrations.group.empty')} />
      </div>
      <p className="mt-2 text-sm text-muted">{t('integrations.group.empty_hint')}</p>
      {group === 'ai' ? (
        <p className="mt-3 text-sm">
          {t('integrations.ai.managed')}{' '}
          <Link className="underline" href="/settings">{t('integrations.ai.manage')}</Link>
        </p>
      ) : null}
    </article>
  );
}

interface DetailsDrawerProps {
  readonly item: CompanyConnectorItem | null;
  readonly canManage: boolean;
  readonly disconnecting: boolean;
  readonly onClose: () => void;
  readonly onDisconnect: (item: CompanyConnectorItem) => void;
}

function DetailsDrawer({ item, canManage, disconnecting, onClose, onDisconnect }: DetailsDrawerProps) {
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { setConfirming(false); }, [item]);
  if (item === null) return null;

  const binding = item.binding;
  const view = statusView('connector', connectorStatus(item));
  return (
    <>
      <Drawer open onClose={onClose} title={t('integrations.details.title')} description={t(item.display_key)}>
        {binding === null ? (
          <p className="text-sm text-muted">{t('integrations.details.no_binding')}</p>
        ) : (
          <div className="space-y-4">
            <KeyValueList
              items={[
                { key: 'connector_id', label: t('integrations.details.connector_id'), value: item.connector_id },
                { key: 'category', label: t('integrations.details.category'), value: item.catalog_category },
                { key: 'status', label: t('integrations.details.status'), value: t(view.label_key) },
                { key: 'mode', label: t('integrations.details.mode'), value: binding.mode },
                { key: 'version', label: t('integrations.details.version'), value: String(binding.version) },
                { key: 'bound_at', label: t('integrations.details.bound_at'), value: formatTimestamp(binding.bound_at) },
                {
                  key: 'fingerprint',
                  label: t('integrations.secret.fingerprint'),
                  value: binding.secret ? `${binding.secret.fingerprint} · ••••${binding.secret.last4}` : t('integrations.secret.none'),
                },
              ]}
            />
            <AdvancedDetails summary={t('integrations.action.advanced')}>
              <KeyValueList
                items={[
                  { key: 'status_code', label: t('integrations.details.status_code'), value: item.status },
                  { key: 'config', label: t('integrations.details.config'), value: JSON.stringify(binding.config) },
                  {
                    key: 'probe',
                    label: t('integrations.details.probe'),
                    value: binding.probe === null
                      ? t('integrations.never_checked')
                      : [
                          binding.probe.outcome,
                          binding.probe.http_status === null ? 'http_status=null' : `http_status=${binding.probe.http_status}`,
                          binding.probe.error_class === null ? 'error_class=null' : `error_class=${binding.probe.error_class}`,
                        ].join(' · '),
                  },
                ]}
              />
            </AdvancedDetails>
            {canManage ? (
              <Button variant="danger" disabled={disconnecting} onClick={() => setConfirming(true)}>
                {t('integrations.action.disconnect')}
              </Button>
            ) : null}
          </div>
        )}
      </Drawer>
      <ConfirmDialog
        open={confirming}
        tone="danger"
        title={t('integrations.disconnect.confirm_title', { name: t(item.display_key) })}
        description={t('integrations.disconnect.confirm_body')}
        confirmLabel={t('integrations.action.disconnect')}
        busy={disconnecting}
        onConfirm={() => onDisconnect(item)}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
