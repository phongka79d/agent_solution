'use client';

import { forwardRef, type TextareaHTMLAttributes } from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  readonly invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, ...props },
  ref,
) {
  return (
    <textarea
      {...props}
      ref={ref}
      className={['ui-input', 'ui-textarea', 'ui-focus-ring', className].filter(Boolean).join(' ')}
      aria-invalid={invalid || props['aria-invalid'] || undefined}
    />
  );
});
