'use client';

import { Suspense, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { AuthLayout, Button, Field, Input } from '@agentos/ui-foundation/react';
import { t } from '@agentos/ui-foundation/i18n';
import {
  acceptPlatformInvitation,
  ApiError,
  inspectPlatformInvitation,
  type PlatformInvitationInspection,
} from '../../../lib/platform-client';

const MINIMUM_PASSWORD_LENGTH = 12;

function AcceptInviteContent() {
  const searchParams = useSearchParams();
  const token = searchParams.get('token')?.trim() ?? '';
  const [inspection, setInspection] = useState<PlatformInvitationInspection | null>(null);
  const [invalid, setInvalid] = useState(token.length === 0);
  const [checking, setChecking] = useState(token.length > 0);
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (token.length === 0) return;
    let cancelled = false;
    setChecking(true);
    void inspectPlatformInvitation(token)
      .then((value) => {
        if (!cancelled) setInspection(value);
      })
      .catch(() => {
        if (!cancelled) setInvalid(true);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => { cancelled = true; };
  }, [token]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (password.length < MINIMUM_PASSWORD_LENGTH) {
      setError(t('auth.password_too_short', { count: MINIMUM_PASSWORD_LENGTH }));
      return;
    }
    if (password !== confirmation) {
      setError(t('auth.passwords_mismatch'));
      return;
    }
    setIsSubmitting(true);
    try {
      await acceptPlatformInvitation(token, password, displayName);
      setDisplayName('');
      setPassword('');
      setConfirmation('');
      setDone(true);
      window.setTimeout(() => window.location.replace('/sign-in?invited=1'), 1200);
    } catch (reason: unknown) {
      if (reason instanceof ApiError && reason.status === 422) {
        setInvalid(true);
      } else {
        setError(t('auth.unavailable'));
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  if (invalid) {
    return (
      <AuthLayout audience="platform" demo className="platform-auth">
        <div role="alert" className="ui-state ui-state--error">
          {t('auth.accept_invite_invalid')}
        </div>
      </AuthLayout>
    );
  }

  if (done) {
    return (
      <AuthLayout audience="platform" demo className="platform-auth">
        <p role="status" className="text-sm text-ink">{t('auth.accept_invite_success')}</p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout audience="platform" demo className="platform-auth">
      <div className="mb-8">
        <h1 id="platform-accept-invite-title" className="text-2xl font-semibold tracking-tight text-ink">{t('auth.accept_invite_title')}</h1>
        <p className="mt-2 text-sm leading-6 text-muted">{t('platform.accept_invite_body')}</p>
        {checking ? <p role="status" className="mt-2 text-sm text-muted">{t('common.loading')}</p> : null}
        {inspection !== null ? <p className="mt-2 text-sm text-muted">{inspection.email}</p> : null}
      </div>

      {error ? (
        <div role="alert" className="ui-state ui-state--error mb-5">
          {error}
        </div>
      ) : null}

      <form onSubmit={(event) => { void handleSubmit(event); }} className="space-y-5">
        <fieldset disabled={isSubmitting || checking} className="space-y-4">
          <Field label={t('settings.users.name')} htmlFor="platform-display-name">
            <Input
              id="platform-display-name"
              type="text"
              autoComplete="name"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={200}
            />
          </Field>
          <Field label={t('auth.password')} htmlFor="platform-invite-password">
            <Input
              id="platform-invite-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={MINIMUM_PASSWORD_LENGTH}
              maxLength={512}
            />
          </Field>
          <Field label={t('auth.confirm_password')} htmlFor="platform-invite-password-confirm">
            <Input
              id="platform-invite-password-confirm"
              type="password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              required
              maxLength={512}
            />
          </Field>
        </fieldset>

        <Button
          type="submit"
          loading={isSubmitting}
          disabled={password.length === 0 || confirmation.length === 0 || checking || inspection === null}
          className="w-full"
        >
          {t('auth.accept_invite_submit')}
        </Button>
      </form>
    </AuthLayout>
  );
}

export default function AcceptInvitePage() {
  return (
    <Suspense fallback={<main className="min-h-screen bg-canvas" aria-busy="true" />}>
      <AcceptInviteContent />
    </Suspense>
  );
}
