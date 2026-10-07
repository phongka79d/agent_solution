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

function renderShell() {
  return render(
    <SessionProvider session={session}>
      <PlatformShell><p>Protected content</p></PlatformShell>
    </SessionProvider>,
  );
}

describe('PlatformShell', () => {
  it('renders all platform navigation items', () => {
    renderShell();

    expect(screen.getByRole('link', { name: 'Tổng quan' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Công ty' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Vận hành' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Mức sử dụng' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Nhà cung cấp AI' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Tình trạng hệ thống' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Gói dịch vụ' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Cài đặt' })).toBeTruthy();
  });

  it('opens and closes the mobile drawer with focus return', async () => {
    const user = userEvent.setup();
    renderShell();

    const trigger = screen.getByRole('button', { name: 'Menu' });
    await user.click(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Đóng' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
