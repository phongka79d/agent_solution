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

/** Domains own their code tables so one raw code never leaks a wrong label across surfaces. */
export type StatusDomain =
  | 'agent'
  | 'connector'
  | 'probe'
  | 'provider'
  | 'run'
  | 'campaign'
  | 'approval'
  | 'conversation'
  | 'handoff'
  | 'knowledge'
  | 'skill'
  | 'tenant'
  | 'owner_input'
  | 'data_class'
  | 'company_user';
export const STATUS_DOMAINS: readonly StatusDomain[] = [
  'agent',
  'connector',
  'probe',
  'provider',
  'run',
  'campaign',
  'approval',
  'conversation',
  'handoff',
  'knowledge',
  'skill',
  'tenant',
  'owner_input',
  'data_class',
  'company_user',
];

export interface StatusView {
  readonly code: string;
  readonly domain: StatusDomain | null;
  readonly label_key: string;
  readonly tone: Tone;
  readonly icon: StatusIcon;
}
export interface StatusViewContext {
  readonly effectStatus?: 'RESERVED' | 'UNKNOWN';
  readonly awaitingHuman?: 'approval' | 'handoff';
}

type StatusDefinition = Omit<StatusView, 'code' | 'domain'>;

/** Neutral, localized fallback. The raw code is never rendered; callers may surface it in Advanced. */
const UNKNOWN_KEY = 'status.unknown';

const AGENT_STATUS: Readonly<Record<string, StatusDefinition>> = {
  ACTIVE: { label_key: 'status.active', tone: 'success', icon: 'CheckCircle2' },
  ENABLED: { label_key: 'status.active', tone: 'success', icon: 'CheckCircle2' },
  READY: { label_key: 'status.ready', tone: 'success', icon: 'CheckCircle2' },
  DISABLED: { label_key: 'status.disabled', tone: 'neutral', icon: 'PauseCircle' },
  PAUSED: { label_key: 'status.paused', tone: 'neutral', icon: 'PauseCircle' },
  DEMOTED: { label_key: 'status.demoted', tone: 'warning', icon: 'AlertTriangle' },
  // Autonomy policy states (core AutonomyState); PAUSED and DEMOTED share the agent labels above.
  PROMOTED: { label_key: 'status.promoted', tone: 'success', icon: 'CheckCircle2' },
  MINIMUM: { label_key: 'status.minimum', tone: 'neutral', icon: 'Clock' },
  NOT_READY: { label_key: 'status.not_ready', tone: 'warning', icon: 'AlertTriangle' },
  NOT_CONFIGURED: { label_key: 'status.not_configured', tone: 'neutral', icon: 'Plug' },
  NOT_ACTIVATED: { label_key: 'status.not_configured', tone: 'neutral', icon: 'Plug' },
  UNCONFIGURED: { label_key: 'status.not_configured', tone: 'neutral', icon: 'Plug' },
  ATTENTION: { label_key: 'status.attention', tone: 'warning', icon: 'AlertTriangle' },
  ERROR: { label_key: 'status.failed', tone: 'danger', icon: 'XCircle' },
  NO_DATA: { label_key: 'status.no_data', tone: 'neutral', icon: 'Inbox' },
  EMPTY: { label_key: 'status.no_data', tone: 'neutral', icon: 'Inbox' },
};

