import { t } from '../i18n/index.js';
import { statusView } from '../status-view.js';
import { StatusBadge } from './StatusBadge.js';

export interface DataClassBadgeProps {
  /** Wire data class: the `agentos.data_class` enum, `PRODUCTION | DEMO | TEST`. */
  readonly code: string;
  readonly className?: string;
}

/**
 * One vocabulary for the data class shown on customer, run and campaign surfaces.
 * `PRODUCTION` is the normal state and stays hidden; `DEMO` and `TEST` are flagged explicitly.
 */
export function DataClassBadge({ code, className }: DataClassBadgeProps) {
  if (code.trim().toUpperCase() === 'PRODUCTION') return null;
  const view = statusView('data_class', code);
  return <StatusBadge code={code} tone={view.tone} label={t(view.label_key)} {...(className ? { className } : {})} />;
}
