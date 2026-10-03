'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  DataClassBadge,
  DataTable,
  EmptyState,
  ErrorBanner,
  PageHeader,
  SearchInput,
  Skeleton,
  TableToolbar,
} from '@agentos/ui-foundation/react';
import type { DataTableColumn } from '@agentos/ui-foundation/react';
import { Select } from '@agentos/ui-foundation/react';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import { t } from '@agentos/ui-foundation/i18n';
import { channelLabelKey } from '@agentos/ui-foundation/status';

interface Customer {
  readonly id: string;
  readonly displayName: string | null;
  readonly tier: string | null;
  readonly verification: string | null;
  readonly segment: string | null;
  readonly consentMarketing: boolean | null;
  readonly dataClass: string | null;
  readonly contact: string | null;
  readonly channels: readonly string[];
  readonly orderCount: number | null;
  readonly lastActivityAt: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function customer(value: unknown): Customer | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const id = text(item.customer_id) ?? text(item.id);
  if (!id) return null;
  const identities = Array.isArray(item.identities) ? item.identities : [];
  const channels = identities
    .map((identity) => (identity && typeof identity === 'object' ? text((identity as Record<string, unknown>).channel) : null))
    .filter((channel): channel is string => channel !== null);
  const contact = text(item.email) ?? text(item.phone);
  const orderCount = typeof item.order_count === 'number' ? item.order_count : null;
  const consent = typeof item.consent_marketing === 'boolean' ? item.consent_marketing : null;
  return {
    id,
    displayName: text(item.display_name),
    tier: text(item.tier),
    verification: text(item.verification_status),
    segment: text(item.segment) ?? text(item.rfm_segment),
    consentMarketing: consent,
    dataClass: text(item.data_class),
    contact,
    channels,
    orderCount,
    lastActivityAt: text(item.last_activity_at),
  };
}

/** The list has no stored last-activity column yet; the profile timestamp sorts honestly last. */
function shortId(id: string): string {
  return id.replace(/[^0-9a-zA-Z]/g, '').slice(-4).toUpperCase() || id.slice(0, 4).toUpperCase();
}

