import { describe, expect, it } from 'vitest';

import { t } from './i18n/index.js';
import { STATUS_DOMAINS, statusView, type StatusDomain } from './status-view.js';

describe('statusView (legacy single-argument form)', () => {
  it.each([
    ['ACTIVE', 'status.active', 'success', 'CheckCircle2'],
    ['LIVE', 'company.integrations.live', 'success', 'CheckCircle2'],
    ['ATTENTION', 'status.attention', 'warning', 'AlertTriangle'],
    ['APPROVAL_PENDING', 'status.approval_pending', 'info', 'Clock'],
    ['NOT_CONFIGURED', 'status.not_configured', 'neutral', 'Plug'],
    ['UNBOUND', 'status.not_configured', 'neutral', 'Plug'],
    ['PAUSED', 'status.paused', 'neutral', 'PauseCircle'],
    ['paused_takeover', 'conversation.ownership.paused_orphan', 'neutral', 'PauseCircle'],
    ['FAILED', 'status.failed', 'danger', 'XCircle'],
    ['AI_ACTIVE', 'conversation.ownership.ai_active', 'ai', 'CircleDashed'],
    ['CLOSED', 'conversation.ownership.closed', 'neutral', 'XCircle'],
    ['open', 'conversation.state.open', 'success', 'CheckCircle2'],
    ['DEMO_MOCK', 'company.integrations.demo_mock', 'demo', 'FlaskConical'],
    ['NOT_RUN', 'status.not_run', 'neutral', 'CircleDashed'],
    ['DEGRADED', 'status.degraded', 'warning', 'AlertTriangle'],
  ] as const)('resolves %s without a domain', (code, label_key, tone, icon) => {
    if (label_key === undefined) {
      expect(statusView(code).label_key).toBe('status.unknown');
      return;
    }
    const view = statusView(code);
    expect(view.label_key).toBe(label_key);
    expect(view.tone).toBe(tone);
    expect(view.icon).toBe(icon);
    expect(view.code).toBe(code);
    expect(view.domain).not.toBeNull();
  });

  it('localizes the conversation vocabulary for the Vietnamese console', () => {
    expect(t(statusView('NEEDS_HUMAN').label_key)).toBe('Khách yêu cầu nhân viên');
    expect(t(statusView('HUMAN_ME').label_key)).toBe('Bạn đang phụ trách');
    expect(t(statusView('HUMAN_OTHER').label_key, { name: 'Lan' })).toBe('Lan đang phụ trách');
    expect(t(statusView('PAUSED_ORPHAN').label_key)).toBe('AI tạm dừng, chưa có nhân viên');
  });
});

