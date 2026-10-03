import Link from 'next/link';
import { t } from '@agentos/ui-foundation/i18n';

/** Route-level not-found boundary for unknown console paths. */
export default function AppNotFound() {
  return (
    <div className="ui-page-state" role="alert">
      <h1 className="ui-page-state__title">{t('errors.page_not_found_title')}</h1>
      <p className="ui-page-state__body">{t('errors.page_not_found_body')}</p>
      <Link className="ui-focus-ring ui-page-state__action" href="/">
        {t('errors.go_home')}
      </Link>
    </div>
  );
}
