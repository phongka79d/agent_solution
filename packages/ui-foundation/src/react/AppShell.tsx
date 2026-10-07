'use client';

import type { ReactNode } from 'react';
import { t } from '../i18n/index.js';

export interface AppShellProps {
  readonly sidebar: ReactNode;
  readonly topbar: ReactNode;
  readonly children: ReactNode;
  readonly skipLinkLabel?: string;
}

export function AppShell({ sidebar, topbar, children, skipLinkLabel }: AppShellProps) {
  return (
    <div className="app-shell" data-responsive-shell="true">
      <a className="ui-focus-ring app-shell__skip-link" href="#main-content">
        {skipLinkLabel ?? t('common.skip_to_content')}
      </a>
      <header className="app-shell__header">{topbar}</header>
      <nav className="app-shell__navigation" aria-label={t('common.menu')}>
        {sidebar}
      </nav>
      <main id="main-content" className="app-main">
        {children}
      </main>
    </div>
  );
}
