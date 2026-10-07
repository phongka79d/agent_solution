import { LoaderCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../i18n/index.js';

export interface LoadingStateProps {
  readonly label?: ReactNode;
  readonly className?: string;
}

export function LoadingState({ label, className }: LoadingStateProps) {
  return (
    <div className={['ui-loading-state', className].filter(Boolean).join(' ')} role="status" aria-live="polite">
      <LoaderCircle className="ui-loading-state__icon" size={18} aria-hidden="true" />
      <span>{label ?? t('common.loading')}</span>
    </div>
  );
}
