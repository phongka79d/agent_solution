import type { ReactNode } from 'react';
import { t } from '../i18n/index.js';

export interface AdvancedDetailsProps {
  readonly children?: ReactNode;
  readonly value?: ReactNode;
  readonly summary?: ReactNode;
  readonly open?: boolean;
  readonly className?: string;
}

export function AdvancedDetails({ children, value, summary, open, className }: AdvancedDetailsProps) {
  const content = children ?? value;
  const summaryContent = summary ?? t('common.advanced');

  if (open) {
    return (
      <details className={['ui-advanced-details', className].filter(Boolean).join(' ')} open>
        <summary className="ui-advanced-details__summary ui-focus-ring">{summaryContent}</summary>
        <div className="ui-advanced-details__content">{content}</div>
      </details>
    );
  }

  return (
    <details className={['ui-advanced-details', className].filter(Boolean).join(' ')}>
      <summary className="ui-advanced-details__summary ui-focus-ring">{summaryContent}</summary>
      <div className="ui-advanced-details__content">{content}</div>
    </details>
  );
}
