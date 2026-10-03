'use client';

import { useEffect, useState } from 'react';
import { t } from '@agentos/ui-foundation/i18n';
import { Button } from '@agentos/ui-foundation/react';
import { tenantConsoleClient } from '../../lib/tenant-console-client';
import { useSession } from './SessionProvider';

/** Show the renewal prompt this far before the session expires. */
const WARNING_WINDOW_MS = 5 * 60 * 1000;

function signInUrl(): string {
  const path = typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}`;
  return `/sign-in?reason=expired&next=${encodeURIComponent(path)}`;
}

/**
 * Sliding-session prompt: 5 minutes before expiry it offers "Gia hạn"; on success the server session
 * is refreshed in place, on failure it tells the user to sign in again rather than silently bouncing.
 */
export function SessionExpiryDialog() {
  const session = useSession();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [extended, setExtended] = useState(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const remainingMs = session ? Date.parse(session.expires_at) - now : Number.POSITIVE_INFINITY;

  useEffect(() => {
    if (!session || !Number.isFinite(remainingMs) || remainingMs > 0) return;
    window.location.assign(signInUrl());
  }, [session, remainingMs]);

  if (!session || extended) return null;
  if (!Number.isFinite(remainingMs) || remainingMs > WARNING_WINDOW_MS) return null;

  async function renew() {
    setBusy(true);
    setFailed(false);
    try {
      await tenantConsoleClient.renewSession();
      setExtended(true);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));

  return (
    <div className="ui-modal-backdrop" role="presentation">
      <div className="ui-modal" role="dialog" aria-modal="true" aria-labelledby="session-expiry-title">
        <h2 id="session-expiry-title" className="ui-modal__title">{t('auth.session_expiry_title')}</h2>
        <p className="ui-modal__body">{t('auth.session_expiry_body', { minutes })}</p>
        {failed ? <p role="alert" className="ui-state ui-state--error">{t('auth.renew_failed')}</p> : null}
        <div className="ui-modal__actions">
          <Button onClick={() => void renew()} loading={busy}>
            {busy ? t('auth.renewing') : t('auth.renew')}
          </Button>
        </div>
      </div>
    </div>
  );
}