const CONNECTOR_STATUS: Readonly<Record<string, StatusDefinition>> = {
  LIVE: { label_key: 'company.integrations.live', tone: 'success', icon: 'CheckCircle2' },
  CONNECTED: { label_key: 'status.active', tone: 'success', icon: 'CheckCircle2' },
  DEMO_MOCK: { label_key: 'company.integrations.demo_mock', tone: 'demo', icon: 'FlaskConical' },
  NOT_CONFIGURED: { label_key: 'company.integrations.not_configured', tone: 'neutral', icon: 'Plug' },
  UNCONFIGURED: { label_key: 'status.not_configured', tone: 'neutral', icon: 'Plug' },
  ATTENTION: { label_key: 'status.attention', tone: 'warning', icon: 'AlertTriangle' },
  EMPTY: { label_key: 'status.no_data', tone: 'neutral', icon: 'Inbox' },
  UNBOUND: { label_key: 'status.not_configured', tone: 'neutral', icon: 'Plug' },
  NOT_INTEGRATED: { label_key: 'company.integrations.not_integrated', tone: 'neutral', icon: 'CircleDashed' },
  DISABLED: { label_key: 'status.disabled', tone: 'neutral', icon: 'PauseCircle' },
  DEGRADED: { label_key: 'status.degraded', tone: 'warning', icon: 'AlertTriangle' },
  ERROR: { label_key: 'status.failed', tone: 'danger', icon: 'XCircle' },
  FAILED: { label_key: 'status.failed', tone: 'danger', icon: 'XCircle' },
};

const PROBE_STATUS: Readonly<Record<string, StatusDefinition>> = {
  OK: { label_key: 'status.pass', tone: 'success', icon: 'CheckCircle2' },
  PASS: { label_key: 'status.pass', tone: 'success', icon: 'CheckCircle2' },
  PASSED: { label_key: 'status.pass', tone: 'success', icon: 'CheckCircle2' },
  SUCCESS: { label_key: 'status.pass', tone: 'success', icon: 'CheckCircle2' },
  FAIL: { label_key: 'status.failed', tone: 'danger', icon: 'XCircle' },
  FAILED: { label_key: 'status.failed', tone: 'danger', icon: 'XCircle' },
  ERROR: { label_key: 'status.failed', tone: 'danger', icon: 'XCircle' },
  TIMEOUT: { label_key: 'status.timeout', tone: 'danger', icon: 'Clock' },
  SKIPPED: { label_key: 'status.skipped', tone: 'neutral', icon: 'CircleDashed' },
  NOT_RUN: { label_key: 'status.not_run', tone: 'neutral', icon: 'CircleDashed' },
  DEGRADED: { label_key: 'status.degraded', tone: 'warning', icon: 'AlertTriangle' },
  UNKNOWN: { label_key: UNKNOWN_KEY, tone: 'neutral', icon: 'HelpCircle' },
};
const PROVIDER_STATUS: Readonly<Record<string, StatusDefinition>> = {
  VERIFIED: { label_key: 'status.verified', tone: 'success', icon: 'CheckCircle2' },
};


const RUN_STATUS: Readonly<Record<string, StatusDefinition>> = {
  ACCEPTED: { label_key: 'status.accepted', tone: 'info', icon: 'Clock' },
  accepted: { label_key: 'status.accepted', tone: 'info', icon: 'Clock' },
  QUEUED: { label_key: 'status.queued', tone: 'info', icon: 'Clock' },
  queued: { label_key: 'status.queued', tone: 'info', icon: 'Clock' },
  RUNNING: { label_key: 'status.running', tone: 'info', icon: 'CircleDashed' },
  running: { label_key: 'status.running', tone: 'info', icon: 'CircleDashed' },
  IN_PROGRESS: { label_key: 'status.running', tone: 'info', icon: 'CircleDashed' },
  WAITING: { label_key: 'status.waiting', tone: 'info', icon: 'Clock' },
  waiting: { label_key: 'status.waiting', tone: 'info', icon: 'Clock' },
  NEEDS_RECONCILIATION: { label_key: 'status.needs_reconciliation', tone: 'warning', icon: 'AlertTriangle' },
  WAITING_RECONCILE: { label_key: 'status.needs_reconciliation', tone: 'warning', icon: 'AlertTriangle' },
  waiting_reconcile: { label_key: 'status.needs_reconciliation', tone: 'warning', icon: 'AlertTriangle' },
  AWAITING_HUMAN: { label_key: 'status.awaiting_human', tone: 'warning', icon: 'LifeBuoy' },
  awaiting_human: { label_key: 'status.awaiting_human', tone: 'warning', icon: 'LifeBuoy' },
  AWAITING_HUMAN_APPROVAL: { label_key: 'status.approval_pending', tone: 'info', icon: 'Clock' },
  awaiting_human_approval: { label_key: 'status.approval_pending', tone: 'info', icon: 'Clock' },
  COMPLETED: { label_key: 'status.completed', tone: 'success', icon: 'CheckCircle2' },
  completed: { label_key: 'status.completed', tone: 'success', icon: 'CheckCircle2' },
  STOPPED: { label_key: 'status.stopped', tone: 'neutral', icon: 'PauseCircle' },
  stopped: { label_key: 'status.stopped', tone: 'neutral', icon: 'PauseCircle' },
  CANCELLED: { label_key: 'status.cancelled', tone: 'neutral', icon: 'XCircle' },
  FAILED: { label_key: 'status.failed', tone: 'danger', icon: 'XCircle' },
  failed: { label_key: 'status.failed', tone: 'danger', icon: 'XCircle' },
  ERROR: { label_key: 'status.failed', tone: 'danger', icon: 'XCircle' },
  in_flight: { label_key: 'status.running', tone: 'info', icon: 'CircleDashed' },
};

