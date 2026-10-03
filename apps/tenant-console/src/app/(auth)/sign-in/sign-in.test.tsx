import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
    readonly status: number;
    readonly payload: Record<string, unknown>;
    readonly retryAfter: number | null;
    constructor(status: number, payload: Record<string, unknown> = {}, retryAfter: number | null = null) {
      super('auth failed');
      this.status = status;
      this.payload = payload;
      this.retryAfter = retryAfter;
    }
  },
  tenantConsoleClient: { signIn: mocks.signIn },
}));

import { AuthRequestError } from '../../../lib/tenant-console-client';
import AuthPage from './page';

async function submit(email = 'user@example.test', password = 'password') {
  render(<AuthPage />);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: email } });
  fireEvent.change(screen.getByLabelText('Mật khẩu'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Đăng nhập' }));
  return screen.findByRole('alert');
}

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

  it('maps 401 to an invalid-credentials message', async () => {
    mocks.signIn.mockRejectedValue(new AuthRequestError(401, { error: 'AUTHENTICATION_FAILED' }));
    const alert = await submit();
    await waitFor(() => expect(alert.textContent).toContain('Email hoặc mật khẩu không đúng.'));
  });

  it('maps 429 to a rate-limit message that includes the retry-after delay', async () => {
    mocks.signIn.mockRejectedValue(new AuthRequestError(429, { error: 'TOO_MANY_ATTEMPTS' }, 45));
    const alert = await submit();
    await waitFor(() => expect(alert.textContent).toContain('Vui lòng thử lại sau 45 giây.'));
  });

  it('maps 5xx to a distinct system-unavailable message', async () => {
    mocks.signIn.mockRejectedValue(new AuthRequestError(502, { error: 'AUTH_UNAVAILABLE' }));
    const alert = await submit();
    await waitFor(() => expect(alert.textContent).toContain('Hệ thống tạm thời không khả dụng.'));
  });
});
