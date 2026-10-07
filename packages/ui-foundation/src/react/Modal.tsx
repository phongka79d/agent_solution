'use client';

import { X } from 'lucide-react';
import { useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { t } from '../i18n/index.js';
import { useFocusTrap } from './useFocusTrap.js';

export interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly title: string;
  readonly children: ReactNode;
  readonly description?: string;
  readonly actions?: ReactNode;
  readonly closeLabel?: string;
  readonly className?: string;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  description,
  actions,
  closeLabel,
  className = '',
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useFocusTrap(dialogRef, open, onClose);

  if (!open) return null;

  function closeFromBackdrop(event: MouseEvent<HTMLDivElement>): void {
    if (event.target === event.currentTarget) onClose();
  }

  return (
    <div className="ui-modal" onMouseDown={closeFromBackdrop}>
      <div
        ref={dialogRef}
        className={`ui-modal__panel ${className}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
      >
        <div className="ui-modal__header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description ? <p id={descriptionId}>{description}</p> : null}
          </div>
          <button type="button" className="ui-focus-ring" aria-label={closeLabel ?? t('common.close')} onClick={onClose}>
            <X aria-hidden="true" size={20} />
          </button>
        </div>
        <div className="ui-modal__content">{children}</div>
        {actions ? <div className="ui-modal__actions">{actions}</div> : null}
      </div>
    </div>
  );
}