const CAMPAIGN_STATUS: Readonly<Record<string, StatusDefinition>> = {
  DRAFT: { label_key: 'campaigns.lifecycle.draft', tone: 'neutral', icon: 'CircleDashed' },
  IN_REVIEW: { label_key: 'campaigns.lifecycle.in_review', tone: 'info', icon: 'Clock' },
  AWAITING_APPROVAL: { label_key: 'campaigns.lifecycle.awaiting_approval', tone: 'info', icon: 'Clock' },
  APPROVED: { label_key: 'campaigns.lifecycle.approved', tone: 'success', icon: 'CheckCircle2' },
  SCHEDULED: { label_key: 'status.scheduled', tone: 'info', icon: 'Clock' },
  IN_FLIGHT: { label_key: 'campaigns.lifecycle.in_flight', tone: 'success', icon: 'CheckCircle2' },
  SENDING: { label_key: 'campaigns.lifecycle.in_flight', tone: 'success', icon: 'CheckCircle2' },
  SENT: { label_key: 'status.sent', tone: 'success', icon: 'CheckCircle2' },
  COMPLETED: { label_key: 'status.completed', tone: 'success', icon: 'CheckCircle2' },
  PAUSED: { label_key: 'status.paused', tone: 'neutral', icon: 'PauseCircle' },
  REJECTED: { label_key: 'status.rejected', tone: 'danger', icon: 'XCircle' },
  CANCELLED: { label_key: 'status.cancelled', tone: 'neutral', icon: 'XCircle' },
  FAILED: { label_key: 'status.failed', tone: 'danger', icon: 'XCircle' },
};

const APPROVAL_STATUS: Readonly<Record<string, StatusDefinition>> = {
  PENDING: { label_key: 'status.approval_pending', tone: 'info', icon: 'Clock' },
  APPROVAL_PENDING: { label_key: 'status.approval_pending', tone: 'info', icon: 'Clock' },
  AWAITING_HUMAN_APPROVAL: { label_key: 'status.approval_pending', tone: 'info', icon: 'Clock' },
  DECIDED: { label_key: 'status.decided', tone: 'success', icon: 'CheckCircle2' },
  APPROVED: { label_key: 'status.approved', tone: 'success', icon: 'CheckCircle2' },
  REJECTED: { label_key: 'status.rejected', tone: 'danger', icon: 'XCircle' },
  MODIFIED: { label_key: 'status.modified', tone: 'warning', icon: 'AlertTriangle' },
  PAUSE: { label_key: 'status.paused', tone: 'neutral', icon: 'PauseCircle' },
  PAUSED: { label_key: 'status.paused', tone: 'neutral', icon: 'PauseCircle' },
  CANCEL: { label_key: 'status.cancelled', tone: 'neutral', icon: 'XCircle' },
  CANCELLED: { label_key: 'status.cancelled', tone: 'neutral', icon: 'XCircle' },
  EXPIRED: { label_key: 'status.expired', tone: 'neutral', icon: 'Clock' },
  STALE: { label_key: 'status.stale', tone: 'warning', icon: 'AlertTriangle' },
};

