'use client';

import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../i18n/index.js';
import type { Tone } from '../status-view.js';

export interface ToastProps {
  readonly message: ReactNode;
  readonly tone?: Extract<Tone, 'success' | 'warning' | 'danger' | 'info' | 'neutral'>;
  readonly action?: ReactNode;
  readonly onDismiss?: () => void;
  readonly className?: string;
}

export function Toast({ message, tone = 'info', action, onDismiss, className }: ToastProps) {
  // Warning/danger outcomes must interrupt a screen reader; routine confirmations stay polite.
  const assertive = tone === 'danger' || tone === 'warning';
  return (
    <div
      className={['ui-toast', `ui-toast--${tone}`, className].filter(Boolean).join(' ')}
      role={assertive ? 'alert' : 'status'}
      aria-live={assertive ? 'assertive' : 'polite'}
    >
      <span className="ui-toast__message">{message}</span>
      {action ? <span className="ui-toast__action">{action}</span> : null}
      {onDismiss ? (
        <button
          type="button"
          className="ui-toast__dismiss ui-focus-ring"
          aria-label={t('common.close')}
          onClick={onDismiss}
        >
          <X aria-hidden="true" size={16} />
        </button>
      ) : null}
    </div>
  );
}

export interface ToastStackProps {
  readonly children?: ReactNode;
  readonly className?: string;
}

export function ToastStack({ children, className }: ToastStackProps) {
  return (
    <div className={['ui-toast-stack', className].filter(Boolean).join(' ')}>
      {children}
    </div>
  );
}
