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
  readonly className?: string;
}

function toneDefaultIcon(tone?: Tone): StatusIcon {
  switch (tone) {
    case 'success':
      return 'CheckCircle2';
    case 'danger':
      return 'XCircle';
    case 'warning':
      return 'AlertTriangle';
    case 'info':
      return 'Clock';
    case 'demo':
      return 'FlaskConical';
    default:
      return 'HelpCircle';
  }
}

export function StatusBadge({ code, tone, label, className }: StatusBadgeProps) {
  const view = statusView(code ?? '');
  const resolvedIconKey = (code === undefined || code.trim().length === 0) && tone !== undefined
    ? toneDefaultIcon(tone)
    : view.icon;
  const Icon = statusIcons[resolvedIconKey] ?? HelpCircle;
  const badgeLabel = label ?? t(view.label_key);
  const badgeTone = tone ?? view.tone;

  return (
    <span
      className={['ui-status', `ui-status--${badgeTone}`, className].filter(Boolean).join(' ')}
      role="status"
    >
      <Icon size={14} aria-hidden="true" focusable="false" />
      <span>{badgeLabel}</span>
    </span>
  );
}
