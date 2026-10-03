import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { applyFilters, AuditConsole, chainStatusOf, type AuditPagePayload } from './AuditConsole';

const events = [
  {
    event_id: 'evt-1',
    chain_seq: '42',
    actor_kind: 'OPERATOR',
    actor_id: 'admin@example.test',
    scope: 'platform',
    action: 'provider.update',
    tenant_id: 'tenant-a',
    target: 'provider-1',
    outcome: 'SUCCESS',
    reason: 'rotate key',
    before_state: { api_key: '••••' },
    after_state: { api_key_fingerprint: 'fp-9' },
    correlation_id: 'corr-1',
    created_at: '2026-09-30T10:00:00.000Z',
  },
  {
    event_id: 'evt-2',
    chain_seq: '41',
    actor_kind: 'SYSTEM',
    actor_id: 'system',
    scope: 'company',
    action: 'settings.update',
    tenant_id: 'tenant-b',
    target: null,
    outcome: 'DENIED',
    reason: null,
    before_state: null,
    after_state: { timezone: 'Asia/Ho_Chi_Minh' },
    correlation_id: 'corr-2',
    created_at: '2026-09-29T08:00:00.000Z',
  },
];

function stubFetch(payload: AuditPagePayload) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('platform/tenants')) return { ok: true, json: async () => ({ items: [{ tenant_id: 'tenant-a', display_name: 'Công ty A' }] }) };
    if (url.includes('tenant_id=tenant-a')) return { ok: true, json: async () => payload };
    return { ok: true, json: async () => payload };
  }));
}

beforeEach(() => stubFetch({ items: events, next_cursor: '41', chain_verified: true }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('chainStatusOf', () => {
  it('stays honest when the API reports no verdict', () => {
    expect(chainStatusOf({ items: [] })).toBe('UNCHECKED');
    expect(chainStatusOf({ items: [], chain_verified: true })).toBe('VERIFIED');
    expect(chainStatusOf({ items: [], chain_verification: 'TAMPERED' })).toBe('FAILED');
  });
});

describe('applyFilters', () => {
  it('filters by actor, outcome and time window', () => {
    expect(applyFilters(events, { tenant_id: '', actor: 'admin@', action: '', outcome: '', from: '', to: '' }).map((e) => e.event_id)).toEqual(['evt-1']);
    expect(applyFilters(events, { tenant_id: '', actor: '', action: '', outcome: 'DENIED', from: '', to: '' }).map((e) => e.event_id)).toEqual(['evt-2']);
    expect(applyFilters(events, { tenant_id: '', actor: '', action: '', outcome: '', from: '2026-09-30', to: '2026-09-30' }).map((e) => e.event_id)).toEqual(['evt-1']);
    expect(applyFilters(events, { tenant_id: 'tenant-b', actor: '', action: '', outcome: '', from: '', to: '' }).map((e) => e.event_id)).toEqual(['evt-2']);
  });
});

describe('AuditConsole', () => {
  it('renders rows with the page-level chain verdict', async () => {
    render(<AuditConsole />);

    expect(await screen.findByRole('heading', { name: 'Nhật ký kiểm toán' })).toBeTruthy();
    expect(await screen.findByText('Cập nhật nhà cung cấp')).toBeTruthy();
    expect(screen.getByText('Chuỗi kiểm toán: Đã xác minh')).toBeTruthy();
  });

  it('localizes actions and actors while retaining the action code only in technical details', async () => {
    const user = userEvent.setup();
    stubFetch({ items: events.map((event) => ({ ...event, action: event.event_id === 'evt-1' ? 'RESET_DRY_RUN' : 'FUTURE_ACTION' })) });
    render(<AuditConsole />);

    expect(await screen.findByText('Xem trước đặt lại dữ liệu')).toBeTruthy();
    expect(screen.getByText('Thao tác hệ thống')).toBeTruthy();
    expect(screen.getByRole('row', { name: /Xem trước đặt lại dữ liệu/ }).textContent).toContain('Nhân viên');
    expect(screen.getByRole('row', { name: /Thao tác hệ thống/ }).textContent).toContain('Hệ thống');
    expect(screen.queryByText('RESET_DRY_RUN')).toBeNull();
    expect(screen.getByText(new Date('2026-09-30T10:00:00.000Z').toLocaleString('vi-VN'))).toBeTruthy();

    await user.click(within(screen.getByRole('row', { name: /Xem trước đặt lại dữ liệu/ })).getByRole('button', { name: 'Chi tiết' }));
    const technicalCode = await screen.findByText('RESET_DRY_RUN');
    expect(technicalCode.tagName).toBe('CODE');
    expect(technicalCode.classList.contains('font-mono')).toBe(true);
    expect(technicalCode.closest('details')?.open).toBe(false);
  });

  it('shows that the chain was not checked when the payload has no verdict', async () => {
    stubFetch({ items: events, next_cursor: null });
    render(<AuditConsole />);

    expect(await screen.findByText('Chuỗi kiểm toán: Chưa kiểm tra')).toBeTruthy();
  });

  it('narrows the loaded page with the actor filter', async () => {
    const user = userEvent.setup();
    render(<AuditConsole />);
    await screen.findByText('Cập nhật nhà cung cấp');

    await user.type(screen.getByLabelText('Người thực hiện'), 'system');
    await waitFor(() => expect(screen.queryByText('Cập nhật nhà cung cấp')).toBeNull());
    expect(screen.getByText('Cập nhật cài đặt')).toBeTruthy();
  });

  it('localizes a machine-coded reason in the event detail drawer', async () => {
    const user = userEvent.setup();
    stubFetch({ items: events.map((event) => ({ ...event, reason: 'PROVIDER_REJECTED' })) });
    render(<AuditConsole />);
    await screen.findByText('Cập nhật nhà cung cấp');

    const row = screen.getByRole('row', { name: /Cập nhật nhà cung cấp/ });
    await user.click(within(row).getByRole('button', { name: 'Chi tiết' }));

    expect(await screen.findByText('Nhà cung cấp từ chối yêu cầu.')).toBeTruthy();
    expect(screen.queryByText('PROVIDER_REJECTED')).toBeNull();
  });

  it('opens the detail drawer with the redacted before/after payload', async () => {
    const user = userEvent.setup();
    render(<AuditConsole />);
    await screen.findByText('Cập nhật nhà cung cấp');

    await user.click(screen.getAllByRole('button', { name: 'Chi tiết' })[0]!);
    expect(await screen.findByText('Chi tiết sự kiện kiểm toán')).toBeTruthy();
    expect(screen.getByText(/Trước \(đã che thông tin nhạy cảm\)/)).toBeTruthy();
    expect(screen.getByText(/"api_key_fingerprint": "fp-9"/)).toBeTruthy();
  });
});
