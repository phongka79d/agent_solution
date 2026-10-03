import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthSession } from '@agentos/ui-foundation/auth';
import { SessionProvider } from '../auth/SessionProvider';
import { PlatformShell } from './PlatformShell';

vi.mock('next/navigation', () => ({ usePathname: () => '/' }));

afterEach(cleanup);

const session: AuthSession = {
  identity: { user_id: 'platform-user', email: 'platform@example.test', display_name: 'Platform Admin' },
  membership: { tenant_id: 'tenant-1', tenant_name: null, role: 'admin', scope: 'platform' },
  permissions: ['platform:admin'],
  expires_at: '2030-01-01T00:00:00.000Z',
};

function renderShell(subscriptionsEnabled: boolean) {
  return render(
    <SessionProvider session={session}>
      <PlatformShell subscriptionsEnabled={subscriptionsEnabled}><p>Protected content</p></PlatformShell>
    </SessionProvider>,
  );
}

describe('PlatformShell', () => {
  it('renders all platform navigation items when subscriptions are enabled', () => {
    renderShell(true);

    expect(screen.getByRole('link', { name: 'Tổng quan' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Công ty' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Vận hành' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Mức sử dụng' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Nhà cung cấp AI' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Tình trạng hệ thống' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Gói dịch vụ' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Cài đặt' })).toBeTruthy();
    expect(screen.getAllByRole('link').some((link) => link.getAttribute('href') === '/audit')).toBe(true);
  });

  it('hides subscriptions from navigation when the feature is disabled', () => {
    renderShell(false);

    expect(screen.queryByRole('link', { name: 'Gói dịch vụ' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Cài đặt' })).toBeTruthy();
  });

  it('does not render the single-tenant authority scope card', () => {
    renderShell(true);
    expect(screen.queryByText('Chỉ công ty hiện tại')).toBeNull();
    expect(screen.queryByText('Phạm vi quyền hạn')).toBeNull();
  });

  it('opens and closes the mobile drawer with focus return', async () => {
    const user = userEvent.setup();
    renderShell(false);

    const trigger = screen.getByRole('button', { name: 'Menu' });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Đóng' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
