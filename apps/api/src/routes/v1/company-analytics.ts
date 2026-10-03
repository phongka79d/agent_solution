import type { FastifyInstance } from 'fastify';

import {
  COMPANY_ANALYTICS_WINDOWS,
  CompanyAnalyticsRepository,
  type CompanyAnalyticsSnapshot,
  type CompanyAnalyticsWindow,
} from '@agentos/database';

import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';

const OPERATION = 'GET /api/v1/company/analytics';

/** Milliseconds per selectable period; a literal table keeps the window closed and auditable. */
const WINDOW_MS: Record<CompanyAnalyticsWindow, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function windowField(value: unknown): CompanyAnalyticsWindow {
  if (value === undefined || value === null || value === '') return '24h';
  if (typeof value !== 'string' || !(COMPANY_ANALYTICS_WINDOWS as readonly string[]).includes(value)) {
    fail('VALIDATION_FAILED', 'window must be one of 24h, 7d, 30d');
  }
  return value as CompanyAnalyticsWindow;
}

/**
 * Registers the company analytics read endpoint. The window is resolved against the injected
 * clock so the whole snapshot shares one `as_of`, and the repository stays tenant-scoped.
 */
export function registerCompanyAnalyticsRoutes(
  app: FastifyInstance,
  deps: {
    readonly runtime: GatewayRuntime;
    readonly credentials: CredentialStore;
    /** Test seam; production resolves the tenant-bound repository with the default RLS runner. */
    readonly analytics?: Pick<CompanyAnalyticsRepository, 'snapshot'>;
  },
): void {
  const repository = deps.analytics ?? new CompanyAnalyticsRepository();

  app.get(
    '/company/analytics',
    {
      preHandler: authenticate(deps),
      schema: {
        tags: ['Company analytics'],
        summary: 'Get company analytics for a window',
      },
    },
    async (request, reply) => {
      const runtime = deps.runtime;
      try {
        const principal = requireOperator(request, 'telemetry:read');
        const window = windowField((request.query as Record<string, unknown> | undefined)?.['window']);
        const until = runtime.clock();
        const since = new Date(until.getTime() - WINDOW_MS[window]);

        const snapshot: CompanyAnalyticsSnapshot = await repository.snapshot({
          tenant_id: principal.tenant_id,
          window,
          since,
          until,
        });

        await runtime.audit.record({
          tenant_id: principal.tenant_id,
          correlation_id: correlationIdOf(request, runtime),
          operation: OPERATION,
          principal_kind: principal.kind,
          outcome: 'ACCEPTED',
          ...(principal.operator_id !== undefined ? { operator_id: principal.operator_id } : {}),
          detail: { window, kpi_count: snapshot.kpis.length, as_of: snapshot.as_of },
        });

        return reply.code(200).send(snapshot);
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, runtime));
      }
    },
  );
}
