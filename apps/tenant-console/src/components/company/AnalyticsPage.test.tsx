import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getCompanyAnalytics: vi.fn() }));

vi.mock('../../lib/tenant-console-client', () => ({ tenantConsoleClient: mocks }));

import { AnalyticsPage } from './AnalyticsPage';

const SNAPSHOT = {
  window: '24h',
  as_of: '2026-04-08T00:00:00.000Z',
  kpis: [
    {
      key: 'conversations',
      kind: 'NUMBER',
      value: 42,
      unit: 'count',
      source_status: 'OK',
      as_of: '2026-04-08T00:00:00.000Z',
    },
    {
      key: 'ai_resolved_rate',
      kind: 'PERCENT',
      value: 80,
      unit: 'percent',
      source_status: 'OK',
      as_of: '2026-04-08T00:00:00.000Z',
      detail: { resolved: 40, handed_to_staff: 10 },
    },
    {
      key: 'revenue_attribution',
      kind: 'NUMBER',
      value: null,
      unit: 'count',
      source_status: 'NOT_INTEGRATED',
      as_of: '2026-04-08T00:00:00.000Z',
      note: 'revenue_attribution_requires_order_erp',
    },
    {
      key: 'campaigns_by_state',
      kind: 'BREAKDOWN',
      value: 3,
      unit: 'count',
      source_status: 'OK',
      as_of: '2026-04-08T00:00:00.000Z',
      breakdown: [
        { key: 'running', value: 2 },
        { key: 'draft', value: 1 },
      ],
    },
  ],
} as const;

describe('AnalyticsPage', () => {
  afterEach(() => {
    cleanup();
    mocks.getCompanyAnalytics.mockReset();
  });

  it('shows KPI skeletons while analytics are loading', () => {
    const pending = new Promise<never>(() => {
      // Keep the request unresolved so the loading skeleton remains visible.
    });
    mocks.getCompanyAnalytics.mockReturnValue(pending);

    const { container } = render(<AnalyticsPage />);

    expect(container.querySelector('.ui-skeleton')).not.toBeNull();
  });

  it('renders KPI cards and a chart with a table alternative', async () => {
    mocks.getCompanyAnalytics.mockResolvedValue(SNAPSHOT);
    render(<AnalyticsPage />);

    await waitFor(() => expect(screen.getByText('Hội thoại')).toBeTruthy());
    expect(screen.getByText('42')).toBeTruthy();
    expect(screen.getByText('80%')).toBeTruthy();
    expect(screen.getByText('Chưa tích hợp')).toBeTruthy();
    expect(screen.getAllByText('Doanh thu được quy cho AI').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByText('Xem bảng'));
    await waitFor(() => expect(screen.getByText('Đang chạy')).toBeTruthy());
    expect(screen.getByText('Nháp')).toBeTruthy();
  });

  it('renders approval totals and pending/decided counts from a detail-only breakdown', async () => {
    mocks.getCompanyAnalytics.mockResolvedValue({
      ...SNAPSHOT,
      kpis: [{
        key: 'approvals', kind: 'BREAKDOWN', value: 12, unit: 'count', source_status: 'OK',
        as_of: SNAPSHOT.as_of, detail: { pending: 5, decided: 7, avg_decision_ms: 120_000 },
      }],
    });
    render(<AnalyticsPage />);

    const heading = await screen.findByRole('heading', { name: 'Phê duyệt' });
    const card = heading.closest('article');
    if (card === null) throw new Error('Approval totals must render as a metric card.');
    expect(within(card).getByText('12')).toBeTruthy();
    expect(within(card).getByText('5 chờ phê duyệt · 7 đã xử lý · phản hồi trung bình 2 phút')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Xem bảng' })).toBeNull();
  });

  it('keeps zero pending and decided approval counts visible when there is no activity', async () => {
    mocks.getCompanyAnalytics.mockResolvedValue({
      ...SNAPSHOT,
      kpis: [{
        key: 'approvals', kind: 'BREAKDOWN', value: null, unit: 'count', source_status: 'NO_DATA',
        as_of: SNAPSHOT.as_of, detail: { pending: 0, decided: 0, avg_decision_ms: 0 },
      }],
    });
    render(<AnalyticsPage />);

    const heading = await screen.findByRole('heading', { name: 'Phê duyệt' });
    const card = heading.closest('article');
    if (card === null) throw new Error('Approval totals must render as a metric card.');
    expect(within(card).getByText('0 chờ phê duyệt · 0 đã xử lý')).toBeTruthy();
    expect(within(card).getByText('0', { selector: '.ui-metric-card__value' })).toBeTruthy();
    expect(within(card).getByText('Chưa có dữ liệu', { selector: '.ui-status span' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Xem bảng' })).toBeNull();
  });

  it('refetches when the window switch changes period', async () => {
    mocks.getCompanyAnalytics.mockResolvedValue(SNAPSHOT);
    render(<AnalyticsPage />);

    await waitFor(() => expect(mocks.getCompanyAnalytics).toHaveBeenCalledWith('24h'));

    fireEvent.click(screen.getByText('7 ngày'));
    await waitFor(() => expect(mocks.getCompanyAnalytics).toHaveBeenCalledWith('7d'));
  });
});
