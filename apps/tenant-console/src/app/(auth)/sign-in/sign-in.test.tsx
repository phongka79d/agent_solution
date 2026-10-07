import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  searchParams: new URLSearchParams(),
  signIn: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useSearchParams: () => mocks.searchParams,
}));
vi.mock('../../../lib/tenant-console-client', () => ({
  AuthRequestError: class AuthRequestError extends Error {
    readonly status = 429;
  },
  tenantConsoleClient: { signIn: mocks.signIn },
}));

import AuthPage from './page';

describe('tenant sign-in', () => {
  beforeEach(() => {
    mocks.searchParams = new URLSearchParams();
    mocks.signIn.mockReset();
  });

  afterEach(() => cleanup());

  it('renders only company email, password, and sign-in controls', () => {
    render(<AuthPage />);

    expect(screen.getByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Mật khẩu')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Đăng nhập' })).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByText(/platform administration/i)).toBeNull();
  });

  it('shows the expired-session message only for reason=expired', () => {
    const { unmount } = render(<AuthPage />);
    expect(screen.queryByText('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.')).toBeNull();
    unmount();

    mocks.searchParams = new URLSearchParams('reason=expired');
    render(<AuthPage />);
    expect(screen.getByText('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.')).toBeTruthy();
  });
});
