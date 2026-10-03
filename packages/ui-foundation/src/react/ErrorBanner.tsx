'use client';

import type { ReactNode } from 'react';
import { describeApiError } from '../errors.js';
import { t } from '../i18n/index.js';
import { AdvancedDetails } from './AdvancedDetails.js';
import { Button } from './Button.js';

export interface ErrorBannerProps {
  /** Any thrown value; `describeApiError` localizes it and decides the retry affordance. */
  readonly error: unknown;
  readonly onRetry?: () => void;
  readonly className?: string;
  /** Shows the raw code/status inside Advanced details. Off by default. */
  readonly showTechnical?: boolean;
}

export function ErrorBanner({ error, onRetry, className, showTechnical = false }: ErrorBannerProps) {
  const view = describeApiError(error);
  const technical: ReactNode = (
    <span className="ui-error-banner__technical">
      {view.technical}
      {view.correlation_id ? ` · ${t('errors.correlation_id')}: ${view.correlation_id}` : ''}
    </span>
  );
  return (
    <section
      className={['ui-error-banner', `ui-error-banner--${view.class.toLowerCase()}`, className]
        .filter(Boolean)
        .join(' ')}
      role="alert"
    >
      <div className="ui-error-banner__copy">
        <p className="ui-error-banner__message">{view.message}</p>
        {view.correlation_id ? (
          <p className="ui-error-banner__correlation">
            {t('errors.correlation_id')}: <span className="ui-id">{view.correlation_id}</span>
          </p>
        ) : null}
        {showTechnical ? <AdvancedDetails value={technical} /> : null}
      </div>
      {view.retryable && onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          {view.retry_label ?? t('common.retry')}
        </Button>
      ) : null}
    </section>
  );
}
