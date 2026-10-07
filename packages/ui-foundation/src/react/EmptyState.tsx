import type { ReactNode } from 'react';
import { StatusBadge } from './StatusBadge.js';

export interface EmptyStateProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  readonly status?: string;
  readonly className?: string;
}

export function EmptyState({ title, description, action, status, className }: EmptyStateProps) {
  return (
    <section className={['ui-empty-state', className].filter(Boolean).join(' ')}>
      {status ? <StatusBadge code={status} /> : null}
      <h2 className="ui-empty-state__title">{title}</h2>
      {description ? <p className="ui-empty-state__description">{description}</p> : null}
      {action ? <div className="ui-empty-state__action">{action}</div> : null}
    </section>
  );
}
