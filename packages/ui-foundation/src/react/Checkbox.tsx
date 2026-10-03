'use client';

import { forwardRef, type InputHTMLAttributes, type KeyboardEvent, type ReactNode } from 'react';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  readonly label?: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
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
      onKeyDown={handleKeyDown}
      className={['ui-checkbox', 'ui-focus-ring', className].filter(Boolean).join(' ')}
    />
  );

  return label === undefined ? control : (
    <label className="ui-checkbox-label">
      {control}
      <span>{label}</span>
    </label>
  );
});
