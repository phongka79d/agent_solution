import type { ReactNode } from 'react';
import { statusView, type Tone } from '../status-view.js';
import { StatusBadge } from './StatusBadge.js';

const tones: readonly Tone[] = ['success', 'warning', 'info', 'neutral', 'danger', 'demo', 'ai'];

export interface AttentionCardProps {
  readonly severity: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly subline?: ReactNode;
  readonly tag?: ReactNode;
  readonly icon?: ReactNode;
  readonly actions?: ReactNode;
  readonly href?: string;
  readonly domain?: ReactNode;
  readonly className?: string;
}

export function AttentionCard({
  severity,
  title,
  description,
  subline,
  tag,
  icon,
  actions,
  href,
  domain,
  className,
}: AttentionCardProps) {
  const isTone = tones.includes(severity as Tone);
  const attentionTone = isTone ? (severity as Tone) : statusView(severity).tone;
  const status = (
    <StatusBadge
      {...(isTone ? { tone: severity as Tone, label: severity } : { code: severity })}
    />
  );
  const card = (
    <article
      className={[
        'ui-attention-card',
        'ui-surface',
        `ui-attention-card--${attentionTone}`,
        className,
      ].filter(Boolean).join(' ')}
    >
      <div className="ui-attention-card__body">
        <div className="ui-attention-card__icon" aria-hidden={icon ? undefined : 'true'}>
          {icon ?? status}
        </div>
        <div className="ui-attention-card__copy">
          <div className="ui-attention-card__header">
            <h3 className="ui-attention-card__title">{title}</h3>
            {tag ?? status}
          </div>
          {description ? <p className="ui-attention-card__description">{description}</p> : null}
          {subline ?? domain ? (
            <p className="ui-attention-card__subline">{subline ?? domain}</p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="ui-attention-card__actions">{actions}</div> : null}
    </article>
  );

  return href ? (
    <a href={href} className="ui-attention-card__link ui-focus-ring">
      {card}
    </a>
  ) : (
    card
  );
}
