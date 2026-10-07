import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AuthPage from './page';

const mocks = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock('next/navigation', () => ({ useSearchParams: () => mocks.params }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  mocks.params = new URLSearchParams();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'AUTHENTICATION_FAILED' }) })));
});

describe('platform sign-in', () => {
  it('renders only email, password, and the sign-in button', async () => {
    render(<AuthPage />);

    expect(await screen.findByLabelText('Email')).toBeTruthy();
    expect(screen.getByLabelText('Mật khẩu')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Đăng nhập' })).toBeTruthy();
  });

  it('shows the expired message only for reason=expired', async () => {
    mocks.params = new URLSearchParams('reason=expired');
    render(<AuthPage />);

    expect((await screen.findByRole('alert')).textContent).toContain('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeTruthy());

    mocks.params = new URLSearchParams();
    cleanup();
    render(<AuthPage />);
    await waitFor(() => expect(screen.getByLabelText('Email')).toBeTruthy());
    expect(screen.queryByText('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.')).toBeNull();
  });
});
