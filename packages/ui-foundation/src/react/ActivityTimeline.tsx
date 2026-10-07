import type { Key, ReactNode } from 'react';

export interface ActivityTimelineItem {
  readonly id: Key;
  readonly time: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly href?: string;
}

export interface ActivityTimelineProps {
  readonly items: readonly ActivityTimelineItem[];
  readonly className?: string;
}

export function ActivityTimeline({ items, className }: ActivityTimelineProps) {
  return (
    <ol className={['ui-activity-timeline', className].filter(Boolean).join(' ')}>
      {items.map((item) => {
        const title = <span className="ui-activity-timeline__title">{item.title}</span>;
        return (
          <li key={item.id} className="ui-activity-timeline__item">
            <div className="ui-activity-timeline__marker" aria-hidden="true" />
            <div className="ui-activity-timeline__content">
              <time className="ui-activity-timeline__time">{item.time}</time>
              {item.href ? (
                <a href={item.href} className="ui-activity-timeline__link ui-focus-ring">
                  {title}
                </a>
              ) : (
                title
              )}
              {item.description ? <p className="ui-activity-timeline__description">{item.description}</p> : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
