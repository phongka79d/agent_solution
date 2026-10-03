'use client';

import { useState, type ChangeEvent, type InputHTMLAttributes, type KeyboardEvent } from 'react';

export interface StepperProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'defaultValue' | 'onChange' | 'step' | 'min' | 'max'> {
  readonly value?: number;
  readonly defaultValue?: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly onValueChange?: (value: number) => void;
}

export function Stepper({
  className,
  value,
  defaultValue,
  min,
  max,
  step = 1,
  onValueChange,
  onKeyDown,
  readOnly,
  ...props
}: StepperProps) {
  const [uncontrolledValue, setUncontrolledValue] = useState(defaultValue === undefined ? '' : String(defaultValue));
  const controlled = value !== undefined;
  const displayedValue = controlled ? String(value) : uncontrolledValue;

  function updateValue(next: number) {
    if (!controlled) setUncontrolledValue(String(next));
    onValueChange?.(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || readOnly || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;

    event.preventDefault();
    const current = displayedValue === '' ? min ?? 0 : Number(displayedValue);
    const base = Number.isFinite(current) ? current : min ?? 0;
    const direction = event.key === 'ArrowUp' ? 1 : -1;
    const candidate = base + step * direction;
    const next = Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min ?? Number.NEGATIVE_INFINITY, candidate));
    if (next === base) return;
    updateValue(next);
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const raw = event.currentTarget.value;
    if (!controlled) setUncontrolledValue(raw);
    if (raw !== '') {
      const next = Number(raw);
      if (Number.isFinite(next)) onValueChange?.(next);
    }
  }

  return (
    <input
      {...props}
      type="number"
      min={min}
      max={max}
      step={step}
      value={displayedValue}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      className={['ui-input', 'ui-stepper', 'ui-focus-ring', className].filter(Boolean).join(' ')}
    />
  );
}
