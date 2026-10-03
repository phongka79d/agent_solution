import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCustomers: vi.fn(),
  getCustomerProfile: vi.fn(),
  getCustomerTimeline: vi.fn(),
}));

vi.mock('../../lib/tenant-console-client', () => ({ tenantConsoleClient: mocks }));

import { CustomerList } from './CustomerList';
import { Customer360Profile } from './Customer360Profile';
import { Customer360Timeline } from './Customer360Timeline';
import type { CustomerTimelineEntry, CustomerTimelineResponse } from '../../lib/types/tenant-console';

function listItem(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    customer_id: 'cus-ab12',
    display_name: null,
    tier: 'standard',
    verification_status: 'verified',
    created_at: '2026-01-01T00:00:00.000Z',
    email: null,
    phone: null,
    identities: [],
    profile_available: true,
    segment: null,
    total_spent: null,
    order_count: null,
    consent_marketing: null,
    last_activity_at: null,
    data_class: 'PRODUCTION',
    ...overrides,
  };
}

describe('CustomerList', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders API-shaped rows with display_name, masked contact and the data class', async () => {
    mocks.getCustomers.mockResolvedValue({
      items: [
        listItem({ customer_id: 'cus-ab12', display_name: 'Nguyễn An', email: 'a***@e***.com', tier: 'gold', order_count: 3, consent_marketing: true, last_activity_at: '2026-01-05T00:00:00.000Z' }),
        listItem({ customer_id: 'cus-b2', display_name: null, phone: '***5678', data_class: 'TEST', consent_marketing: false }),
      ],
      next_cursor: null,
    });

    render(<CustomerList />);

    expect(await screen.findByText('Nguyễn An')).toBeTruthy();
    expect(screen.getByText('a***@e***.com')).toBeTruthy();
    expect(screen.getByText(/^Khách #/)).toBeTruthy();
    expect(screen.getByText('***5678')).toBeTruthy();
    // 'Vàng'/'Đã đồng ý' also appear as filter options, so the assertion is presence, not uniqueness.
    expect(screen.getAllByText('Vàng').length).toBeGreaterThan(0);
    expect(screen.getByText('3')).toBeTruthy();
    expect(screen.getAllByText('Đã đồng ý').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Chưa đồng ý').length).toBeGreaterThan(0);
  });

  it('filters rows by consent without re-querying the API', async () => {
    mocks.getCustomers.mockResolvedValue({
      items: [
        listItem({ customer_id: 'cus-ab12', display_name: 'Nguyễn An', consent_marketing: true }),
        listItem({ customer_id: 'cus-cd34', display_name: 'Trần Bình', consent_marketing: false }),
      ],
      next_cursor: null,
    });

    render(<CustomerList />);
    expect(await screen.findByText('Nguyễn An')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Lọc theo đồng ý marketing'), { target: { value: 'Đã đồng ý' } });

    await waitFor(() => expect(screen.queryByText('Trần Bình')).toBeNull());
    expect(screen.getByText('Nguyễn An')).toBeTruthy();
  });
});

describe('Customer360Profile', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows a profile skeleton while the customer profile is loading', () => {
    const pending = new Promise<never>(() => {
      // Keep the request unresolved so the loading skeleton remains visible.
    });
    mocks.getCustomerProfile.mockReturnValue(pending);

    const { container } = render(<Customer360Profile customerId="cus-ab12" />);

    expect(container.querySelector('.ui-skeleton')).not.toBeNull();
  });

  it('renders identity, consent, orders and the labelled prediction tab from API rows', async () => {
    mocks.getCustomerProfile.mockResolvedValue({
      customer_id: 'cus-ab12',
      display_name: 'Nguyễn An',
      tier: 'gold',
      verification_status: 'VERIFIED',
      created_at: '2026-01-01T00:00:00.000Z',
      email: 'a***@e***.com',
      phone: '***5678',
      identities: [{ channel: 'email', value: 'a***@e***.com', primary: true, verified_at: '2026-01-01T00:00:00.000Z' }],
      profile_available: true,
      segment: 'LOYAL',
      total_spent: '1200.00',
      order_count: 3,
      consent_marketing: true,
      last_activity_at: '2026-01-05T00:00:00.000Z',
      data_class: 'TEST',
      orders: [{ order_id: 'order-1', order_number: 'SO-1001', status: 'PAID' }],
      conversations: [{ conversation_id: 'conv-9', channel: 'WEB_CHAT', state: 'OPEN' }],
      campaign_engagement: [],
      recommendations: [{ recommendation_id: 'rec-1', classification: 'HYPOTHESIS', reason: 'Nên mua thêm' }],
      service_cases: [],
      timeline: [{ item_id: 'order-1', kind: 'ORDER', occurred_at: '2026-01-02T00:00:00.000Z', title: 'SO-1001', summary: 'PAID', classification: 'FACT', data_class: 'PRODUCTION', source_record_id: 'order-1' }],
    });
    mocks.getCustomerTimeline.mockResolvedValue({ items: [], next_cursor: null });

    render(<Customer360Profile customerId="cus-ab12" />);

    expect(await screen.findByText('Nguyễn An')).toBeTruthy();
    expect(screen.getAllByText('a***@e***.com').length).toBeGreaterThan(0);
    expect(screen.getByText('LOYAL')).toBeTruthy();
    expect(screen.getByText('Đã đồng ý')).toBeTruthy();
    expect(screen.getAllByText('SO-1001').length).toBeGreaterThan(0);
    expect(screen.getByText('Gợi ý bán hàng (Dự đoán)')).toBeTruthy();

    const conversationLink = screen.getByText('Mở hội thoại');
    expect(conversationLink.getAttribute('href')).toBe('/conversations?c=conv-9');
    expect(screen.getByText('Khởi chạy Storefront như khách này').getAttribute('href')).toBe('/testing/customers/cus-ab12/storefront');
  });
});

