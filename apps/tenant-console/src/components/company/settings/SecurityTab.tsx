'use client';

import { t } from '@agentos/ui-foundation/i18n';
import { useSession } from '../../auth/SessionProvider';

function formatExpiry(value: string | null | undefined): string {
  if (value === undefined || value === null) return '—';
  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? '—' : instant.toLocaleString();
}

export function SecurityTab() {
  const session = useSession();

  return (
    <div className="space-y-5" data-testid="settings-security-tab">
      <section className="space-y-3">
        <h3 className="text-base font-semibold text-ink">{t('settings.security.policy')}</h3>
        <p className="rounded-lg border border-line bg-surface-muted p-3 text-sm text-muted" role="note">{t('settings.security.policy_note')}</p>
      </section>
      <section className="space-y-3">
        <dl className="grid gap-3 sm:grid-cols-2">
          <div>
            <dt className="text-sm text-muted">{t('settings.security.current_expiry')}</dt>
            <dd className="font-medium text-ink">{formatExpiry(session?.expires_at)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">{t('settings.security.active_sessions')}</dt>
            <dd className="text-sm text-muted">{t('settings.security.active_sessions_unavailable')}</dd>
          </div>
        </dl>
      </section>
      <section className="space-y-2">
        <h3 className="text-base font-semibold text-ink">{t('settings.security.other_sessions')}</h3>
        <p className="rounded-lg border border-line bg-surface-muted p-3 text-sm text-muted" role="note">{t('settings.security.other_sessions_note')}</p>
      </section>
    </div>
  );
}
