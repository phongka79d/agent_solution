'use client';

import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Button, type ButtonSize, type ButtonVariant } from './Button.js';

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> {
  readonly label: string;
  readonly icon?: ReactNode;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
}

export function IconButton({ label, icon, children, className, ...props }: IconButtonProps) {
  return (
    <Button
      {...props}
      className={['ui-icon-button', className].filter(Boolean).join(' ')}
      aria-label={label}
    >
      {icon ?? children}
    </Button>
  );
}
