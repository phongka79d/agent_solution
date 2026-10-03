import type { FastifyInstance } from 'fastify';

import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime, GovernanceSettings } from '../../gateway/ports.js';

import {
  companyGovernancePutRouteSchema,
  companyGovernanceRouteSchema,
  registerOpenApiSchemas,
} from './openapi-schemas.js';

interface GovernanceUpdateBody {
  readonly require_distinct_approver: boolean;
  readonly approval_expiry_hours: number;
  readonly takeover_lease_seconds: number;
}

function settingsResponse(settings: GovernanceSettings) {
  return {
    require_distinct_approver: settings.require_distinct_approver,
    approval_expiry_hours: settings.approval_expiry_hours,
    takeover_lease_seconds: settings.takeover_lease_seconds,
    version: settings.version,
    updated_at: settings.updated_at,
  };
}

function expectedVersion(value: string | undefined): number {
  if (value === undefined) fail('VALIDATION_FAILED', 'If-Match is required');
  const match = /^(?:"([1-9][0-9]*)"|([1-9][0-9]*))$/.exec(value.trim());
  const version = Number(match?.[1] ?? match?.[2]);
  if (match === null || !Number.isSafeInteger(version) || version < 1) {
    fail('VALIDATION_FAILED', 'If-Match must contain a positive settings version');
  }
  return version;
}

export function registerCompanySettingsRoutes(
  app: FastifyInstance,
  deps: { readonly runtime: GatewayRuntime; readonly credentials: CredentialStore },
): void {
  registerOpenApiSchemas(app);
  const preHandler = authenticate(deps);

  app.get('/company/settings/governance', { preHandler, schema: companyGovernanceRouteSchema }, async (request, reply) => {
    const runtime = deps.runtime;
    try {
      const principal = requireOperator(request, 'approval:read');
      const governance = runtime.governance;
      if (governance === undefined) fail('PROVIDER_TIMEOUT', 'governance settings could not be read');

      let settings: GovernanceSettings;
      try {
        settings = await governance.get(principal.tenant_id);
      } catch {
        fail('PROVIDER_TIMEOUT', 'governance settings could not be read');
      }

      await runtime.audit.record({
        tenant_id: principal.tenant_id,
        correlation_id: correlationIdOf(request, runtime),
        operation: 'company.settings.governance',
        principal_kind: principal.kind,
        ...(principal.operator_id === undefined ? {} : { operator_id: principal.operator_id }),
        outcome: 'ACCEPTED',
        detail: settingsResponse(settings),
      });

      return reply.code(200).header('ETag', `"${settings.version}"`).send(settingsResponse(settings));
    } catch (error) {
      return replyFailure(reply, error, correlationIdOf(request, runtime));
    }
  });

  app.put<{ Body: GovernanceUpdateBody }>(
    '/company/settings/governance',
    { preHandler, schema: companyGovernancePutRouteSchema },
    async (request, reply) => {
      const runtime = deps.runtime;
      const correlation_id = correlationIdOf(request, runtime);
      try {
        const principal = requireOperator(request, 'settings:manage');
        const operator_id = principal.operator_id;
        if (operator_id === undefined || operator_id.length === 0) {
          fail('AUTHENTICATION_FAILED', 'the authenticated operator principal carries no operator identifier');
        }
        const governance = runtime.governance;
        if (governance === undefined) fail('PROVIDER_TIMEOUT', 'governance settings could not be updated');

        const version = expectedVersion(request.headers['if-match']);
        let updated: GovernanceSettings | null;
        try {
          updated = await governance.update(principal.tenant_id, {
            ...request.body,
            expected_version: version,
            actor_kind: principal.kind,
            actor_id: operator_id,
            correlation_id,
          });
        } catch (error) {
          const code = error instanceof Error ? error.message : '';
          if (code === 'GOVERNANCE_SETTINGS_NOT_FOUND') {
            fail('NOT_FOUND', 'governance settings were not found');
          }
          if (code === 'GOVERNANCE_SETTINGS_INVALID') {
            fail('VALIDATION_FAILED', 'governance settings are invalid');
          }
          fail('PROVIDER_TIMEOUT', 'governance settings could not be updated');
        }
        if (updated === null) {
          fail('VERSION_CONFLICT', 'governance settings changed; reload before saving');
        }

        const response = settingsResponse(updated);
        return reply.code(200).header('ETag', `"${updated.version}"`).send(response);
      } catch (error) {
        return replyFailure(reply, error, correlation_id);
      }
    },
  );
}
