'use client';

import { forwardRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';

export interface SwitchProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'> {
  readonly label?: ReactNode;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { className, label, onKeyDown, ...props },
  ref,
) {
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || event.key !== ' ' || event.repeat) return;
    event.preventDefault();
    event.currentTarget.click();
  }

  const control = (
    <input
      {...props}
      ref={ref}
      type="checkbox"
      role="switch"
      onKeyDown={handleKeyDown}
      className={['ui-switch', 'ui-focus-ring', className].filter(Boolean).join(' ')}
    />
  );

  return label === undefined ? control : (
    <label className="ui-switch-label">
      {control}
      <span>{label}</span>
    </label>
  );
});
