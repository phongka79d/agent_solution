import type { FastifyInstance } from 'fastify';

import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';

import { companyGovernanceRouteSchema, registerOpenApiSchemas } from './openapi-schemas.js';

export function registerCompanySettingsRoutes(
  app: FastifyInstance,
  deps: { readonly runtime: GatewayRuntime; readonly credentials: CredentialStore },
): void {
  registerOpenApiSchemas(app);
  const preHandler = authenticate(deps);

  app.get('/company/settings/governance', { preHandler, schema: companyGovernanceRouteSchema }, async (request, reply) => {
    const runtime = deps.runtime;
    const correlation_id = correlationIdOf(request, runtime);

    try {
      const principal = requireOperator(request, 'approval:read');
      const governance = runtime.governance;
      if (governance === undefined) {
        fail('PROVIDER_TIMEOUT', 'governance settings could not be read');
      }

      let require_distinct_approver = false;
      try {
        const settings = await governance.get(principal.tenant_id);
        require_distinct_approver = settings.require_distinct_approver;
      } catch {
        fail('PROVIDER_TIMEOUT', 'governance settings could not be read');
      }

      await runtime.audit.record({
        tenant_id: principal.tenant_id,
        correlation_id,
        operation: 'company.settings.governance',
        principal_kind: principal.kind,
        ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
        outcome: 'ACCEPTED',
        detail: { require_distinct_approver },
      });

      return reply.code(200).send({ require_distinct_approver });
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });
}
