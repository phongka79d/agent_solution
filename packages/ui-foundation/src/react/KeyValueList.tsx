import type { ReactNode } from 'react';
import { t } from '../i18n/index.js';

export interface KeyValueItem {
  readonly key: string;
  readonly label: ReactNode;
  readonly value: ReactNode;
}

export interface KeyValueListProps {
  readonly items: readonly KeyValueItem[];
  readonly emptyLabel?: ReactNode;
  readonly className?: string;
}

/** Two-column definition list for read-only facts; long values wrap instead of truncating. */
export function KeyValueList({ items, emptyLabel, className }: KeyValueListProps) {
  if (items.length === 0) {
    return (
      <p className={['ui-key-value-list__empty', className].filter(Boolean).join(' ')}>
        {emptyLabel ?? t('common.empty')}
      </p>
    );
  }
  return (
    <dl className={['ui-key-value-list', className].filter(Boolean).join(' ')}>
      {items.map((item) => (
        <div key={item.key} className="ui-key-value-list__row">
          <dt className="ui-key-value-list__label">{item.label}</dt>
          <dd className="ui-key-value-list__value">{item.value === null || item.value === undefined || item.value === '' ? t('common.empty') : item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
