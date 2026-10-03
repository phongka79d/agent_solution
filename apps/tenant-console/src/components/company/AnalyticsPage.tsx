'use client';

import { useEffect, useState } from 'react';
import { t } from '@agentos/ui-foundation/i18n';
import { EmptyState, ErrorState, MetricCard, PageHeader, SectionHeader, Skeleton, StatusBadge } from '@agentos/ui-foundation/react';
import type {
  CompanyAnalyticsKpi,
  CompanyAnalyticsResponse,
  CompanyAnalyticsSourceStatus,
  CompanyAnalyticsWindow,
} from '../../lib/types/tenant-console';
import { tenantConsoleClient } from '../../lib/tenant-console-client';

const WINDOW_LABELS: Record<CompanyAnalyticsWindow, string> = {
  '24h': '24 giờ',
  '7d': '7 ngày',
  '30d': '30 ngày',
};
const WINDOWS: readonly CompanyAnalyticsWindow[] = ['24h', '7d', '30d'];

const KPI_LABELS: Record<string, string> = {
  conversations: 'Hội thoại',
  ai_resolved_rate: 'Tỷ lệ AI tự giải quyết',
  handed_to_staff: 'Chuyển cho nhân viên',
  avg_first_response_ms: 'Thời gian phản hồi đầu tiên (trung bình)',
  approvals: 'Phê duyệt',
  campaigns_by_state: 'Chiến dịch theo trạng thái',
  ai_cost_by_currency: 'Chi phí AI theo tiền tệ',
  failures_by_reason: 'Lỗi theo nguyên nhân',
  revenue_attribution: 'Doanh thu được quy cho AI',
};

const SOURCE_LABELS: Record<CompanyAnalyticsSourceStatus, string> = {
  OK: 'Đủ dữ liệu',
  NO_DATA: 'Chưa có dữ liệu',
  NOT_INTEGRATED: 'Chưa tích hợp',
};

const CAMPAIGN_STATE_LABELS: Record<string, string> = {
  draft: 'Nháp',
  awaiting_approval: 'Chờ phê duyệt',
  approved: 'Đã duyệt',
  running: 'Đang chạy',
  completed: 'Hoàn tất',
};

const EMPTY: readonly CompanyAnalyticsKpi[] = [];

function formatNumber(value: number): string {
  return new Intl.NumberFormat('vi-VN').format(value);
}

function formatKpiValue(kpi: CompanyAnalyticsKpi): string | null {
  if (kpi.value === null) {
    const pending = kpi.detail?.['pending'];
    const decided = kpi.detail?.['decided'];
    return kpi.key === 'approvals' && pending !== undefined && decided !== undefined
      ? formatNumber(pending + decided)
      : null;
  }
  if (kpi.unit === 'percent') return `${formatNumber(kpi.value)}%`;
  if (kpi.unit === 'ms') {
    return kpi.value >= 60_000
      ? `${formatNumber(Math.round(kpi.value / 60_000))} phút`
      : `${formatNumber(Math.round(kpi.value / 1000))} giây`;
  }
  return formatNumber(kpi.value);
}

function kpiDetail(kpi: CompanyAnalyticsKpi): string | null {
  if (kpi.key === 'ai_resolved_rate') {
    const resolved = kpi.detail?.['resolved'];
    const handoff = kpi.detail?.['handed_to_staff'];
    if (resolved !== undefined && handoff !== undefined) {
      return `${formatNumber(resolved)} tự giải quyết · ${formatNumber(handoff)} chuyển nhân viên`;
    }
  }
  if (kpi.key === 'approvals') {
    const pending = kpi.detail?.['pending'];
    const decided = kpi.detail?.['decided'];
    const avg = kpi.detail?.['avg_decision_ms'];
    if (pending !== undefined && decided !== undefined) {
      const avgLabel = avg !== undefined && avg > 0 ? ` · phản hồi trung bình ${formatNumber(Math.round(avg / 60_000))} phút` : '';
      return `${formatNumber(pending)} chờ phê duyệt · ${formatNumber(decided)} đã xử lý${avgLabel}`;
    }
  }
  return null;
}

function SourceTag({ status }: { status: CompanyAnalyticsSourceStatus }) {
  const tone = status === 'OK' ? 'success' : status === 'NOT_INTEGRATED' ? 'warning' : 'neutral';
  return <StatusBadge tone={tone} label={SOURCE_LABELS[status]} />;
}

function breakdownLabel(key: string): string {
  return CAMPAIGN_STATE_LABELS[key] ?? (key === 'UNKNOWN' ? 'Không xác định' : key);
}

