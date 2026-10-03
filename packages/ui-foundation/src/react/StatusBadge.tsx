import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Clock,
  CloudOff,
  FlaskConical,
  HelpCircle,
  Inbox,
  LifeBuoy,
  PauseCircle,
  Plug,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../i18n/index.js';
import { statusView, type StatusIcon, type Tone } from '../status-view.js';

const statusIcons: Record<StatusIcon, LucideIcon> = {
  CheckCircle2,
  AlertTriangle,
  Clock,
  CircleDashed,
  Plug,
  Inbox,
  PauseCircle,
  XCircle,
  LifeBuoy,
  CloudOff,
  FlaskConical,
  HelpCircle,
};

export interface StatusBadgeProps {
  readonly code?: string;
  readonly tone?: Tone;
  readonly label?: ReactNode;
  readonly live?: boolean;
  readonly className?: string;
}

export function StatusBadge({ code, tone, label, live = false, className }: StatusBadgeProps) {
  const view = statusView(code ?? '');
  const Icon = statusIcons[view.icon] ?? HelpCircle;
  const badgeLabel = label ?? t(view.label_key);
  const badgeTone = tone ?? view.tone;

  return (
    <span
      className={['ui-status', `ui-status--${badgeTone}`, className].filter(Boolean).join(' ')}
      role={live ? 'status' : undefined}
    >
      <Icon size={14} aria-hidden="true" focusable="false" />
      <span>{badgeLabel}</span>
    </span>
  );
}
