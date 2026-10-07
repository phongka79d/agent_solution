'use client';

import type { ReactNode } from 'react';
import { t } from '../i18n/index.js';
import { Button } from './Button.js';

export interface ErrorStateProps {
  readonly message: ReactNode;
  readonly onRetry?: () => void;
  readonly retryLabel?: string;
  readonly className?: string;
}

export function ErrorState({ message, onRetry, retryLabel, className }: ErrorStateProps) {
  return (
    <section className={['ui-error-state', className].filter(Boolean).join(' ')} role="alert">
      <p className="ui-error-state__message">{message}</p>
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          {retryLabel ?? t('common.retry')}
        </Button>
      ) : null}
    </section>
  );
}