function BarChart({ kpi }: { kpi: CompanyAnalyticsKpi }) {
  const [showTable, setShowTable] = useState(false);
  const entries = kpi.breakdown ?? [];
  const max = entries.reduce((peak, entry) => Math.max(peak, entry.value), 0) || 1;

  return (
    <section className="ui-section-card">
      <SectionHeader
        title={KPI_LABELS[kpi.key] ?? kpi.key}
        action={
          <button type="button" className="ui-button ui-button--secondary" onClick={() => setShowTable((previous) => !previous)}>
            {showTable ? 'Xem biểu đồ' : 'Xem bảng'}
          </button>
        }
      />
      <div className="p-5 space-y-3">
        {entries.length === 0 ? (
          <p className="text-sm text-muted">{SOURCE_LABELS[kpi.source_status]}</p>
        ) : showTable ? (
          <table className="ui-table">
            <thead>
              <tr><th scope="col">Mục</th><th scope="col">Số lượng</th></tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.key}><td>{breakdownLabel(entry.key)}</td><td>{formatNumber(entry.value)}</td></tr>
              ))}
            </tbody>
          </table>
        ) : (
          <ul className="space-y-2">
            {entries.map((entry) => (
              <li key={entry.key} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span>{breakdownLabel(entry.key)}</span>
                  <span>{formatNumber(entry.value)}</span>
                </div>
                <div className="h-2 w-full rounded bg-black/10" role="presentation">
                  <div className="h-2 rounded bg-emerald-600" style={{ width: `${Math.round((entry.value / max) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ul>
        )}
        {kpi.key === 'ai_cost_by_currency' && kpi.detail !== undefined ? (
          <p className="text-xs text-muted">
            {Object.entries(kpi.detail).map(([currency, amount]) => `${currency}: ${formatNumber(amount)}`).join(' · ')}
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function AnalyticsPage() {
  const [period, setPeriod] = useState<CompanyAnalyticsWindow>('24h');
  const [snapshot, setSnapshot] = useState<CompanyAnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    void tenantConsoleClient.getCompanyAnalytics(period).then((response) => {
      if (!cancelled) setSnapshot(response);
    }).catch(() => {
      if (!cancelled) setFailed(true);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [period]);

  const kpis = snapshot?.kpis ?? EMPTY;
  const cards = kpis.filter((kpi) => kpi.kind !== 'BREAKDOWN' || kpi.key === 'approvals');
  const charts = kpis.filter((kpi) => kpi.kind === 'BREAKDOWN' && kpi.key !== 'approvals');

  return (
    <div className="space-y-8">
      <PageHeader eyebrow={t('nav.analytics')} title={t('analytics.title')} description={t('analytics.description')} />

      <div className="flex flex-wrap gap-2" role="group" aria-label="Khoảng thời gian">
        {WINDOWS.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={option === period}
            className={`ui-button ${option === period ? 'ui-button--primary' : 'ui-button--secondary'}`}
            onClick={() => setPeriod(option)}
          >
            {WINDOW_LABELS[option]}
          </button>
        ))}
        {snapshot !== null ? (
          <span className="self-center text-xs text-muted">
            Cập nhật lúc {new Date(snapshot.as_of).toLocaleString('vi-VN')}
          </span>
        ) : null}
      </div>

      {failed ? <ErrorState message={t('common.error')} /> : null}
      {loading ? (
        <div className="space-y-4" aria-busy="true">
          <Skeleton variant="metric" lines={4} />
          <Skeleton variant="card" />
          <Skeleton variant="card" />
        </div>
      ) : null}

      {!loading && !failed && kpis.length === 0 ? (
        <EmptyState title={t('analytics.empty')} description={t('analytics.no_source')} status="NO_DATA" />
      ) : null}

      {!loading && !failed && cards.length > 0 ? (
        <section className="ui-section-card">
          <SectionHeader title="Chỉ số chính" />
          <div className="grid gap-4 p-5 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map((kpi) => (
              <MetricCard
                key={kpi.key}
                label={KPI_LABELS[kpi.key] ?? kpi.key}
                value={formatKpiValue(kpi)}
                status={<SourceTag status={kpi.source_status} />}
                detail={
                  kpi.source_status === 'NOT_INTEGRATED'
                    ? <span>Kết nối ERP đơn hàng để xem doanh thu</span>
                    : kpiDetail(kpi)
                }
              />
            ))}
          </div>
        </section>
      ) : null}

      {!loading && !failed ? charts.map((kpi) => <BarChart key={kpi.key} kpi={kpi} />) : null}
    </div>
  );
}
