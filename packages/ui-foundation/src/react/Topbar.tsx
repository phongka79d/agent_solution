'use client';

import { Menu } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../i18n/index.js';

export interface TopbarProps {
  readonly title?: string;
  readonly actions?: ReactNode;
  readonly onOpenMenu?: () => void;
}

export function Topbar({ title, actions, onOpenMenu }: TopbarProps) {
  return (
    <div className="app-topbar">
      <div className="app-topbar__leading">
        {onOpenMenu ? (
          <button
            type="button"
            className="ui-focus-ring mobile-menu-button"
            aria-label={t('common.menu')}
            onClick={onOpenMenu}
          >
            <Menu aria-hidden="true" size={20} />
          </button>
        ) : null}
        {title ? <p className="app-topbar__title">{title}</p> : null}
      </div>
      {actions ? <div className="app-topbar__actions">{actions}</div> : null}
    </div>
  );
}
