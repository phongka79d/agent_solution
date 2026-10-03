import { Check, CircleDashed, Clock, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../i18n/index.js';

export type StageState = 'pending' | 'active' | 'done' | 'failed';

export interface StageTimelineItem {
  readonly key: string;
  readonly label: ReactNode;
  readonly state: StageState;
  readonly at?: string | null;
  readonly detail?: ReactNode;
}

export interface StageTimelineProps {
  readonly stages: readonly StageTimelineItem[];
  readonly className?: string;
}

const STAGE_ICONS: Record<StageState, typeof Check> = {
  pending: CircleDashed,
  active: Clock,
  done: Check,
  failed: X,
};

/** Ordered, accessible stage list (campaign lifecycle, run stages) with per-stage timing. */
export function StageTimeline({ stages, className }: StageTimelineProps) {
  return (
    <ol className={['ui-stage-timeline', className].filter(Boolean).join(' ')}>
      {stages.map((stage) => {
        const Icon = STAGE_ICONS[stage.state];
        return (
          <li key={stage.key} className={`ui-stage-timeline__item ui-stage-timeline__item--${stage.state}`}>
            <span className="ui-stage-timeline__marker" aria-hidden="true">
              <Icon size={14} />
            </span>
            <div className="ui-stage-timeline__content">
              <p className="ui-stage-timeline__label">
                {stage.label}
                <span className="sr-only">{t(`stage.state.${stage.state}`)}</span>
              </p>
              {stage.at ? (
                <time className="ui-stage-timeline__time" dateTime={stage.at}>
                  {stage.at}
                </time>
              ) : null}
              {stage.detail ? <p className="ui-stage-timeline__detail">{stage.detail}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
