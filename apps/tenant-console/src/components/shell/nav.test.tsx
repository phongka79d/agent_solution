import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@agentos/ui-foundation/auth';

const mocks = vi.hoisted(() => ({
  signOut: vi.fn(),
  getCompanyAttention: vi.fn(),
  getTestingStatus: vi.fn(),
}));

vi.mock('next/link', () => ({
  default: ({ href, children, ...props }: { href: string; children: ReactNode }) => <a href={href} {...props}>{children}</a>,
}));
vi.mock('next/navigation', () => ({ usePathname: () => '/' }));
vi.mock('../../lib/tenant-console-client', () => ({
  tenantConsoleClient: {
    signOut: mocks.signOut,
    getCompanyAttention: mocks.getCompanyAttention,
    getTestingStatus: mocks.getTestingStatus,
  },
}));

import { SessionProvider } from '../auth/SessionProvider';
import { CompanyShell } from './CompanyShell';

const companyAdmin: AuthSession = {
  identity: { user_id: 'u-company-admin', email: 'admin@example.test', display_name: 'Company Admin' },
  membership: { tenant_id: 'tenant-1', tenant_name: 'Tenant One', role: 'admin', scope: 'company' },
  permissions: ['approval:read', 'campaign:draft', 'conversation:takeover', 'customer:read', 'telemetry:read'],
  expires_at: '2099-01-01T00:00:00.000Z',
};

describe('CompanyShell navigation', () => {
  beforeEach(() => {
    mocks.signOut.mockReset();
    mocks.getCompanyAttention.mockReset().mockResolvedValue({ items: [] });
    mocks.getTestingStatus.mockReset().mockResolvedValue({ tenant_id: 'tenant-1', data_class: 'TEST', enabled: true });
    vi.stubGlobal('location', { assign: vi.fn() });
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders grouped navigation, a single Settings entry and no fake search', () => {
    render(
      <SessionProvider session={companyAdmin}>
        <CompanyShell><div>content</div></CompanyShell>
      </SessionProvider>,
    );

    expect(screen.getByText('Việc cần làm')).toBeTruthy();
    expect(screen.getByText('Kinh doanh')).toBeTruthy();
    expect(screen.getByText('AI')).toBeTruthy();
    expect(screen.getByText('Phê duyệt')).toBeTruthy();
    expect(screen.getByText('Chiến dịch')).toBeTruthy();
    expect(screen.getByText('Kết nối')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Cài đặt' })).toHaveLength(1);
    expect(screen.queryByText('Search workspace')).toBeNull();
    expect(screen.queryByRole('link', { name: /Thử trợ lý/i })).toBeNull();
  });

  it('gates company navigation by permissions', () => {
    const telemetryOnly: AuthSession = { ...companyAdmin, permissions: ['telemetry:read'] };
    render(
      <SessionProvider session={telemetryOnly}>
        <CompanyShell><div>content</div></CompanyShell>
      </SessionProvider>,
    );

    const nav = screen.getByRole('navigation', { name: 'Điều hướng công ty' });
    expect(nav.textContent).toContain('Tổng quan');
    expect(nav.textContent).toContain('AI Team');
    expect(nav.textContent).not.toContain('Khách hàng');
    expect(nav.textContent).not.toContain('Hội thoại');
    expect(screen.queryByText('Việc cần làm')).toBeNull();
  });

  it('shows the workspace data-class chip and the Test lab entry when allowed', async () => {
    const labAdmin: AuthSession = { ...companyAdmin, permissions: [...companyAdmin.permissions, 'testdata:manage'] };
    render(
      <SessionProvider session={labAdmin}>
        <CompanyShell><div>content</div></CompanyShell>
      </SessionProvider>,
    );

    expect(screen.getAllByText('Tenant One').length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText('Dữ liệu thử')).toBeTruthy());
    expect(screen.getByRole('link', { name: 'Phòng thử nghiệm' })).toBeTruthy();
  });

  it('hides the Test lab entry without testdata:manage even when the tenant is TEST', async () => {
    render(
      <SessionProvider session={companyAdmin}>
        <CompanyShell><div>content</div></CompanyShell>
      </SessionProvider>,
    );

    await waitFor(() => expect(mocks.getTestingStatus).not.toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: 'Phòng thử nghiệm' })).toBeNull();
  });

  it('shows pending badges derived from the attention queue', async () => {
    mocks.getCompanyAttention.mockResolvedValue({
      items: [
        { type: 'HUMAN_HANDOFF', severity: 'danger', domain: 'care', title_key: 'x', params: {}, href: '/conversations/c1', source_ref: 'care_handoffs:1' },
        { type: 'APPROVAL_PENDING', severity: 'warning', domain: 'sales', title_key: 'x', params: {}, href: '/approvals/a1', source_ref: 'approvals:1' },
      ],
    });
    render(
      <SessionProvider session={companyAdmin}>
        <CompanyShell><div>content</div></CompanyShell>
      </SessionProvider>,
    );

    await waitFor(() => expect(screen.getAllByText('1')).toHaveLength(2));
  });

  it('opens the mobile drawer, traps focus, closes on Escape, and returns focus to the menu button', async () => {
    const user = userEvent.setup();
    render(
      <SessionProvider session={companyAdmin}>
        <CompanyShell><div>content</div></CompanyShell>
      </SessionProvider>,
    );

    const menuButton = screen.getByRole('button', { name: 'Mở menu' });
    await user.click(menuButton);
    expect(screen.getByRole('dialog', { name: 'Điều hướng công ty' })).toBeTruthy();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Điều hướng công ty' })).toBeNull();
    expect(document.activeElement).toBe(menuButton);
  });

  it('signs out from the user menu "Đăng xuất" action', async () => {
    const user = userEvent.setup();
    render(
      <SessionProvider session={companyAdmin}>
        <CompanyShell><div>content</div></CompanyShell>
      </SessionProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Menu người dùng' }));
    await user.click(screen.getByRole('menuitem', { name: 'Đăng xuất' }));
    await waitFor(() => expect(mocks.signOut).toHaveBeenCalledTimes(1));
  });
});
