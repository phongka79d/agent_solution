'use client';

import { useEffect, useState } from 'react';
import { t } from '@agentos/ui-foundation/i18n';
import { Button } from '@agentos/ui-foundation/react';
import { useSession } from './SessionProvider';

const WARNING_WINDOW_MS = 5 * 60 * 1000;

function cookieToken(name: string): string {
  if (typeof document === 'undefined') return '';
  const entry = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  if (!entry) return '';
  try {
    return decodeURIComponent(entry.slice(name.length + 1));
  } catch {
    return '';
  }
}

function signInUrl(): string {
  const path = typeof window === 'undefined' ? '/' : `${window.location.pathname}${window.location.search}`;
  return `/sign-in?reason=expired&next=${encodeURIComponent(path)}`;
}

/** Sliding-session prompt for the platform console: offers "Gia hạn" 5 minutes before expiry. */
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
      const response = await fetch('/api/auth/renew', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'x-csrf-token': cookieToken('agentos_platform_csrf') },
      });
      if (!response.ok) throw new Error(`renew failed (${response.status})`);
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
