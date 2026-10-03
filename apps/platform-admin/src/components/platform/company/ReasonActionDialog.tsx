'use client';

import type { ReactNode } from 'react';
import { Button, Field, Input, Modal } from '@agentos/ui-foundation/react';
import { t } from '@agentos/ui-foundation/i18n';

interface ReasonActionDialogProps {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly confirmLabel: string;
  readonly reason: string;
  readonly busy: boolean;
  readonly additionalField?: ReactNode;
  readonly onReasonChange: (value: string) => void;
  readonly onClose: () => void;
  readonly onConfirm: () => void;
}

export function ReasonActionDialog({
  open,
  title,
  description,
  confirmLabel,
  reason,
  busy,
  additionalField,
  onReasonChange,
  onClose,
  onConfirm,
}: ReasonActionDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      actions={
        <>
          <Button variant="secondary" disabled={busy} onClick={onClose}>{t('platform.cancel')}</Button>
          <Button variant="danger" disabled={busy || reason.trim().length === 0} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {additionalField}
        <Field label={t('platform.reason')}>
          <Input
            required
            value={reason}
            onChange={(event) => onReasonChange(event.currentTarget.value)}
          />
        </Field>
      </div>
    </Modal>
  );
}
