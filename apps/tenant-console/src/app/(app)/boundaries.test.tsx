import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import AppError from './error';
import AppLoading from './loading';

afterEach(() => cleanup());

describe('tenant console route boundaries', () => {
  it('renders the localized error boundary and retries through reset', () => {
    const reset = vi.fn();
    const error = Object.assign(new Error('upstream boom'), { digest: 'abc123' });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    render(<AppError error={error} reset={reset} />);

    expect(screen.getByText('Không tải được trang này')).toBeTruthy();
    expect(screen.getByText('Đã xảy ra lỗi khi tải trang. Vui lòng thử lại.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(reset).toHaveBeenCalledTimes(1);
    // Technical details keep the correlation context available to support.
    expect(screen.getByText(/Chi tiết kỹ thuật/)).toBeTruthy();

    consoleError.mockRestore();
  });

  it('renders a busy loading boundary', () => {
    render(<AppLoading />);
    expect(screen.getByText('Đang tải…')).toBeTruthy();
  });
});