const CONVERSATION_STATUS: Readonly<Record<string, StatusDefinition>> = {
  AI_ACTIVE: { label_key: 'conversation.ownership.ai_active', tone: 'ai', icon: 'CircleDashed' },
  ai_active: { label_key: 'conversation.ownership.ai_active', tone: 'ai', icon: 'CircleDashed' },
  NEEDS_HUMAN: { label_key: 'conversation.ownership.needs_human', tone: 'warning', icon: 'LifeBuoy' },
  needs_human: { label_key: 'conversation.ownership.needs_human', tone: 'warning', icon: 'LifeBuoy' },
  HUMAN_ME: { label_key: 'conversation.ownership.human_me', tone: 'info', icon: 'LifeBuoy' },
  human_me: { label_key: 'conversation.ownership.human_me', tone: 'info', icon: 'LifeBuoy' },
  HUMAN_OTHER: { label_key: 'conversation.ownership.human_other', tone: 'info', icon: 'LifeBuoy' },
  human_other: { label_key: 'conversation.ownership.human_other', tone: 'info', icon: 'LifeBuoy' },
  PAUSED_ORPHAN: { label_key: 'conversation.ownership.paused_orphan', tone: 'neutral', icon: 'PauseCircle' },
  paused_takeover: { label_key: 'conversation.ownership.paused_orphan', tone: 'neutral', icon: 'PauseCircle' },
  CLOSED: { label_key: 'conversation.ownership.closed', tone: 'neutral', icon: 'XCircle' },
  closed: { label_key: 'conversation.ownership.closed', tone: 'neutral', icon: 'XCircle' },
  OPEN: { label_key: 'conversation.state.open', tone: 'success', icon: 'CheckCircle2' },
  open: { label_key: 'conversation.state.open', tone: 'success', icon: 'CheckCircle2' },
  HUMAN_TAKEOVER: { label_key: 'conversation.state.human_takeover', tone: 'info', icon: 'LifeBuoy' },
  persisted: { label_key: 'conversation.message.persisted', tone: 'success', icon: 'CheckCircle2' },
  PAUSED: { label_key: 'status.paused', tone: 'neutral', icon: 'PauseCircle' },
};

const HANDOFF_STATUS: Readonly<Record<string, StatusDefinition>> = {
  HUMAN_HANDOFF: { label_key: 'status.human_handoff', tone: 'warning', icon: 'LifeBuoy' },
  REQUESTED: { label_key: 'handoff.state.requested', tone: 'warning', icon: 'LifeBuoy' },
  PENDING: { label_key: 'handoff.state.pending', tone: 'warning', icon: 'LifeBuoy' },
  ACCEPTED: { label_key: 'handoff.state.accepted', tone: 'info', icon: 'LifeBuoy' },
  IN_PROGRESS: { label_key: 'handoff.state.in_progress', tone: 'info', icon: 'CircleDashed' },
  COMPLETED: { label_key: 'handoff.state.completed', tone: 'success', icon: 'CheckCircle2' },
  FAILED: { label_key: 'status.failed', tone: 'danger', icon: 'XCircle' },
  EXPIRED: { label_key: 'status.expired', tone: 'neutral', icon: 'Clock' },
  CANCELLED: { label_key: 'status.cancelled', tone: 'neutral', icon: 'XCircle' },
};

const KNOWLEDGE_STATUS: Readonly<Record<string, StatusDefinition>> = {
  DRAFT: { label_key: 'knowledge.state.draft', tone: 'neutral', icon: 'CircleDashed' },
  REVIEW: { label_key: 'knowledge.state.in_review', tone: 'info', icon: 'Clock' },
  IN_REVIEW: { label_key: 'knowledge.state.in_review', tone: 'info', icon: 'Clock' },
  APPROVED: { label_key: 'knowledge.state.approved', tone: 'success', icon: 'CheckCircle2' },
  AVAILABLE: { label_key: 'knowledge.state.available', tone: 'success', icon: 'CheckCircle2' },
  REJECTED: { label_key: 'status.rejected', tone: 'danger', icon: 'XCircle' },
  ARCHIVED: { label_key: 'knowledge.state.archived', tone: 'neutral', icon: 'Inbox' },
  EXPIRED: { label_key: 'status.expired', tone: 'neutral', icon: 'Clock' },
};

