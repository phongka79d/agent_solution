'use client';

import { X } from 'lucide-react';
import { useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { t } from '../i18n/index.js';
import { useFocusTrap } from './useFocusTrap.js';

export interface DrawerProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly children: ReactNode;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly side?: 'left' | 'right';
  readonly closeLabel?: string;
  readonly className?: string;
}

export function Drawer({
  open,
  onClose,
  title,
  children,
  description,
  actions,
  side = 'right',
  closeLabel,
  className = '',
}: DrawerProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useFocusTrap(dialogRef, open, onClose);

  if (!open) return null;

  function closeFromBackdrop(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <div className="ui-drawer" onMouseDown={closeFromBackdrop}>
      <div
        ref={dialogRef}
        className={`ui-drawer__panel ui-drawer__panel--${side} ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <div className="ui-drawer__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <button type="button" className="ui-focus-ring" aria-label={closeLabel ?? t('common.close')} onClick={onClose}>
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <div className="ui-drawer__content">{children}</div>
        {actions ? <div className="ui-drawer__actions">{actions}</div> : null}
      </div>
    </div>
  );
}
