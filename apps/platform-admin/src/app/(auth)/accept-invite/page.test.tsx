import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  params: new URLSearchParams('token=platform-invite-token'),
  inspect: vi.fn(),
  accept: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useSearchParams: () => mocks.params }));
vi.mock('../../../lib/platform-client', () => ({
  ApiError: class ApiError extends Error {
    readonly status: number;
    constructor(status: number) {
      super('Invitation request failed');
      this.status = status;
    }
  },
  inspectPlatformInvitation: mocks.inspect,
  acceptPlatformInvitation: mocks.accept,
}));

import { ApiError } from '../../../lib/platform-client';
import AcceptInvitePage from './page';

beforeEach(() => {
  mocks.params = new URLSearchParams('token=platform-invite-token');
  mocks.inspect.mockReset().mockResolvedValue({
    email: 'new-admin@example.test',
    tenant_id: 'platform-scope-id',
    role_bundle: 'PLATFORM_ADMIN',
    scope: 'platform',
    expires_at: '2026-10-04T00:00:00.000Z',
  });
  mocks.accept.mockReset().mockResolvedValue({ accepted: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('platform invitation acceptance', () => {
  it('sets a password and confirms successful acceptance', async () => {
    const timeoutHandle = setTimeout(() => undefined, 0);
    clearTimeout(timeoutHandle);
    const originalSetTimeout = window.setTimeout;
    vi.spyOn(window, 'setTimeout').mockImplementation((handler, timeout, ...args) => (
      timeout === 1200
        ? timeoutHandle
        : originalSetTimeout.call(window, handler, timeout, ...args)
    ));
    render(<AcceptInvitePage />);

    expect(await screen.findByText('new-admin@example.test')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Tên'), { target: { value: 'Platform Admin' } });
    fireEvent.change(screen.getByLabelText('Mật khẩu'), { target: { value: 'correct horse battery' } });
    fireEvent.change(screen.getByLabelText('Xác nhận mật khẩu'), { target: { value: 'correct horse battery' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kích hoạt tài khoản' }));

    await waitFor(() => expect(mocks.accept).toHaveBeenCalledWith(
      'platform-invite-token',
      'correct horse battery',
      'Platform Admin',
    ));
    expect((await screen.findByRole('status')).textContent).toContain('Tài khoản đã được kích hoạt. Hãy đăng nhập để tiếp tục.');
  });

  it('shows one invalid state for an expired invitation', async () => {
    mocks.inspect.mockRejectedValue(new ApiError(422, 'INVITATION_INVALID', 'test-correlation', 'Invitation invalid'));
    render(<AcceptInvitePage />);

    expect((await screen.findByRole('alert')).textContent).toContain('Liên kết mời không hợp lệ, đã hết hạn hoặc đã được sử dụng.');
    expect(screen.queryByLabelText('Mật khẩu')).toBeNull();
    expect(mocks.accept).not.toHaveBeenCalled();
  });
});
