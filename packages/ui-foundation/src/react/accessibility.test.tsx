// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttentionCard, ChatThread, Checkbox, StatusBadge, Stepper, Switch, Textarea } from './index.js';

afterEach(() => cleanup());

describe('T6.1 accessible foundation controls', () => {
  it('exposes native control roles and labels', () => {
    render(
      <>
        <Switch label="Live updates" />
        <Checkbox label="Remember choice" />
        <Stepper aria-label="Quantity" defaultValue={1} min={0} max={5} />
        <Textarea aria-label="Notes" />
      </>,
    );

    expect(screen.getByRole('switch', { name: 'Live updates' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Remember choice' })).toBeTruthy();
    expect(screen.getByRole('spinbutton', { name: 'Quantity' })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: 'Notes' })).toBeTruthy();
  });

  it('supports Space activation for switch and checkbox controls', () => {
    const onSwitchChange = vi.fn();
    const onCheckboxChange = vi.fn();
    render(
      <>
        <Switch label="Notifications" defaultChecked={false} onChange={onSwitchChange} />
        <Checkbox label="Consent" defaultChecked={false} onChange={onCheckboxChange} />
      </>,
    );

    fireEvent.keyDown(screen.getByRole('switch', { name: 'Notifications' }), { key: ' ' });
    fireEvent.keyDown(screen.getByRole('checkbox', { name: 'Consent' }), { key: ' ' });
    expect(screen.getByRole('switch', { name: 'Notifications', checked: true })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Consent', checked: true })).toBeTruthy();
    expect(onSwitchChange).toHaveBeenCalledTimes(1);
    expect(onCheckboxChange).toHaveBeenCalledTimes(1);
  });

  it('changes the stepper value from the arrow keys within its range', () => {
    const onValueChange = vi.fn();
    render(<Stepper aria-label="Attempts" value={2} min={1} max={3} onValueChange={onValueChange} />);

    fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Attempts' }), { key: 'ArrowUp' });
    expect(onValueChange).toHaveBeenCalledWith(3);
  });
  it('does not step past the configured maximum', () => {
    const onValueChange = vi.fn();
    render(<Stepper aria-label="Attempts" value={3} min={1} max={3} onValueChange={onValueChange} />);

    fireEvent.keyDown(screen.getByRole('spinbutton', { name: 'Attempts' }), { key: 'ArrowUp' });
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('renders a status badge announcement only when live is enabled', () => {
    const { rerender } = render(<StatusBadge code="ACTIVE" />);
    expect(screen.queryByRole('status')).toBeNull();

    rerender(<StatusBadge code="ACTIVE" live />);
    expect(screen.getByRole('status').textContent).toContain('Hoạt động');
  });

  it('localizes the attention severity and renders one badge', () => {
    const { container } = render(
      <AttentionCard severity="warning" title="Connection needs review" />,
    );

    expect(screen.getByText('Cần chú ý')).toBeTruthy();
    expect(screen.queryByText('warning')).toBeNull();
    expect(container.querySelectorAll('.ui-status')).toHaveLength(1);
  });

  it('announces chat messages from a named log', () => {
    render(
      <ChatThread
        messages={[{ id: 'message-1', speaker: 'customer', label: 'Customer', content: 'Hello there' }]}
      />,
    );

    expect(screen.getByRole('log', { name: 'Nội dung hội thoại' })).toBeTruthy();
    expect(screen.getByText('Hello there')).toBeTruthy();
  });
});
