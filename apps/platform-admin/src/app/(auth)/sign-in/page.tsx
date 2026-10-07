'use client';

import { can, safeNext, type AuthSession } from '@agentos/ui-foundation/auth';
import { AuthLayout, Button, Field, Input } from '@agentos/ui-foundation/react';
import { t } from '@agentos/ui-foundation/i18n';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
type ViewState = 'loading' | 'ready' | 'disabled' | 'signed_in' | 'error' | 'permission';

function responseError(status: number, payload: unknown): string {
  const code = payload !== null && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
    ? payload.error
    : '';
  if (status === 404 || code === 'NOT_FOUND') return 'Sign-in is not available in this environment.';
  if (status === 403 || code === 'PERMISSION_DENIED') return t('auth.forbidden');
  if (status === 401 || code === 'AUTHENTICATION_FAILED') return t('auth.invalid_credentials');
  if (status === 429 || code === 'TOO_MANY_ATTEMPTS') return t('auth.too_many_attempts');
  if (status >= 500) return t('common.error');
  return 'Sign-in could not be completed.';
}

async function jsonPayload(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function isPlatformSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<AuthSession>;
  return Boolean(candidate.identity && candidate.membership && Array.isArray(candidate.permissions) && typeof candidate.expires_at === 'string' && can(candidate as AuthSession, 'platform:admin'));
}

function AuthPageContent() {
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get('next'));
  const expired = searchParams.get('reason') === 'expired';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [viewState, setViewState] = useState<ViewState>('loading');
  const [message, setMessage] = useState<string | null>(expired ? t('auth.session_expired') : null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(async (response) => ({ response, payload: await jsonPayload(response) }))
      .then(({ response, payload }) => {
        if (!active) return;
        if (response.ok && isPlatformSession(payload)) {
          setViewState('signed_in');
          window.location.assign(next);
          return;
        }
        if (response.status === 404) {
          setViewState('disabled');
          setMessage(responseError(response.status, payload));
          return;
        }
        if (response.status === 403) {
          setViewState('permission');
          setMessage(responseError(response.status, payload));
          return;
        }
        if (response.status >= 500) {
          setViewState('error');
          setMessage(responseError(response.status, payload));
          return;
        }
        setViewState('ready');
      })
      .catch(() => {
        if (!active) return;
        setViewState('error');
        setMessage(t('common.error'));
      });
    return () => {
      active = false;
    };
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!email.trim() || !password || submitting || viewState === 'disabled') return;
    setSubmitting(true);
    setMessage(null);
    try {
      const response = await fetch('/api/auth/sign-in', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'content-type': 'application/json', 'x-csrf-token': readCsrfToken() },
        body: JSON.stringify({ email, password }),
      });
      const payload = await jsonPayload(response);
      if (!response.ok) {
        setViewState(response.status === 404 ? 'disabled' : response.status === 403 ? 'permission' : 'error');
        setMessage(responseError(response.status, payload));
        return;
      }
      setPassword('');
      setViewState('signed_in');
      window.location.assign(next);
    } catch {
      setViewState('error');
      setMessage(t('common.error'));
    } finally {
      setSubmitting(false);
    }
  };

  const unavailable = viewState === 'disabled';
  const loading = viewState === 'loading';

  return (
    <AuthLayout audience="platform" demo className="platform-auth">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-brand">{t('platform.auth_eyebrow')}</p>
      <h1 id="sign-in-title" className="mt-2 text-2xl font-semibold tracking-tight text-ink">{t('auth.sign_in')}</h1>
      <p className="mt-2 text-sm leading-6 text-muted">{t('platform.auth_description')}</p>

      {loading ? <p role="status" className="ui-state ui-state--loading mt-6">{t('common.loading')}</p> : null}
      {message ? <p role="alert" className={`ui-state mt-6 ${unavailable ? 'ui-state--blocked' : 'ui-state--error'}`}>{message}</p> : null}

      {!unavailable ? (
        <form onSubmit={submit} className="mt-6 space-y-5">
          <Field label={t('auth.email')} htmlFor="platform-email">
            <Input id="platform-email" name="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required disabled={loading || submitting} />
          </Field>
          <Field label={t('auth.password')} htmlFor="platform-password">
            <Input id="platform-password" name="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required disabled={loading || submitting} />
          </Field>
          <Button type="submit" loading={submitting} loadingLabel={t('common.loading')} disabled={loading || !email.trim() || !password} className="w-full">
            {t('auth.sign_in')}
          </Button>
        </form>
      ) : null}

      <p className="mt-6 border-t border-line pt-4 text-xs leading-5 text-muted">Credentials stay server-side. This view never stores or exposes API bearer tokens.</p>
    </AuthLayout>
  );
}
export default function AuthPage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-canvas" aria-busy="true" />}>
      <AuthPageContent />
    </Suspense>
  );
}

function readCsrfToken(): string {
  const entry = document.cookie.split(';').map((part) => part.trim()).find((part) => part.startsWith('agentos_platform_csrf='));
  if (!entry) return '';
  try {
    return decodeURIComponent(entry.slice('agentos_platform_csrf='.length));
  } catch {
    return '';
  }
}
