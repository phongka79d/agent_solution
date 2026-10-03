'use client';

import { useEffect, useMemo, useState } from 'react';
import { ApiError } from '@agentos/ui-foundation';
import { t } from '@agentos/ui-foundation/i18n';
import { channelLabelKey } from '@agentos/ui-foundation/status';
import {
  AdvancedDetails,
  DataClassBadge,
  EmptyState,
  ErrorBanner,
  KeyValueList,
  Skeleton,
  StatusBadge,
  Tabs,
} from '@agentos/ui-foundation/react';
import type { KeyValueItem } from '@agentos/ui-foundation/react';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import { Customer360Timeline } from './Customer360Timeline';

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function formatWhen(value: unknown): string {
  const raw = stringValue(value);
  if (!raw) return '—';
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString('vi-VN');
}

function formatConsent(value: unknown): string {
  if (typeof value !== 'boolean') return '—';
  return value ? 'Đã đồng ý' : 'Chưa đồng ý';
}

/** Per-channel consent rows when the projection supplies them; never inferred from another channel. */
function consentItems(profile: JsonRecord): readonly KeyValueItem[] {
  const items: KeyValueItem[] = [
    { key: 'marketing', label: 'Marketing', value: formatConsent(profile.consent_marketing) },
  ];
  const channels = list(profile.consents)
    .map((entry) => record(entry))
    .filter((entry) => stringValue(entry.channel) !== null);
  const identities = list(profile.identities).map((identity) => record(identity));
  const seen = new Set<string>();
  for (const identity of identities) {
    const channel = stringValue(identity.channel);
    if (!channel || seen.has(channel)) continue;
    seen.add(channel);
    const consent = channels.find((entry) => stringValue(entry.channel) === channel);
    items.push({
      key: `channel-${channel}`,
      label: `Kênh ${t(channelLabelKey(channel))}`,
      value: consent ? formatConsent(consent.granted ?? consent.consent) : '—',
    });
  }
  return items;
}

export interface Customer360ProfileProps {
  readonly customerId: string;
}

