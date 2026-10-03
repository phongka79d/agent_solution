import { t } from '../i18n/index.js';

export type SkeletonVariant = 'text' | 'card' | 'metric' | 'table';

export interface SkeletonProps {
  readonly variant?: SkeletonVariant;
  /** Lines for `text`; rows for `table`. */
  readonly lines?: number;
  readonly className?: string;
}

/** Reserved-space placeholders keep layout stable while a projection loads. */
export function Skeleton({ variant = 'text', lines = 3, className }: SkeletonProps) {
  const rootClass = ['ui-skeleton', `ui-skeleton--${variant}`, className].filter(Boolean).join(' ');

  if (variant === 'text') {
    return (
      <div className={rootClass} role="status" aria-label={t('common.loading')}>
        {Array.from({ length: Math.max(1, lines) }, (_, index) => (
          <span key={index} className="ui-skeleton__line" aria-hidden="true" />
        ))}
      </div>
    );
  }

  if (variant === 'table') {
    return (
      <div className={rootClass} role="status" aria-label={t('common.loading')}>
        {Array.from({ length: Math.max(1, lines) }, (_, index) => (
          <span key={index} className="ui-skeleton__row" aria-hidden="true" />
        ))}
      </div>
    );
  }

  return (
    <div className={rootClass} role="status" aria-label={t('common.loading')}>
      <span className="ui-skeleton__block" aria-hidden="true" />
    </div>
  );
}