describe('statusView(domain, code)', () => {
  it.each([
    ['agent', 'DISABLED', 'status.disabled', 'neutral', 'PauseCircle'],
    ['connector', 'LIVE', 'company.integrations.live', 'success', 'CheckCircle2'],
    ['connector', 'DEGRADED', 'status.degraded', 'warning', 'AlertTriangle'],
    ['probe', 'TIMEOUT', 'status.timeout', 'danger', 'Clock'],
    ['probe', 'NOT_RUN', 'status.not_run', 'neutral', 'CircleDashed'],
    ['probe', 'DEGRADED', 'status.degraded', 'warning', 'AlertTriangle'],
    ['provider', 'VERIFIED', 'status.verified', 'success', 'CheckCircle2'],
    ['run', 'RUNNING', 'status.running', 'info', 'CircleDashed'],
    ['run', 'accepted', 'status.accepted', 'info', 'Clock'],
    ['run', 'in_flight', 'status.running', 'info', 'CircleDashed'],
    ['campaign', 'AWAITING_APPROVAL', 'campaigns.lifecycle.awaiting_approval', 'info', 'Clock'],
    ['approval', 'EXPIRED', 'status.expired', 'neutral', 'Clock'],
    ['conversation', 'NEEDS_HUMAN', 'conversation.ownership.needs_human', 'warning', 'LifeBuoy'],
    ['handoff', 'COMPLETED', 'handoff.state.completed', 'success', 'CheckCircle2'],
    ['knowledge', 'APPROVED', 'knowledge.state.approved', 'success', 'CheckCircle2'],
    ['skill', 'EXPERIMENTAL', 'skill.state.experimental', 'warning', 'FlaskConical'],
    ['skill', 'DEGRADED', 'status.degraded', 'warning', 'AlertTriangle'],
    ['tenant', 'SUSPENDED', 'tenant.state.suspended', 'warning', 'PauseCircle'],
    ['owner_input', 'UNRESOLVED', 'owner_input.state.unresolved', 'warning', 'AlertTriangle'],
    ['company_user', 'INVITED', 'settings.users.status.invited', 'info', 'Clock'],
    ['company_user', 'ACTIVE', 'settings.users.status.active', 'success', 'CheckCircle2'],
    ['company_user', 'DEACTIVATED', 'settings.users.status.deactivated', 'neutral', 'PauseCircle'],
    ['data_class', 'PRODUCTION', 'data_class.production', 'success', 'CheckCircle2'],
    ['data_class', 'DEMO', 'data_class.demo', 'demo', 'FlaskConical'],
    ['data_class', 'TEST', 'data_class.test', 'demo', 'FlaskConical'],
  ] as const)('maps %s/%s to its catalog view', (domain, code, label_key, tone, icon) => {
    expect(statusView(domain, code)).toEqual({ code, domain, label_key, tone, icon });
  });
  it('localizes probe states that need a more specific label', () => {
    expect(t(statusView('probe', 'NOT_RUN').label_key)).toBe('Chưa kiểm tra');
    expect(t(statusView('probe', 'DEGRADED').label_key)).toBe('Suy giảm');
  });
  it('uses run context to distinguish reconciliation, approvals, and handoffs', () => {
    expect(t(statusView('run', 'WAITING', { effectStatus: 'RESERVED' }).label_key)).toBe('Cần đối soát');
    expect(t(statusView('run', 'waiting', { effectStatus: 'UNKNOWN' }).label_key)).toBe('Cần đối soát');
    expect(t(statusView('run', 'WAITING').label_key)).toBe('Đang chờ');
    expect(t(statusView('run', 'waiting_reconcile').label_key)).toBe('Cần đối soát');
    expect(t(statusView('run', 'awaiting_human', { awaitingHuman: 'approval' }).label_key)).toBe('Chờ phê duyệt');
    expect(t(statusView('run', 'AWAITING_HUMAN', { awaitingHuman: 'handoff' }).label_key)).toBe('Cần nhân viên hỗ trợ');
  });

  it('keeps the same raw code distinct across domains', () => {
    expect(statusView('approval', 'CANCELLED').label_key).toBe('status.cancelled');
    expect(statusView('campaign', 'CANCELLED').label_key).toBe('status.cancelled');
    expect(statusView('approval', 'PENDING').label_key).toBe('status.approval_pending');
    expect(statusView('run', 'CANCELLED').tone).toBe('neutral');
  });

  it('has a localized table entry for every declared domain', () => {
    for (const domain of STATUS_DOMAINS) {
      const codes: Record<StatusDomain, string> = {
        agent: 'ACTIVE',
        connector: 'LIVE',
        probe: 'FAILED',
        provider: 'VERIFIED',
        run: 'COMPLETED',
        campaign: 'DRAFT',
        approval: 'PENDING',
        conversation: 'AI_ACTIVE',
        handoff: 'REQUESTED',
        knowledge: 'DRAFT',
        skill: 'ENABLED',
        tenant: 'PROVISIONED',
        owner_input: 'UNRESOLVED',
        company_user: 'INVITED',
        data_class: 'PRODUCTION',
      };
      const view = statusView(domain, codes[domain]);
      expect(view.label_key).not.toBe('status.unknown');
      expect(t(view.label_key)).not.toBe(view.label_key);
    }
  });

  it('returns the localized unknown view for an unmapped code and keeps the raw code', () => {
    expect(statusView('probe', 'FUTURE_PROBE')).toEqual({
      code: 'FUTURE_PROBE',
      domain: 'probe',
      label_key: 'status.unknown',
      tone: 'neutral',
      icon: 'HelpCircle',
    });
    expect(t('status.unknown')).toBe('Không xác định');
  });

  it('returns the unknown view without a domain for a lone unmapped code', () => {
    expect(statusView('FUTURE_STATUS')).toEqual({
      code: 'FUTURE_STATUS',
      domain: null,
      label_key: 'status.unknown',
      tone: 'neutral',
      icon: 'HelpCircle',
    });
  });
});
