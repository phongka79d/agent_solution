export type Tone = 'success' | 'warning' | 'info' | 'neutral' | 'danger' | 'demo' | 'ai';

export type StatusIcon =
  | 'CheckCircle2'
  | 'AlertTriangle'
  | 'Clock'
  | 'CircleDashed'
  | 'Plug'
  | 'Inbox'
  | 'PauseCircle'
  | 'XCircle'
  | 'LifeBuoy'
  | 'CloudOff'
  | 'FlaskConical'
  | 'HelpCircle';

export interface StatusView {
  readonly code: string;
  readonly label_key: string;
  readonly tone: Tone;
  readonly icon: StatusIcon;
}

type StatusDefinition = Omit<StatusView, 'code'>;

const STATUS_DEFINITIONS: Readonly<Record<string, StatusDefinition>> = {
  ACTIVE: { label_key: 'status.active', tone: 'success', icon: 'CheckCircle2' },
  LIVE: { label_key: 'status.active', tone: 'success', icon: 'CheckCircle2' },
  ATTENTION: { label_key: 'status.attention', tone: 'warning', icon: 'AlertTriangle' },
  APPROVAL_PENDING: { label_key: 'status.approval_pending', tone: 'info', icon: 'Clock' },
  AWAITING_HUMAN_APPROVAL: { label_key: 'status.approval_pending', tone: 'info', icon: 'Clock' },
  NOT_CONFIGURED: { label_key: 'status.not_configured', tone: 'neutral', icon: 'Plug' },
  UNBOUND: { label_key: 'status.not_configured', tone: 'neutral', icon: 'Plug' },
  UNCONFIGURED: { label_key: 'status.not_configured', tone: 'neutral', icon: 'Plug' },
  NOT_INTEGRATED: { label_key: 'status.not_integrated', tone: 'neutral', icon: 'CircleDashed' },
  NO_DATA: { label_key: 'status.no_data', tone: 'neutral', icon: 'Inbox' },
  EMPTY: { label_key: 'status.no_data', tone: 'neutral', icon: 'Inbox' },
  PAUSED: { label_key: 'status.paused', tone: 'neutral', icon: 'PauseCircle' },
  paused_takeover: { label_key: 'status.paused', tone: 'neutral', icon: 'PauseCircle' },
  CLOSED: { label_key: 'status.paused', tone: 'neutral', icon: 'PauseCircle' },
  OPEN: { label_key: 'status.active', tone: 'success', icon: 'CheckCircle2' },
  FAILED: { label_key: 'status.failed', tone: 'danger', icon: 'XCircle' },
  ERROR: { label_key: 'status.failed', tone: 'danger', icon: 'XCircle' },
  HUMAN_HANDOFF: { label_key: 'status.human_handoff', tone: 'warning', icon: 'LifeBuoy' },
  HUMAN_TAKEOVER: { label_key: 'status.human_handoff', tone: 'warning', icon: 'LifeBuoy' },
  PROVIDER_UNAVAILABLE: { label_key: 'status.provider_unavailable', tone: 'danger', icon: 'CloudOff' },
  DEMO_MOCK: { label_key: 'status.demo', tone: 'demo', icon: 'FlaskConical' },
  SYNTHETIC: { label_key: 'status.demo', tone: 'demo', icon: 'FlaskConical' },
};

export function statusView(code: string): StatusView {
  const normalized = (code ?? '').trim().toUpperCase();
  const definition = STATUS_DEFINITIONS[code] ?? STATUS_DEFINITIONS[normalized];
  return definition === undefined
    ? { code, label_key: 'status.unknown', tone: 'neutral', icon: 'HelpCircle' }
    : { code, ...definition };
}
