import { describe, expect, it } from 'vitest';
import { isAllowedPath, routePath } from './bff-allowlist';

describe('tenant BFF allowlist', () => {
  it('rejects encoded traversal and encoded separators after one decode', () => {
    expect(routePath(['customers', '%2e%2e'])).toBeUndefined();
    expect(routePath(['customers', '%2Fetc'])).toBeUndefined();
    expect(routePath(['customers', '%5Cetc'])).toBeUndefined();
    expect(routePath(['customers', '%252Fetc'])).toBeUndefined();
    expect(routePath(['customers', '%252e%252e'])).toBeUndefined();
    expect(routePath(['customers', 'a..b'])).toBeUndefined();
  });

  it('allows every M6 endpoint only for its declared method', () => {
    const allowed: readonly [string, string][] = [
      ['company/overview', 'GET'],
      ['company/attention', 'GET'],
      ['company/ai-team', 'GET'],
      ['company/activity', 'GET'],
      ['company/integrations', 'GET'],
      ['company/settings/governance', 'GET'],
      ['customers', 'GET'],
      ['customers/c-1/profile', 'GET'],
      ['customers/c-1/timeline', 'GET'],
      ['campaigns', 'GET'],
      ['campaigns/run-1', 'GET'],
      ['campaigns/drafts', 'POST'],
      ['approvals', 'GET'],
      ['approvals/a-1', 'GET'],
      ['approvals/a-1/decision', 'POST'],
      ['conversations', 'GET'],
      ['conversations/c-1/messages', 'GET'],
      ['conversations/c-1/summary', 'GET'],
      ['conversations/c-1/takeover', 'POST'],
      ['conversations/c-1/takeover/heartbeat', 'POST'],
      ['conversations/c-1/resume', 'POST'],
      ['conversations/c-1/operator-messages', 'POST'],
      ['runs/run-1/trace', 'GET'],
      ['demo/widget-session', 'POST'],
      ['demo/catalog', 'GET'],
      ['storefront/stream', 'POST'],
      ['storefront/events', 'POST'],
      ['telemetry/kpi', 'GET'],
      ['telemetry/kpi-snapshot', 'GET'],
      ['telemetry/stream', 'GET'],
    ];
    for (const [path, method] of allowed) {
      expect(isAllowedPath(path, method), `${method} ${path}`).toBe(true);
      expect(isAllowedPath(path, method === 'GET' ? 'POST' : 'GET'), `wrong method for ${path}`).toBe(false);
    }
  });

  it('requires the method to match each endpoint rule', () => {
    expect(isAllowedPath('company/attention', 'GET')).toBe(true);
    expect(isAllowedPath('company/attention', 'POST')).toBe(false);
    expect(isAllowedPath('campaigns/drafts', 'POST')).toBe(true);
    expect(isAllowedPath('campaigns/drafts', 'GET')).toBe(false);
    expect(isAllowedPath('approvals/a-1/decision', 'GET')).toBe(false);
    expect(isAllowedPath('approvals/a-1/decision', 'POST')).toBe(true);
  });
});