describe('Customer360Timeline merged chronology', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('merges profile sources with the event stream and keeps classifications behind the advanced toggle', async () => {
    mocks.getCustomerTimeline.mockResolvedValue({
      items: [{
        event_id: 'evt-1',
        event_type: 'purchase',
        canonical_event: 'purchase',
        occurred_at: '2026-01-06T00:00:00.000Z',
        stage: 'Purchase',
        classification: 'FACT',
        summary: 'Đã mua hàng',
      }],
      next_cursor: null,
    });

    render(
      <Customer360Timeline
        initialCustomerId="cus-ab12"
        sources={[
          { item_id: 'order-1', kind: 'ORDER', occurred_at: '2026-01-04T00:00:00.000Z', title: 'SO-1001', summary: 'PAID', classification: 'FACT' },
          { item_id: 'rec-1', kind: 'CONVERSATION', occurred_at: '2026-01-05T00:00:00.000Z', title: 'WEB_CHAT', summary: 'OPEN', classification: 'HYPOTHESIS' },
          { item_id: 'case-1', kind: 'SERVICE_CASE', occurred_at: null, title: 'Giao trễ', summary: 'OPEN' },
        ]}
      />,
    );

    expect(await screen.findByText('Đã mua hàng')).toBeTruthy();
    expect(screen.getByText('SO-1001')).toBeTruthy();
    expect(screen.getByText('Giao trễ')).toBeTruthy();
    // Classifications stay secondary until the operator asks for the advanced timeline.
    expect(screen.queryByText('[Đã xác thực]')).toBeNull();
    expect(screen.queryByText('[Chưa phân loại]')).toBeNull();
    // HYPOTHESIS is visibly not ground truth even when the chips are hidden.
    expect(screen.getByText('Dự đoán của AI có thể thay đổi; không phải dữ kiện đã xác thực.')).toBeTruthy();
    const factEvent = screen.getByText('Đã mua hàng').closest('.tenant-timeline-event');
    const hypothesisEvent = screen.getByText('Dự đoán của AI có thể thay đổi; không phải dữ kiện đã xác thực.').closest('.tenant-timeline-event');
    expect(factEvent?.classList.contains('tenant-timeline-event--fact')).toBe(true);
    expect(factEvent?.classList.contains('tenant-timeline-event--hypothesis')).toBe(false);
    expect(hypothesisEvent?.classList.contains('tenant-timeline-event--hypothesis')).toBe(true);
    expect(hypothesisEvent?.classList.contains('tenant-timeline-event--fact')).toBe(false);

    fireEvent.click(screen.getByText('Dòng thời gian nâng cao'));

    expect(screen.getAllByText('[Đã xác thực]').length).toBeGreaterThan(0);
    expect(screen.getByText('[Dự đoán]')).toBeTruthy();
    expect(screen.getByText('[Chưa phân loại]')).toBeTruthy();
  });

  it('renders wire entries with Vietnamese labels and keeps gap reasons in technical details across cursor pages', async () => {
    const firstEntry: CustomerTimelineEntry = {
      event_id: 'evt-search',
      event_type: 'search',
      canonical_event: null,
      occurred_at: '2026-01-06T00:00:00.000Z',
      stage: 'Search',
      domain: 'MARKETING',
      classification: 'SIGNAL',
      gap_reason: 'CLASSIFICATION_NOT_SERVER_AUTHORITATIVE; summary absent from stored event payload',
    };
    const firstPage: CustomerTimelineResponse = { items: [firstEntry], next_cursor: 'older-events' };
    const secondPage: CustomerTimelineResponse = {
      items: [{
        event_id: 'evt-view',
        event_type: 'product_view',
        canonical_event: 'product_view',
        occurred_at: '2026-01-05T00:00:00.000Z',
        stage: 'View',
        classification: 'SIGNAL',
        gap_reason: 'EVIDENCE_REFERENCE_ABSENT',
      }, {
        event_id: 'evt-unknown',
        event_type: 'UNRECOGNIZED_EVENT',
        canonical_event: null,
        occurred_at: '2026-01-04T00:00:00.000Z',
        stage: 'Unknown',
        classification: 'SIGNAL',
      }],
      next_cursor: null,
    };
    mocks.getCustomerTimeline.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(secondPage);
    const { container } = render(
      <Customer360Timeline
        initialCustomerId="cus-ab12"
        sources={[
          { item_id: 'evt-click', kind: 'EVENT', title: 'click', summary: 'Search', occurred_at: '2026-01-03T00:00:00.000Z' },
          { item_id: 'case-2', kind: 'SERVICE_CASE', title: 'SERVICE_CASE', summary: 'OPEN' },
        ]}
      />,
    );

    expect(await screen.findAllByText('Tìm kiếm')).toHaveLength(3);
    expect(screen.getByText('Nhấp chuột')).toBeTruthy();
    expect(screen.getAllByText('Yêu cầu hỗ trợ')).toHaveLength(2);
    expect(mocks.getCustomerTimeline).toHaveBeenLastCalledWith('cus-ab12', { limit: 20 });
    const reason = screen.getByText(firstEntry.gap_reason ?? '');
    expect(reason.classList.contains('font-mono')).toBe(true);
    expect(reason.closest('details')?.open).toBe(false);
    expect(reason.closest('details')?.querySelector('summary')?.textContent).toBe('Chi tiết kỹ thuật');
    expect(screen.getByText('Một số sự kiện thiếu thông tin nên không hiển thị đầy đủ.')).toBeTruthy();
    expect(screen.getByText(new Date(firstEntry.occurred_at).toLocaleString('vi-VN'))).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Tải thêm sự kiện' }));

    expect(await screen.findByText('Xem sản phẩm')).toBeTruthy();
    expect(mocks.getCustomerTimeline).toHaveBeenLastCalledWith('cus-ab12', { limit: 20, cursor: 'older-events' });
    expect(container.querySelectorAll('.tenant-timeline-event')).toHaveLength(5);
    expect(screen.getAllByText('Một số sự kiện thiếu thông tin nên không hiển thị đầy đủ.')).toHaveLength(2);
    expect(screen.getByText(firstEntry.gap_reason ?? '').closest('details')?.open).toBe(false);
    expect(screen.getByText('EVIDENCE_REFERENCE_ABSENT').closest('.font-mono')).not.toBeNull();
    expect(screen.queryByRole('button', { name: 'Tải thêm sự kiện' })).toBeNull();
    expect(screen.getByText('Chưa xác định giai đoạn')).toBeTruthy();
    const visibleCopy = Array.from(container.querySelectorAll('span, p, strong'))
      .filter((element) => element.closest('details, .font-mono') === null)
      .map((element) => element.textContent ?? '').join(' ');
    expect(visibleCopy).not.toMatch(/\b(?:EVENT|SERVICE_CASE|UNRECOGNIZED_EVENT|product_view|click|search|Search)\b/);
  });
});