const SKILL_STATUS: Readonly<Record<string, StatusDefinition>> = {
  ENABLED: { label_key: 'skill.state.enabled', tone: 'success', icon: 'CheckCircle2' },
  ACTIVE: { label_key: 'status.active', tone: 'success', icon: 'CheckCircle2' },
  READY: { label_key: 'status.ready', tone: 'success', icon: 'CheckCircle2' },
  NOT_READY: { label_key: 'status.not_ready', tone: 'warning', icon: 'AlertTriangle' },
  INACTIVE: { label_key: 'skill.state.inactive', tone: 'neutral', icon: 'PauseCircle' },
  DISABLED: { label_key: 'status.disabled', tone: 'neutral', icon: 'PauseCircle' },
  DRAFT: { label_key: 'knowledge.state.draft', tone: 'neutral', icon: 'CircleDashed' },
  EXPERIMENTAL: { label_key: 'skill.state.experimental', tone: 'warning', icon: 'FlaskConical' },
  DEPRECATED: { label_key: 'skill.state.deprecated', tone: 'warning', icon: 'AlertTriangle' },
  DEGRADED: { label_key: 'status.degraded', tone: 'warning', icon: 'AlertTriangle' },
  UNAVAILABLE: { label_key: 'status.provider_unavailable', tone: 'danger', icon: 'CloudOff' },
  PROVIDER_UNAVAILABLE: { label_key: 'status.provider_unavailable', tone: 'danger', icon: 'CloudOff' },
  FAILED: { label_key: 'status.failed', tone: 'danger', icon: 'XCircle' },
};

const TENANT_STATUS: Readonly<Record<string, StatusDefinition>> = {
  // PLAN §7.14: a provisioned shell reads "Chưa cấu hình" until the company configures it (T8.2).
  PROVISIONED: { label_key: 'status.not_configured', tone: 'info', icon: 'Plug' },
  ACTIVE: { label_key: 'status.active', tone: 'success', icon: 'CheckCircle2' },
  SUSPENDED: { label_key: 'tenant.state.suspended', tone: 'warning', icon: 'PauseCircle' },
  ARCHIVED: { label_key: 'tenant.state.archived', tone: 'neutral', icon: 'Inbox' },
  PENDING: { label_key: 'tenant.state.pending', tone: 'info', icon: 'Clock' },
  DELETED: { label_key: 'tenant.state.deleted', tone: 'danger', icon: 'XCircle' },
};

const COMPANY_USER_STATUS: Readonly<Record<string, StatusDefinition>> = {
  INVITED: { label_key: 'settings.users.status.invited', tone: 'info', icon: 'Clock' },
  ACTIVE: { label_key: 'settings.users.status.active', tone: 'success', icon: 'CheckCircle2' },
  DEACTIVATED: { label_key: 'settings.users.status.deactivated', tone: 'neutral', icon: 'PauseCircle' },
};

const OWNER_INPUT_STATUS: Readonly<Record<string, StatusDefinition>> = {
  UNRESOLVED: { label_key: 'owner_input.state.unresolved', tone: 'warning', icon: 'AlertTriangle' },
  REQUIRED: { label_key: 'owner_input.state.required', tone: 'warning', icon: 'AlertTriangle' },
  OPEN: { label_key: 'owner_input.state.unresolved', tone: 'warning', icon: 'AlertTriangle' },
  RESOLVED: { label_key: 'owner_input.state.resolved', tone: 'success', icon: 'CheckCircle2' },
  CONFIGURED: { label_key: 'owner_input.state.configured', tone: 'success', icon: 'CheckCircle2' },
};

