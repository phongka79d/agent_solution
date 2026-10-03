// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog.js';
import { DataClassBadge } from './DataClassBadge.js';
import { ErrorBanner } from './ErrorBanner.js';
import { IdChip } from './IdChip.js';
import { KeyValueList } from './KeyValueList.js';
import { Skeleton } from './Skeleton.js';
import { StageTimeline } from './StageTimeline.js';
import { Toast } from './Toast.js';
import { ApiError } from '../http-client.js';

afterEach(() => cleanup());

describe('T6.1 foundation components', () => {
  it('renders a data-class badge from the shared vocabulary', () => {
    const { rerender } = render(<DataClassBadge code="TEST" />);
    expect(screen.getByText('Dữ liệu thử')).toBeTruthy();

    rerender(<DataClassBadge code="DEMO" />);
    expect(screen.getByText('Demo')).toBeTruthy();

    // Production is the normal state and does not surface a badge.
    rerender(<DataClassBadge code="PRODUCTION" />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders key/value rows and a localized empty state', () => {
    const { rerender } = render(
      <KeyValueList items={[{ key: 'tz', label: 'Múi giờ', value: 'Asia/Ho_Chi_Minh' }]} />,
    );
    expect(screen.getByText('Múi giờ')).toBeTruthy();
    expect(screen.getByText('Asia/Ho_Chi_Minh')).toBeTruthy();

    rerender(<KeyValueList items={[]} />);
    expect(screen.getByText('Chưa có dữ liệu')).toBeTruthy();
  });

  it('shortens identifiers in the chip and exposes the raw id only as a title', () => {
    render(<IdChip value="12345678-1234-1234-1234-1234567890ab" />);
    const label = screen.getByText('12345678…');
    expect(label.getAttribute('title')).toBe('12345678-1234-1234-1234-1234567890ab');
  });

  it('lists stage states in order with a screen-reader state label', () => {
    render(
      <StageTimeline
        stages={[
          { key: 'draft', label: 'Soạn nội dung', state: 'done' },
          { key: 'approve', label: 'Chờ duyệt', state: 'active' },
        ]}
      />,
    );
    expect(screen.getByText('Soạn nội dung')).toBeTruthy();
    expect(screen.getByText('Chờ duyệt')).toBeTruthy();
    expect(screen.getByText('Đang thực hiện')).toBeTruthy();
  });

  it('offers retry for retryable errors and hides it for fatal ones', () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <ErrorBanner
        error={new ApiError(503, {
          error_code: 'PROVIDER_UNAVAILABLE',
          message: 'down',
          retryable: true,
          correlation_id: 'corr-9',
        })}
        onRetry={onRetry}
      />,
    );
    expect(screen.getByText(/Mã đối chiếu/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <ErrorBanner
        error={new ApiError(403, {
          error_code: 'FORBIDDEN',
          message: 'nope',
          retryable: false,
          correlation_id: 'corr-10',
        })}
        onRetry={onRetry}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Thử lại' })).toBeNull();
  });

  it('announces toasts by severity', () => {
    const { rerender } = render(<Toast message="Đã lưu" tone="success" />);
    expect(screen.getByRole('status').textContent).toContain('Đã lưu');

    rerender(<Toast message="Gửi thất bại" tone="danger" />);
    expect(screen.getByRole('alert').textContent).toContain('Gửi thất bại');
  });

  it('confirms an action through the dialog', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog
        open
        title="Tiếp quản hội thoại"
        description="Bạn sẽ trả lời khách hàng với tư cách nhân viên."
        onConfirm={onConfirm}
        onCancel={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Xác nhận' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('reserves space with an accessible skeleton', () => {
    render(<Skeleton variant="card" />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('Đang tải…');
  });
});
