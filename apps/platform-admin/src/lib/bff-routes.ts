import type { Permission } from '@agentos/ui-foundation/auth';

export type BffMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface BffRoutePattern {
  /** Path suffix under /api/v1, kept in OpenAPI template form for contract tests. */
  readonly template: string;
  /** Concrete path matcher; parameters remain constrained as in the previous proxy allowlist. */
  readonly matcher: RegExp;
}

export interface BffRoute {
  readonly method: BffMethod;
  readonly pattern: BffRoutePattern;
  /** No extra route-level permission is checked by this proxy; the API validates the platform session. */
  readonly permission: Permission | null;
  readonly csrf: boolean;
}

const PLATFORM_PARAMETER = '[A-Za-z0-9._:-]+';
const PROVIDER_PARAMETER = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}';

function routePattern(template: string, parameter = PLATFORM_PARAMETER): BffRoutePattern {
  const expression = template.split('/').map((segment) => {
    if (segment.startsWith('{') && segment.endsWith('}')) return parameter;
    return segment;
  }).join('/');
  return { template, matcher: new RegExp(`^${expression}$`) };
}

function route(method: BffMethod, template: string, parameter = PLATFORM_PARAMETER): BffRoute {
  return {
    method,
    pattern: routePattern(template, parameter),
    permission: null,
    csrf: method !== 'GET',
  };
}

/** The platform BFF's complete API proxy surface; API permission checks remain unchanged. */
export const PLATFORM_BFF_ROUTES: readonly BffRoute[] = [
  route('GET', 'runs'),
  route('GET', 'demo/readiness'),
  route('GET', 'platform/tenants'),
  route('GET', 'platform/usage'),
  route('GET', 'platform/health'),
  route('GET', 'platform/providers'),
  route('GET', 'platform/audit'),
  route('GET', 'platform/skill-catalog'),
  route('GET', 'platform/companies'),
  route('GET', 'platform/companies/{id}/overview'),
  route('GET', 'platform/admins'),
  route('GET', 'platform/runs'),
  route('GET', 'platform/runs/summary'),
  route('GET', 'platform/runs/reconciliation'),
  route('GET', 'admin/tenants/current'),
  route('GET', 'admin/autonomy'),
  route('GET', 'platform/tenants/{id}'),
  route('GET', 'platform/tenants/{id}/readiness'),
  route('GET', 'platform/companies/{id}/users'),
  route('GET', 'platform/companies/{id}/autonomy'),
  route('GET', 'platform/companies/{id}/runs/{runId}'),
  route('GET', 'platform/companies/{id}/runs/{runId}/trace'),
  route('GET', 'runs/{run_id}/trace'),

  route('POST', 'auth/password'),
  route('POST', 'admin/autonomy/pause'),
  route('POST', 'admin/autonomy/resume'),
  route('POST', 'admin/autonomy/demote'),
  route('POST', 'provisioning/tenants'),
  route('POST', 'platform/admins'),
  route('POST', 'platform/companies/{id}/invitations'),
  route('POST', 'platform/companies/{id}/suspend'),
  route('POST', 'platform/companies/{id}/resume'),
  route('POST', 'platform/companies/{id}/autonomy/pause'),
  route('POST', 'platform/companies/{id}/autonomy/resume'),
  route('POST', 'platform/companies/{id}/autonomy/demote'),
  route('POST', 'platform/companies/{id}/users/{userId}/deactivate'),
  route('POST', 'operations/runs/{run_id}/retry'),
  route('POST', 'platform/companies/{id}/runs/{runId}/retry'),
  route('POST', 'platform/companies/{id}/runs/{runId}/reconcile'),
  route('POST', 'platform/providers/{id}/test', PROVIDER_PARAMETER),

  route('PUT', 'platform/providers/{id}', PROVIDER_PARAMETER),
  route('PUT', 'platform/skill-catalog/{id}/entitlement/{tenant_id}'),
];

export function findPlatformBffRoute(method: string, path: string): BffRoute | undefined {
  const upperMethod = method.toUpperCase();
  return PLATFORM_BFF_ROUTES.find((entry) => entry.method === upperMethod && entry.pattern.matcher.test(path));
}