const DATA_CLASS: Readonly<Record<string, StatusDefinition>> = {
  PRODUCTION: { label_key: 'data_class.production', tone: 'success', icon: 'CheckCircle2' },
  DEMO: { label_key: 'data_class.demo', tone: 'demo', icon: 'FlaskConical' },
  TEST: { label_key: 'data_class.test', tone: 'demo', icon: 'FlaskConical' },
};

const DOMAIN_TABLES: Readonly<Record<StatusDomain, Readonly<Record<string, StatusDefinition>>>> = {
  provider: PROVIDER_STATUS,
  agent: AGENT_STATUS,
  connector: CONNECTOR_STATUS,
  probe: PROBE_STATUS,
  run: RUN_STATUS,
  campaign: CAMPAIGN_STATUS,
  approval: APPROVAL_STATUS,
  conversation: CONVERSATION_STATUS,
  handoff: HANDOFF_STATUS,
  knowledge: KNOWLEDGE_STATUS,
  skill: SKILL_STATUS,
  tenant: TENANT_STATUS,
  owner_input: OWNER_INPUT_STATUS,
  data_class: DATA_CLASS,
  company_user: COMPANY_USER_STATUS,
};

function unknownView(code: string, domain: StatusDomain | null): StatusView {
  return { code, domain, label_key: UNKNOWN_KEY, tone: 'neutral', icon: 'HelpCircle' };
}

function contextualRunDefinition(
  domain: StatusDomain,
  code: string,
  context?: StatusViewContext,
): StatusDefinition | undefined {
  if (domain !== 'run') return undefined;
  if (
    (code === 'WAITING' || code === 'waiting')
    && (context?.effectStatus === 'RESERVED' || context?.effectStatus === 'UNKNOWN')
  ) {
    return RUN_STATUS.NEEDS_RECONCILIATION;
  }
  if (
    (code === 'AWAITING_HUMAN' || code === 'awaiting_human')
    && context?.awaitingHuman === 'approval'
  ) {
    return RUN_STATUS.AWAITING_HUMAN_APPROVAL;
  }
  if (
    (code === 'AWAITING_HUMAN' || code === 'awaiting_human')
    && context?.awaitingHuman === 'handoff'
  ) {
    return HANDOFF_STATUS.HUMAN_HANDOFF;
  }
  return undefined;
}
/** Domain-scoped lookup: `statusView('approval', 'EXPIRED')`. */
export function statusView(domain: StatusDomain, code: string, context?: StatusViewContext): StatusView;
/** Legacy lookup: resolves `code` against every domain table, keeping existing callers working. */
export function statusView(code: string): StatusView;
export function statusView(
  domainOrCode: StatusDomain | string,
  maybeCode?: string,
  context?: StatusViewContext,
): StatusView {
  if (maybeCode === undefined) {
    const code = domainOrCode;
    for (const domain of STATUS_DOMAINS) {
      const definition = DOMAIN_TABLES[domain][code];
      if (definition !== undefined) return { code, domain, ...definition };
    }
    return unknownView(code, null);
  }
  const domain = domainOrCode as StatusDomain;
  const table = DOMAIN_TABLES[domain];
  const contextualDefinition = contextualRunDefinition(domain, maybeCode, context);
  const definition = contextualDefinition ?? table?.[maybeCode];
  return definition === undefined ? unknownView(maybeCode, domain) : { code: maybeCode, domain, ...definition };
}

const CHANNEL_LABEL_KEYS: Readonly<Record<string, string>> = {
  WEB_CHAT: 'channel.web_chat',
  WEB: 'channel.web_chat',
  EMAIL: 'channel.email',
  SMS: 'channel.sms',
  PHONE: 'channel.phone',
  ZALO: 'channel.zalo',
  MESSENGER: 'channel.messenger',
  WHATSAPP: 'channel.whatsapp',
  LINE: 'channel.line',
  INSTAGRAM: 'channel.instagram',
  TIKTOK: 'channel.tiktok',
  POS: 'channel.pos',
};

/** I18n key for a customer channel code; unknown codes get a neutral label, never the raw code. */
export function channelLabelKey(code: string): string {
  return CHANNEL_LABEL_KEYS[code.trim().toUpperCase()] ?? 'channel.other';
}
