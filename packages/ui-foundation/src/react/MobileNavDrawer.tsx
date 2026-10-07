'use client';

import { X } from 'lucide-react';
import { useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { t } from '../i18n/index.js';
import type { SidebarItem } from './Sidebar.js';
import { useFocusTrap } from './useFocusTrap.js';

export interface MobileNavDrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly items: readonly SidebarItem[];
  readonly workspace?: ReactNode;
  readonly footer?: ReactNode;
}

export function MobileNavDrawer({ open, onClose, items, workspace, footer }: MobileNavDrawerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useFocusTrap(dialogRef, open, onClose);

  if (!open) return null;

  function closeFromBackdrop(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <div className="mobile-nav-drawer" onMouseDown={closeFromBackdrop}>
      <div
        ref={dialogRef}
        className="mobile-nav-drawer__panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="mobile-nav-drawer__header">
          <h2 id={titleId}>{t('common.menu')}</h2>
          <button type="button" className="ui-focus-ring" aria-label={t('common.close')} onClick={onClose}>
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        {workspace ? <div className="mobile-nav-drawer__workspace">{workspace}</div> : null}
        <nav aria-label={t('common.menu')}>
          <ul>
            {items.map((item) => (
              <li key={item.href}>
                <a
                  className="ui-focus-ring"
                  href={item.href}
                  aria-current={item.active ? 'page' : undefined}
                  onClick={onClose}
                >
                  {item.icon ? <span aria-hidden="true">{item.icon}</span> : null}
                  <span>{item.label}</span>
                  {item.badge ? <span>{item.badge}</span> : null}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {footer ? <div className="mobile-nav-drawer__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
