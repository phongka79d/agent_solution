'use client';

import { Suspense, useState } from 'react';
import type { FormEvent } from 'react';
import { useSearchParams } from 'next/navigation';
import { safeNext } from '@agentos/ui-foundation/auth';
import { AuthLayout, Button, Field, Input } from '@agentos/ui-foundation/react';
import { t } from '@agentos/ui-foundation/i18n';
import { AuthRequestError, tenantConsoleClient } from '../../../lib/tenant-console-client';

function messageForError(value: unknown): string {
  if (value instanceof AuthRequestError) {
    if (value.status === 429) {
      return value.retryAfter !== null
        ? t('auth.too_many_attempts_retry', { seconds: value.retryAfter })
        : t('auth.too_many_attempts');
    }
    if (value.status >= 500) return t('auth.unavailable');
    return t('auth.invalid_credentials');
  }
  return t('auth.invalid_credentials');
}




function AuthPageContent() {
  const searchParams = useSearchParams();
  const next = safeNext(searchParams.get('next'));
  const expired = searchParams.get('reason') === 'expired';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      await tenantConsoleClient.signIn(email.trim(), password);
      setPassword('');
      window.location.replace(next);
    } catch (reason: unknown) {
      setError(messageForError(reason));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <AuthLayout audience="company" demo>
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-ink">{t('auth.sign_in')}</h1>
        <p className="mt-2 text-sm leading-6 text-muted">Sử dụng email và mật khẩu tài khoản của bạn.</p>
        {expired && <p role="status" className="mt-3 text-sm text-warning">{t('auth.session_expired')}</p>}
      </div>

      {error && (
        <div role="alert" className="ui-state ui-state--error mb-5">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-5">
        <fieldset disabled={isSubmitting} className="space-y-4">
          <Field label={t('auth.email')} htmlFor="email">
            <Input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              maxLength={320}
            />
          </Field>
          <Field label={t('auth.password')} htmlFor="password">
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              maxLength={512}
            />
          </Field>
        </fieldset>

        <Button
          type="submit"
          loading={isSubmitting}
          disabled={email.trim().length === 0 || password.length === 0}
          className="w-full"
        >
          {t('auth.sign_in')}
        </Button>
      </form>
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
