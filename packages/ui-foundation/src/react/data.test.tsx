// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AdvancedDetails } from './AdvancedDetails.js';
import { DataTable } from './DataTable.js';
import { ErrorState } from './ErrorState.js';
import { Field } from './Field.js';
import { IconButton } from './IconButton.js';
import { Input } from './Input.js';
import { MetricCard } from './MetricCard.js';
import { StatusBadge } from './StatusBadge.js';

afterEach(() => cleanup());

describe('shared data components', () => {
  it('renders a status icon and translated label for known and unknown codes', () => {
    const { container } = render(
      <>
        <StatusBadge code="ACTIVE" />
        <StatusBadge code="something-unrecognised" />
      </>,
    );

    expect(screen.getByText('Hoạt động')).toBeTruthy();
    expect(screen.getByText('Không xác định')).toBeTruthy();
    expect(container.querySelectorAll('svg')).toHaveLength(2);
  });

  it('renders explicit no-data text when a metric value is undefined', () => {
    render(<MetricCard label="Requests" value={undefined} />);

    expect(screen.getByText('Chưa có dữ liệu')).toBeTruthy();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('wires field hint and error into the control accessibility attributes', () => {
    render(
      <Field label="Email" hint="Use your work email" error="Email is required">
        <Input />
      </Field>,
    );

    const input = screen.getByLabelText('Email');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toContain('hint');
    expect(describedBy).toContain('error');
    expect(input.getAttribute('aria-invalid')).toBe('true');
  });

  it('requires an accessible label on icon buttons', () => {
    render(<IconButton label="Open filters">+</IconButton>);

    expect(screen.getByRole('button', { name: 'Open filters' })).toBeTruthy();
  });

  it('keeps the table caption while rendering its empty state', () => {
    render(
      <DataTable
        caption="Agents"
        columns={[{ key: 'name', header: 'Name' }]}
        rows={[]}
        getRowKey={() => 'empty'}
      />,
    );

    expect(screen.getByText('Agents').tagName).toBe('CAPTION');
    expect(screen.getByText('Chưa có dữ liệu')).toBeTruthy();
  });

  it('calls the retry callback from ErrorState', () => {
    const onRetry = vi.fn();
    render(<ErrorState message="Unable to load" onRetry={onRetry} />);

    fireEvent.click(screen.getByRole('button', { name: 'Thử lại' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('starts AdvancedDetails collapsed', () => {
    render(<AdvancedDetails value="raw-id-123" />);

    const details = screen.getByText('Chi tiết nâng cao').closest('details');
    expect(details).not.toBeNull();
    expect(details?.hasAttribute('open')).toBe(false);
  });
});
