import { describe, expect, it } from 'vitest';

import { statusView } from './status-view.js';

describe('statusView', () => {
  it.each([
    ['ACTIVE', 'status.active', 'success', 'CheckCircle2'],
    ['LIVE', 'status.active', 'success', 'CheckCircle2'],
    ['ATTENTION', 'status.attention', 'warning', 'AlertTriangle'],
    ['APPROVAL_PENDING', 'status.approval_pending', 'info', 'Clock'],
    ['AWAITING_HUMAN_APPROVAL', 'status.approval_pending', 'info', 'Clock'],
    ['NOT_CONFIGURED', 'status.not_configured', 'neutral', 'Plug'],
    ['UNBOUND', 'status.not_configured', 'neutral', 'Plug'],
    ['UNCONFIGURED', 'status.not_configured', 'neutral', 'Plug'],
    ['NOT_INTEGRATED', 'status.not_integrated', 'neutral', 'CircleDashed'],
    ['NO_DATA', 'status.no_data', 'neutral', 'Inbox'],
    ['EMPTY', 'status.no_data', 'neutral', 'Inbox'],
    ['PAUSED', 'status.paused', 'neutral', 'PauseCircle'],
    ['paused_takeover', 'status.paused', 'neutral', 'PauseCircle'],
    ['FAILED', 'status.failed', 'danger', 'XCircle'],
    ['ERROR', 'status.failed', 'danger', 'XCircle'],
    ['HUMAN_HANDOFF', 'status.human_handoff', 'warning', 'LifeBuoy'],
    ['HUMAN_TAKEOVER', 'status.human_handoff', 'warning', 'LifeBuoy'],
    ['OPEN', 'status.active', 'success', 'CheckCircle2'],
    ['CLOSED', 'status.paused', 'neutral', 'PauseCircle'],
    ['PROVIDER_UNAVAILABLE', 'status.provider_unavailable', 'danger', 'CloudOff'],
    ['DEMO_MOCK', 'status.demo', 'demo', 'FlaskConical'],
    ['SYNTHETIC', 'status.demo', 'demo', 'FlaskConical'],
  ] as const)('maps %s to its catalog view', (code, label_key, tone, icon) => {
    expect(statusView(code)).toEqual({ code, label_key, tone, icon });
  });

  it('normalizes lowercase or mixed-case status codes (B-72)', () => {
    expect(statusView('active')).toEqual({
      code: 'active',
      label_key: 'status.active',
      tone: 'success',
      icon: 'CheckCircle2',
    });
    expect(statusView('closed')).toEqual({
      code: 'closed',
      label_key: 'status.paused',
      tone: 'neutral',
      icon: 'PauseCircle',
    });
  });

  it('uses a neutral unknown view without losing the code', () => {
    expect(statusView('FUTURE_STATUS')).toEqual({
      code: 'FUTURE_STATUS',
      label_key: 'status.unknown',
      tone: 'neutral',
      icon: 'HelpCircle',
    });
  });
});
