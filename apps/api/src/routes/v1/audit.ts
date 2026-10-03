import type { FastifyInstance } from 'fastify';

import type { CredentialStore } from '../../gateway/principal.js';
import { authenticate, requireOperator } from '../../gateway/principal.js';
import { correlationIdOf, fail, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';

const MAX_LIMIT = 200;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const UUID_PATTERN = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

interface AuditQuery {
  readonly cursor?: string;
  readonly limit?: string;
  readonly scope?: string;
}

interface PlatformAuditQuery extends AuditQuery {
  readonly tenant_id?: string;
}

function pageQuery(query: AuditQuery): { readonly cursor?: string; readonly limit?: number; readonly scope?: string } {
  const result: { cursor?: string; limit?: number; scope?: string } = {};
  if (query.cursor !== undefined) {
    if (!/^[1-9]\d{0,18}$/.test(query.cursor) || BigInt(query.cursor) > MAX_BIGINT) {
      fail('VALIDATION_FAILED', 'cursor must be a positive audit sequence');
    }
    result.cursor = query.cursor;
  }
  if (query.scope !== undefined) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(query.scope)) {
      fail('VALIDATION_FAILED', 'scope must be a valid audit scope');
    }
    result.scope = query.scope;
  }
  if (query.limit === undefined) return result;
  if (!/^[1-9]\d{0,2}$/.test(query.limit)) {
    fail('VALIDATION_FAILED', `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  const limit = Number(query.limit);
  if (limit > MAX_LIMIT) {
    fail('VALIDATION_FAILED', `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  result.limit = limit;
  return result;
}

const pageQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    cursor: { type: 'string', pattern: '^[1-9][0-9]{0,18}$', maxLength: 19 },
    limit: { type: 'string', pattern: '^[1-9][0-9]{0,2}$', maxLength: 3 },
    scope: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_.-]{0,63}$', maxLength: 64 },
  },
};

/** Registers tenant-scoped and platform-wide configuration audit history reads. */
export function registerAuditRoutes(
  app: FastifyInstance,
  deps: { readonly runtime: GatewayRuntime; readonly credentials: CredentialStore },
): void {
  const preHandler = authenticate(deps);

  app.get<{ Querystring: AuditQuery }>(
    '/company/audit',
    { preHandler, schema: { querystring: pageQuerySchema } },
    async (request, reply) => {
      const runtime = deps.runtime;
      try {
        const principal = requireOperator(request, 'settings:manage');
        const auditHistory = runtime.auditHistory;
        if (auditHistory === undefined) {
          fail('PROVIDER_TIMEOUT', 'configuration audit history is unavailable');
        }
        const page = await auditHistory.listForTenant(principal.tenant_id, pageQuery(request.query));
        return reply.code(200).send(page);
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, runtime));
      }
    },
  );

  app.get<{ Querystring: PlatformAuditQuery }>(
    '/platform/audit',
    {
      preHandler,
      preValidation: async (request) => {
        if (request.headers['x-tenant-id'] !== undefined) {
          fail('VALIDATION_FAILED', 'platform audit does not accept tenant binding headers');
        }
      },
      schema: {
        querystring: {
          ...pageQuerySchema,
          properties: {
            ...pageQuerySchema.properties,
            tenant_id: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const runtime = deps.runtime;
      try {
        const principal = requireOperator(request, 'platform:audit:read');
        if (principal.scope !== 'platform') {
          fail('INSUFFICIENT_AUTHORITY', 'platform audit requires a platform-scoped principal');
        }
        const auditHistory = runtime.auditHistory;
        if (auditHistory === undefined) {
          fail('PROVIDER_TIMEOUT', 'configuration audit history is unavailable');
        }
        const query = pageQuery(request.query);
        const tenant_id = request.query.tenant_id;
        if (tenant_id !== undefined && !UUID_PATTERN.test(tenant_id)) {
          fail('VALIDATION_FAILED', 'tenant_id must be a UUID');
        }
        const page = await auditHistory.listForPlatform({
          ...query,
          ...(tenant_id === undefined ? {} : { tenant_id }),
        });
        return reply.code(200).send(page);
      } catch (error) {
        return replyFailure(reply, error, correlationIdOf(request, runtime));
      }
    },
  );
}