function formatWhen(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

const TIER_LABELS: Record<string, string> = {
  GUEST: 'Khách vãng lai',
  IDENTIFIED: 'Đã nhận diện',
  VERIFIED: 'Đã xác minh',
  STANDARD: 'Tiêu chuẩn',
  SILVER: 'Bạc',
  GOLD: 'Vàng',
  VIP: 'VIP',
};

const VERIFICATION_LABELS: Record<string, string> = {
  VERIFIED: 'Đã xác minh',
  UNVERIFIED: 'Chưa xác minh',
  PENDING: 'Đang chờ',
};

const CONSENT_LABELS: Record<string, string> = {
  true: 'Đã đồng ý',
  false: 'Chưa đồng ý',
};

function formatTier(tier: string | null): string {
  if (!tier) return '—';
  return TIER_LABELS[tier.toUpperCase()] ?? tier;
}

function formatVerification(verification: string | null): string {
  if (!verification) return '—';
  return VERIFICATION_LABELS[verification.toUpperCase()] ?? verification;
}

function formatConsent(consent: boolean | null): string {
  if (consent === null) return '—';
  return CONSENT_LABELS[String(consent)] ?? '—';
}

export function CustomerList() {
  const [items, setItems] = useState<Customer[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState('');
  const [segment, setSegment] = useState('');
  const [tier, setTier] = useState('');
  const [consent, setConsent] = useState('');
  const [dataClass, setDataClass] = useState('');

  async function load(search: string, append = false): Promise<void> {
    if (append) setMore(true); else setLoading(true);
    setError(null);
    try {
      const payload = await tenantConsoleClient.getCustomers({
        limit: 50,
        ...(search ? { query: search } : {}),
        ...(append && cursor ? { cursor } : {}),
      });
      const next = (Array.isArray(payload.items) ? payload.items : [])
        .map(customer)
        .filter((value): value is Customer => value !== null);
      setItems((previous) => append ? [...previous, ...next.filter((item) => !previous.some((old) => old.id === item.id))] : next);
      const nextCursor = payload.next_cursor ?? payload.nextCursor;
      setCursor(typeof nextCursor === 'string' && nextCursor ? nextCursor : null);
    } catch (reason: unknown) {
      setError(reason);
    } finally { setLoading(false); setMore(false); }
  }

  useEffect(() => {
    const handle = setTimeout(() => { void load(query); }, 250);
    return () => clearTimeout(handle);
    // The cursor is intentionally not a dependency: a new query always restarts the page.
  }, [query]);

  const segments = useMemo(() => [...new Set(items.map((item) => item.segment).filter((value): value is string => value !== null))], [items]);
  const tiers = useMemo(() => [...new Set(items.map((item) => item.tier).filter((value): value is string => value !== null))], [items]);
  const dataClasses = useMemo(() => [...new Set(items.map((item) => item.dataClass).filter((value): value is string => value !== null))], [items]);

  const rows = useMemo(() => items.filter((item) => (
    (segment === '' || item.segment === segment)
    && (tier === '' || item.tier === tier)
    && (consent === '' || formatConsent(item.consentMarketing) === consent)
    && (dataClass === '' || item.dataClass === dataClass)
  )), [items, segment, tier, consent, dataClass]);

  const columns: readonly DataTableColumn<Customer>[] = [
    {
      key: 'display_name',
      header: 'Khách hàng',
      render: (row) => (
        <a className="ui-focus-ring rounded-sm font-medium text-ink" href={`/customers/${encodeURIComponent(row.id)}`}>
          {row.displayName ?? `Khách #${shortId(row.id)}`}
          {row.contact ? <span className="mt-0.5 block text-xs text-muted">{row.contact}</span> : null}
        </a>
      ),
    },
    { key: 'tier', header: 'Hạng', render: (row) => formatTier(row.tier) },
    { key: 'verification', header: 'Xác minh', render: (row) => formatVerification(row.verification) },
    { key: 'channels', header: 'Kênh', render: (row) => row.channels.map((channel) => t(channelLabelKey(channel))).join(', ') || '—' },
    { key: 'last_activity_at', header: 'Hoạt động gần nhất', render: (row) => formatWhen(row.lastActivityAt) },
    { key: 'order_count', header: 'Số đơn', numeric: true, render: (row) => (row.orderCount === null ? '—' : row.orderCount.toLocaleString()) },
    { key: 'consent_marketing', header: 'Đồng ý marketing', render: (row) => formatConsent(row.consentMarketing) },
    { key: 'data_class', header: 'Loại dữ liệu', render: (row) => (row.dataClass ? <DataClassBadge code={row.dataClass} /> : '—') },
  ];

  const empty = (
    <EmptyState
      title="Chưa có khách hàng"
      description="Khách xuất hiện khi họ chat qua widget hoặc khi đồng bộ từ ERP."
      action={<a className="ui-button ui-button--secondary" href="/testing">Tạo khách thử nghiệm</a>}
    />
  );

  return (
    <div className="space-y-6">
      <PageHeader title="Khách hàng" description="Hồ sơ và hoạt động khách hàng trong không gian làm việc." />
      {error ? <ErrorBanner error={error} onRetry={() => void load(query)} /> : null}
      <section className="ui-section-card p-5" aria-label="Danh sách khách hàng">
        <TableToolbar
          search={
            <SearchInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              label="Tìm khách hàng theo tên, email hoặc số điện thoại"
              placeholder="Tìm khách hàng…"
            />
          }
          filters={
            <>
              <Select aria-label="Lọc theo phân khúc" value={segment} onChange={(event) => setSegment(event.target.value)} options={[{ value: '', label: 'Phân khúc: tất cả' }, ...segments.map((value) => ({ value, label: value }))]} />
              <Select aria-label="Lọc theo hạng" value={tier} onChange={(event) => setTier(event.target.value)} options={[{ value: '', label: 'Hạng: tất cả' }, ...tiers.map((value) => ({ value, label: formatTier(value) }))]} />
              <Select aria-label="Lọc theo đồng ý marketing" value={consent} onChange={(event) => setConsent(event.target.value)} options={[{ value: '', label: 'Đồng ý: tất cả' }, { value: 'Đã đồng ý', label: 'Đã đồng ý' }, { value: 'Chưa đồng ý', label: 'Chưa đồng ý' }]} />
              <Select aria-label="Lọc theo loại dữ liệu" value={dataClass} onChange={(event) => setDataClass(event.target.value)} options={[{ value: '', label: 'Loại dữ liệu: tất cả' }, ...dataClasses.map((value) => ({ value, label: value }))]} />
            </>
          }
        />
        {loading ? (
          <Skeleton variant="table" lines={6} />
        ) : (
          <DataTable
            caption="Khách hàng"
            columns={columns}
            rows={rows}
            getRowKey={(row) => row.id}
            empty={items.length === 0 ? empty : <EmptyState title="Không có khách hàng khớp bộ lọc" />}
          />
        )}
        {cursor ? (
          <button type="button" className="ui-button ui-button--secondary mt-4" onClick={() => void load(query, true)} disabled={more}>
            {more ? 'Đang tải…' : 'Xem thêm'}
          </button>
        ) : null}
      </section>
    </div>
  );
}
