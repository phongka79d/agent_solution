import type { ReactNode } from 'react';
import { statusView } from '../status-view.js';
import { StatusBadge } from './StatusBadge.js';

export interface AgentCardProps {
  readonly name: ReactNode;
  readonly purpose: ReactNode;
  readonly status: string;
  /** Existing single metric content; use stats for richer two-column summaries. */
  readonly metric?: ReactNode;
  readonly stats?: ReactNode;
  readonly footer?: ReactNode;
  readonly activityHref?: string;
  readonly activityLabel?: ReactNode;
  readonly href?: string;
  readonly className?: string;
}

export function AgentCard({
  name,
  purpose,
  status,
  metric,
  stats,
  footer,
  activityHref,
  activityLabel,
  href,
  className,
}: AgentCardProps) {
  const statusTone = statusView(status).tone;
  const card = (
    <article className={['ui-agent-card', 'ui-surface', className].filter(Boolean).join(' ')}>
      <div className="ui-agent-card__header">
        <h3 className="ui-agent-card__name">{name}</h3>
        <span className={`ui-agent-card__status-dot ui-agent-card__status-dot--${statusTone}`} aria-hidden="true" />
        <StatusBadge code={status} />
      </div>
      <p className="ui-agent-card__purpose">{purpose}</p>
      {stats !== undefined || metric !== undefined ? (
        <div className="ui-agent-card__stats">{stats ?? metric}</div>
      ) : null}
      {footer !== undefined ? <div className="ui-agent-card__footer">{footer}</div> : null}
      {activityHref && !href ? (
        <a className="ui-agent-card__activity ui-focus-ring" href={activityHref}>
          {activityLabel}
        </a>
      ) : null}
    </article>
  );

  return href ? (
    <a className="ui-agent-card__link ui-focus-ring" href={href}>
      {card}
    </a>
  ) : (
    card
  );
}
