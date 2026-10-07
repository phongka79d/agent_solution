import type { ReactNode } from 'react';
import { t } from '../i18n/index.js';
import { StatusBadge } from './StatusBadge.js';

export interface MetricCardProps {
  readonly label: ReactNode;
  readonly value?: ReactNode;
  readonly status?: string | ReactNode;
  readonly detail?: ReactNode;
  readonly className?: string;
}

export function MetricCard({ label, value, status, detail, className }: MetricCardProps) {
  return (
    <article className={['ui-metric-card', 'ui-surface', className].filter(Boolean).join(' ')}>
      <div className="ui-metric-card__header">
        <h3 className="ui-metric-card__label">{label}</h3>
        {typeof status === 'string' ? <StatusBadge code={status} /> : status}
      </div>
      <p className="ui-metric-card__value">{value == null ? t('common.empty') : value}</p>
      {detail ? <div className="ui-metric-card__detail">{detail}</div> : null}
    </article>
  );
}
