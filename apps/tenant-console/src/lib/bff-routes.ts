import type { Permission } from '@agentos/ui-foundation/auth';

export type BffMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface BffRoutePattern {
  /** Path suffix under /api/v1, kept in OpenAPI template form for contract tests. */
  readonly template: string;
  /** Concrete path matcher; placeholders match exactly one non-empty segment. */
  readonly matcher: RegExp;
}

export interface BffRoute {
  readonly method: BffMethod;
  readonly pattern: BffRoutePattern;
  /** Additional permission checked by this BFF; API permissions remain authoritative otherwise. */
  readonly permission: Permission | null;
  readonly csrf: boolean;
}

function routePattern(template: string): BffRoutePattern {
  const expression = template.split('/').map((segment) => {
    if (segment.startsWith('{') && segment.endsWith('}')) return '[^/]+';
    return segment;
  }).join('/');
  return { template, matcher: new RegExp(`^${expression}$`) };
}

function route(method: BffMethod, template: string, permission: Permission | null = null): BffRoute {
  return {
    method,
    pattern: routePattern(template),
    permission,
    csrf: method !== 'GET',
  };
}

/** The tenant BFF's complete API proxy surface. Route templates intentionally mirror OpenAPI suffixes. */
export const TENANT_BFF_ROUTES: readonly BffRoute[] = [
  route('GET', 'company/overview'),
  route('GET', 'company/attention'),
  route('GET', 'company/activity'),
  route('GET', 'company/integrations'),
  route('GET', 'company/ai-team'),
  route('GET', 'company/ai-team/{domain}'),
  route('GET', 'company/users'),
  route('GET', 'company/owner-inputs'),
  route('GET', 'company/settings/profile'),
  route('GET', 'company/settings/governance'),
  route('GET', 'company/settings/llm'),
  route('GET', 'company/audit'),
  route('GET', 'company/analytics'),
  route('GET', 'customers'),
  route('GET', 'customers/{customer_id}/profile'),
  route('GET', 'customers/{customer_id}/timeline'),
  route('GET', 'campaigns'),
  route('GET', 'campaigns/segments'),
  route('GET', 'campaigns/{runId}'),
  route('GET', 'approvals'),
  route('GET', 'approvals/{approval_id}'),
  route('GET', 'conversations'),
  route('GET', 'conversations/{conversation_id}/messages'),
  route('GET', 'conversations/{id}/summary'),
  route('GET', 'runs/{run_id}/story'),
  route('GET', 'runs/{run_id}/trace'),
  route('GET', 'demo/catalog'),
  route('GET', 'knowledge/documents'),
  route('GET', 'knowledge/documents/{id}'),
  route('GET', 'knowledge/documents/{id}/versions'),
  route('GET', 'knowledge/documents/{id}/usage'),
  route('GET', 'skills'),
  route('GET', 'skills/{id}'),
  route('GET', 'skills/{id}/health'),
  route('GET', 'testing/status'),
  route('GET', 'testing/customers'),
  route('GET', 'testing/customers/{id}'),

  route('POST', 'demo/widget-session', 'conversation:takeover'),
  route('POST', 'campaigns/drafts'),
  route('POST', 'approvals/{approval_id}/decision'),
  route('POST', 'knowledge/documents'),
  route('POST', 'knowledge/documents/{id}/submit'),
  route('POST', 'knowledge/documents/{id}/approve'),
  route('POST', 'knowledge/documents/{id}/reject'),
  route('POST', 'knowledge/documents/{id}/archive'),
  route('POST', 'conversations/{conversation_id}/takeover'),
  route('POST', 'conversations/{conversation_id}/takeover/heartbeat'),
  route('POST', 'conversations/{conversation_id}/resume'),
  route('POST', 'conversations/{conversation_id}/operator-messages'),
  route('POST', 'company/integrations/{id}/test'),
  route('POST', 'company/integrations/{id}/disconnect'),
  route('POST', 'company/users'),
  route('POST', 'company/settings/llm/test'),
  route('POST', 'company/owner-inputs/{id}/resolve'),
  route('POST', 'company/ai-team/{domain}/activate'),
  route('POST', 'company/ai-team/{domain}/pause'),
  route('POST', 'company/ai-team/{domain}/resume'),
  route('POST', 'testing/customers'),
  route('POST', 'testing/reset'),
  route('POST', 'skills/{id}/test'),
  route('POST', 'testing/customers/{id}/events'),
  route('POST', 'testing/customers/{id}/orders'),
  route('POST', 'testing/customers/{id}/consent'),
  route('POST', 'testing/customers/{id}/support-requests'),
  route('POST', 'testing/customers/{id}/handoff-request'),
  route('POST', 'testing/customers/{id}/widget-session'),

  route('DELETE', 'testing/customers/{id}'),

  route('PUT', 'knowledge/documents/{id}'),
  route('PUT', 'company/integrations/{id}'),
  route('PUT', 'company/settings/profile'),
  route('PUT', 'company/settings/governance'),
  route('PUT', 'company/settings/llm'),
  route('PUT', 'skills/{id}/agents'),

  route('PATCH', 'company/users'),
  route('PATCH', 'skills/{id}/settings'),
];

/** Resolve exact templates before parameterized templates (e.g. POST campaigns/drafts vs GET campaigns/{runId}). */
export function findTenantBffRoute(path: string, method: string): BffRoute | undefined {
  const upperMethod = method.toUpperCase();
  let exactPathFound = false;
  for (const entry of TENANT_BFF_ROUTES) {
    if (entry.pattern.template !== path) continue;
    exactPathFound = true;
    if (entry.method === upperMethod) return entry;
  }
  if (exactPathFound) return undefined;
  return TENANT_BFF_ROUTES.find((entry) => entry.method === upperMethod && entry.pattern.matcher.test(path));
}
