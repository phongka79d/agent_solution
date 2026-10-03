'use client';

import { useEffect } from 'react';
import { describeApiError } from '@agentos/ui-foundation';
import { t } from '@agentos/ui-foundation/i18n';
import { ErrorState } from '@agentos/ui-foundation/react';

/**
 * Route-level error boundary for the platform console. `reset` re-renders the failed segment so the
 * operator can retry the data fetch without a full page reload.
 */
export default function AppError({ error, reset }: { readonly error: Error & { readonly digest?: string }; readonly reset: () => void }) {
  const view = describeApiError(error);
  const technical = view.correlation_id ? `${view.code} · ${t('errors.correlation_id')}: ${view.correlation_id}` : view.code;

  useEffect(() => {
    console.error('platform-admin route error', error);
  }, [error]);

  return (
    <div className="ui-page-state" role="alert">
      <h1 className="ui-page-state__title">{t('errors.page_title')}</h1>
      <p className="ui-page-state__body">{t('errors.page_body')}</p>
      <ErrorState message={view.message} onRetry={reset} retryLabel={t('common.retry')} />
      <details className="ui-page-state__details">
        <summary>{t('errors.technical_details')}</summary>
        <p className="font-mono text-xs text-muted">{technical}</p>
      </details>
    </div>
  );
}
