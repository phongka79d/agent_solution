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

  it('allows representative endpoints only for their declared method', () => {
    const allowed: readonly [string, string][] = [
      ['company/overview', 'GET'],
      ['company/attention', 'GET'],
      ['company/ai-team', 'GET'],
      ['company/ai-team/sales', 'GET'],
      ['company/ai-team/sales/activate', 'POST'],
      ['company/ai-team/sales/pause', 'POST'],
      ['company/ai-team/sales/resume', 'POST'],
      ['skills', 'GET'],
      ['skills/s-1', 'GET'],
      ['skills/s-1/health', 'GET'],
      ['skills/s-1/settings', 'PATCH'],
      ['skills/s-1/agents', 'PUT'],
      ['skills/s-1/test', 'POST'],
      ['company/activity', 'GET'],
      ['company/integrations', 'GET'],
      ['company/integrations/API-001', 'PUT'],
      ['company/integrations/API-001/test', 'POST'],
      ['company/integrations/API-001/disconnect', 'POST'],
      ['company/settings/governance', 'GET'],
      ['company/owner-inputs', 'GET'],
      ['company/owner-inputs/careOnboardingItinerary/resolve', 'POST'],
      ['company/audit', 'GET'],
      ['customers', 'GET'],
      ['customers/c-1/profile', 'GET'],
      ['customers/c-1/timeline', 'GET'],
      ['campaigns', 'GET'],
      ['campaigns/segments', 'GET'],
      ['campaigns/run-1', 'GET'],
      ['campaigns/drafts', 'POST'],
      ['approvals', 'GET'],
      ['approvals/a-1', 'GET'],
      ['approvals/a-1/decision', 'POST'],
      ['conversations/c-1/summary', 'GET'],
      ['conversations/c-1/takeover', 'POST'],
      ['conversations/c-1/takeover/heartbeat', 'POST'],
      ['conversations/c-1/resume', 'POST'],
      ['conversations/c-1/operator-messages', 'POST'],
      ['runs/run-1/story', 'GET'],
      ['runs/run-1/trace', 'GET'],
      ['demo/catalog', 'GET'],
      ['demo/widget-session', 'POST'],
      ['conversations', 'GET'],
      ['conversations/c-1/messages', 'GET'],
    ];
    for (const [path, method] of allowed) {
      expect(isAllowedPath(path, method), `${method} ${path}`).toBe(true);
      expect(isAllowedPath(path, method === 'GET' ? 'POST' : 'GET'), `wrong method for ${path}`).toBe(false);
    }
    expect(isAllowedPath('company/users', 'GET')).toBe(true);
    expect(isAllowedPath('company/users', 'POST')).toBe(true);
    expect(isAllowedPath('company/users', 'PATCH')).toBe(true);
    expect(isAllowedPath('company/users', 'DELETE')).toBe(false);
    expect(isAllowedPath('storefront/stream', 'POST')).toBe(false);
    expect(isAllowedPath('storefront/events', 'POST')).toBe(false);
    expect(isAllowedPath('telemetry/kpi', 'GET')).toBe(false);
    expect(isAllowedPath('telemetry/kpi-snapshot', 'GET')).toBe(false);
    expect(isAllowedPath('telemetry/stream', 'GET')).toBe(false);
    expect(isAllowedPath('conversations/c-1', 'GET')).toBe(false);
  });

  it('requires the method to match each endpoint rule', () => {
    expect(isAllowedPath('company/attention', 'GET')).toBe(true);
    expect(isAllowedPath('company/attention', 'POST')).toBe(false);
    expect(isAllowedPath('campaigns/drafts', 'POST')).toBe(true);
    expect(isAllowedPath('campaigns/drafts', 'GET')).toBe(false);
    expect(isAllowedPath('approvals/a-1/decision', 'GET')).toBe(false);
    expect(isAllowedPath('approvals/a-1/decision', 'POST')).toBe(true);
  });

  it('allows knowledge document routes by HTTP method', () => {
    const id = '9a2f7ed4-1fe4-4f8c-8d63-008450000010';
    expect(isAllowedPath('knowledge/documents', 'GET')).toBe(true);
    expect(isAllowedPath(`knowledge/documents/${id}`, 'GET')).toBe(true);
    expect(isAllowedPath(`knowledge/documents/${id}/versions`, 'GET')).toBe(true);
    expect(isAllowedPath(`knowledge/documents/${id}/usage`, 'GET')).toBe(true);
    expect(isAllowedPath('knowledge/documents', 'POST')).toBe(true);
    expect(isAllowedPath(`knowledge/documents/${id}`, 'PUT')).toBe(true);
    for (const action of ['submit', 'approve', 'reject', 'archive']) {
      expect(isAllowedPath(`knowledge/documents/${id}/${action}`, 'POST')).toBe(true);
    }
    expect(isAllowedPath(`knowledge/documents/${id}/approve`, 'GET')).toBe(false);
    expect(isAllowedPath(`knowledge/documents/${id}`, 'DELETE')).toBe(false);
  });
});