export function Customer360Profile({ customerId }: Customer360ProfileProps) {
  const [profile, setProfile] = useState<JsonRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setProfile(null);
    setNotFound(false);
    setError(null);
    void tenantConsoleClient.getCustomerProfile(customerId).then((payload) => {
      if (!active) return;
      setProfile(record(payload));
    }).catch((reason: unknown) => {
      if (!active) return;
      if (reason instanceof ApiError && reason.status === 404) setNotFound(true);
      else setError(reason);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [customerId]);

  const customer = useMemo(() => record(profile?.customer ?? profile), [profile]);
  const displayName = stringValue(customer.display_name) ?? stringValue(customer.name);
  const email = stringValue(customer.email) ?? stringValue(customer.email_masked);
  const phone = stringValue(customer.phone) ?? stringValue(customer.phone_masked);
  const tier = stringValue(customer.tier);
  const verification = stringValue(customer.verification_status);
  const dataClass = stringValue(customer.data_class);
  const segment = stringValue(customer.segment) ?? stringValue(customer.rfm_segment);
  const identities = list(customer.identities).map((identity) => record(identity));
  const orders = list(customer.orders);
  const conversations = list(customer.conversations);
  const campaigns = list(customer.campaign_engagement);
  const recommendations = list(customer.recommendations);
  const serviceCases = list(customer.service_cases);
  const timeline = list(customer.timeline);
  const newestConversationId = conversations
    .map((conversation) => stringValue(record(conversation).conversation_id))
    .find((id): id is string => id !== null);

  if (loading) {
    return (
      <div className="space-y-4 p-4 sm:p-6" aria-busy="true">
        <Skeleton variant="text" lines={2} />
        <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
          <div className="space-y-4">
            <Skeleton variant="card" />
            <Skeleton variant="card" />
            <Skeleton variant="card" />
          </div>
          <Skeleton variant="card" />
        </div>
      </div>
    );
  }
  if (notFound) return <EmptyState title="Chưa có dữ liệu" description="Không tìm thấy hồ sơ khách hàng trong không gian làm việc này." />;
  if (error) return <ErrorBanner error={error} />;

  const identityItems: readonly KeyValueItem[] = [
    ...(email ? [{ key: 'email', label: 'Email (đã che)', value: email }] : []),
    ...(phone ? [{ key: 'phone', label: 'Điện thoại (đã che)', value: phone }] : []),
    ...identities.map((identity, index) => ({
      key: `identity-${index}`,
      label: `Kênh ${t(channelLabelKey(stringValue(identity.channel) ?? ''))}`,
      value: `${stringValue(identity.value) ?? '—'}${identity.verified_at ? ` · xác minh ${formatWhen(identity.verified_at)}` : ''}`,
    })),
    ...(identities.length === 0 && !email && !phone ? [{ key: 'none', label: 'Định danh', value: 'Chưa có định danh đã xác minh' }] : []),
  ];

  const profileItems: readonly KeyValueItem[] = [
    { key: 'segment', label: 'Phân khúc', value: segment ?? '—' },
    { key: 'total_spent', label: 'Tổng chi tiêu', value: stringValue(customer.total_spent) ?? '—' },
    { key: 'order_count', label: 'Số đơn', value: typeof customer.order_count === 'number' ? customer.order_count.toLocaleString() : '—' },
    { key: 'created_at', label: 'Tạo hồ sơ', value: formatWhen(customer.created_at) },
    { key: 'last_activity', label: 'Hoạt động gần nhất', value: formatWhen(customer.last_activity_at) },
    ...(customer.suppression_active === true ? [{ key: 'suppression', label: 'Chặn liên hệ', value: 'Đang chặn (suppression)' }] : []),
  ];

  const emptyTab = <EmptyState title="Chưa có dữ liệu" />;
  const suggestionsLabel = 'Gợi ý bán hàng (Dự đoán)';

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <header className="ui-section-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold text-ink">{displayName ?? `Khách #${customerId.slice(-4).toUpperCase()}`}</h1>
              {tier ? <StatusBadge code={tier} label={tier} tone="neutral" /> : null}
              {verification ? <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">Xác minh: {verification}</span> : null}
              {dataClass ? <DataClassBadge code={dataClass} /> : null}
            </div>
            <p className="mt-1 text-sm text-muted">{email ?? phone ?? 'Chưa có liên hệ đã xác minh'}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <a
              className="ui-button ui-button--secondary"
              href={newestConversationId ? `/conversations?c=${encodeURIComponent(newestConversationId)}` : '/conversations'}
            >
              Mở hội thoại
            </a>
            {dataClass === 'TEST' ? (
              <a className="ui-button ui-button--secondary" href={`/testing/customers/${encodeURIComponent(customerId)}/storefront`}>
                Khởi chạy Storefront như khách này
              </a>
            ) : null}
          </div>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
        <div className="space-y-4">
          <section className="ui-section-card p-5" aria-label="Định danh">
            <h2 className="mb-3 text-sm font-semibold text-ink">Định danh</h2>
            <KeyValueList items={identityItems} emptyLabel="Chưa có định danh" />
          </section>
          <section className="ui-section-card p-5" aria-label="Hồ sơ và phân khúc">
            <h2 className="mb-3 text-sm font-semibold text-ink">Hồ sơ &amp; Phân khúc</h2>
            <KeyValueList items={profileItems} />
          </section>
          <section className="ui-section-card p-5" aria-label="Đồng ý theo kênh">
            <h2 className="mb-3 text-sm font-semibold text-ink">Đồng ý theo kênh</h2>
            <KeyValueList items={consentItems(customer)} emptyLabel="Chưa có dữ liệu đồng ý" />
          </section>
          <section className="ui-section-card p-5" aria-label="Đơn hàng gần đây">
            <h2 className="mb-3 text-sm font-semibold text-ink">Đơn hàng gần đây</h2>
            {orders.length === 0 ? <p className="text-sm text-muted">Chưa có đơn hàng.</p> : <ListItems values={orders.slice(0, 3)} />}
          </section>
        </div>

        <Tabs tabs={[
          { id: 'timeline', label: 'Dòng thời gian', content: <Customer360Timeline initialCustomerId={customerId} sources={timeline} /> },
          { id: 'orders', label: 'Đơn hàng', content: orders.length ? <ListItems values={orders} /> : emptyTab },
          { id: 'conversations', label: 'Hội thoại', content: conversations.length ? <ListItems values={conversations} /> : emptyTab },
          { id: 'campaigns', label: 'Chiến dịch', content: campaigns.length ? <ListItems values={campaigns} /> : emptyTab },
          { id: 'recommendations', label: suggestionsLabel, content: recommendations.length ? <ListItems values={recommendations} /> : emptyTab },
          { id: 'support', label: 'Hỗ trợ', content: serviceCases.length ? <ListItems values={serviceCases} /> : emptyTab },
        ]} />
      </div>

      <AdvancedDetails summary="Chi tiết kỹ thuật">
        <dl className="grid gap-2 text-xs sm:grid-cols-2">
          <div><dt className="text-muted">customer_id</dt><dd>{customerId}</dd></div>
          {stringValue(customer.tenant_id) ? <div><dt className="text-muted">tenant_id</dt><dd>{customer.tenant_id as string}</dd></div> : null}
        </dl>
      </AdvancedDetails>
    </div>
  );
}

function ListItems({ values }: { readonly values: readonly unknown[] }) {
  return (
    <ul className="space-y-2">
      {values.map((value, index) => {
        const item = record(value);
        const classification = stringValue(item.classification);
        const title = stringValue(item.title) ?? stringValue(item.order_number) ?? stringValue(item.summary) ?? stringValue(item.reason) ?? 'Mục dữ liệu';
        const detail = stringValue(item.status) ?? stringValue(item.state) ?? stringValue(item.channel) ?? stringValue(item.converted_at);
        return (
          <li key={index} className="ui-section-card p-3 text-sm">
            {classification === 'HYPOTHESIS' ? <span className="mr-2 rounded-full border border-line px-2 py-0.5 text-xs">Dự đoán</span> : null}
            <span className="text-ink">{typeof value === 'string' ? value : title}</span>
            {detail ? <span className="ml-2 text-xs text-muted">{detail}</span> : null}
          </li>
        );
      })}
    </ul>
  );
}
