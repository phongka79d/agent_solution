'use client';

import { cloneElement, useId, type ReactElement, type ReactNode } from 'react';

export interface FieldProps {
  readonly label: ReactNode;
  readonly children: ReactElement;
  readonly hint?: ReactNode;
  readonly error?: ReactNode;
  readonly htmlFor?: string;
  readonly className?: string;
}

export function Field({ label, children, hint, error, htmlFor, className }: FieldProps) {
  const generatedId = useId();
  const childProps = children.props as Record<string, unknown>;
  const controlId = htmlFor ?? (typeof childProps.id === 'string' ? childProps.id : `field-${generatedId}`);
  const hintId = hint ? `${controlId}-hint` : undefined;
  const errorId = error ? `${controlId}-error` : undefined;
  const describedBy = [
    typeof childProps['aria-describedby'] === 'string' ? childProps['aria-describedby'] : undefined,
    hintId,
    errorId,
  ]
    .filter(Boolean)
    .join(' ') || undefined;
  const ariaInvalid = error ? true : childProps['aria-invalid'];
  const control = cloneElement(children as ReactElement<Record<string, unknown>>, {
    id: controlId,
    'aria-describedby': describedBy,
    'aria-invalid': ariaInvalid,
  });

  return (
    <div className={['ui-field', className].filter(Boolean).join(' ')}>
      <label className="ui-field__label" htmlFor={controlId}>
        {label}
      </label>
      {control}
      {hint ? (
        <div id={hintId} className="ui-field__hint">
          {hint}
        </div>
      ) : null}
      {error ? (
        <div id={errorId} className="ui-field__error" role="alert">
          {error}
        </div>
      ) : null}
    </div>
  );
}
