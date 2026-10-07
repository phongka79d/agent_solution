'use client';

import type { ReactNode } from 'react';
import { t } from '../i18n/index.js';
import { DemoBadge } from './DemoBadge.js';

export interface AuthLayoutProps {
  readonly audience: 'company' | 'platform';
  readonly children: ReactNode;
  readonly demo?: boolean;
  readonly className?: string;
}


export function AuthLayout({ audience, children, demo = false, className = '' }: AuthLayoutProps) {
  const label = audience === 'company' ? t('auth.company_workspace') : t('auth.platform_administration');

  return (
    <main className={`auth-layout ${className}`.trim()}>
      <section className="auth-layout__card">
        <p className="auth-layout__wordmark">{t('app.name')}</p>
        <p className="auth-layout__subtitle">{label}</p>
        {demo ? <DemoBadge /> : null}
        <div className="auth-layout__content">{children}</div>
      </section>
    </main>
  );
}
