'use client';

import type { ReactNode } from 'react';
import { t } from '../i18n/index.js';
import { Button } from './Button.js';
import { Modal } from './Modal.js';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: ReactNode;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  /** `danger` marks an irreversible or destructive decision. */
  readonly tone?: 'default' | 'danger';
  readonly busy?: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = 'default',
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      className="ui-confirm-dialog"
      {...(typeof description === 'string' ? { description } : {})}
      actions={
        <>
          <Button variant="secondary" onClick={onCancel} disabled={busy}>
            {cancelLabel ?? t('common.cancel')}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmLabel ?? t('common.confirm')}
          </Button>
        </>
      }
    >
      {typeof description === 'string' ? null : description}
    </Modal>
  );
}
