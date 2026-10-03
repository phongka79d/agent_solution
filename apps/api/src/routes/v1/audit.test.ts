import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerAuditRoutes } from './audit.js';

const TENANT = '9a2f7ed4-1fe4-4f8c-8d63-008450000002';
const PAGE = { items: [], next_cursor: null, chain_verified: true } as const;

function buildHarness() {
  const listForTenant = vi.fn(async () => PAGE);
  const listForPlatform = vi.fn(async () => PAGE);
  const runtime = {
    auditHistory: { listForTenant, listForPlatform },
    ids: () => 'audit-route-test',
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerAuditRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [
        {
          token: 'company-audit-token',
          tenant_id: TENANT,
          operator_id: 'company-operator',
          scope: 'company',
          permissions: ['settings:manage'],
        },
        {
          token: 'company-no-audit-token',
          tenant_id: TENANT,
          operator_id: 'company-operator',
          scope: 'company',
          permissions: ['run:read'],
        },
        {
          token: 'platform-audit-token',
          tenant_id: TENANT,
          operator_id: 'platform-operator',
          scope: 'platform',
          permissions: ['platform:audit:read'],
        },
        {
          token: 'wrong-scope-token',
          tenant_id: TENANT,
          operator_id: 'company-operator',
          scope: 'company',
          permissions: ['platform:audit:read'],
        },
      ],
      sessions: [],
      widgets: [],
    }),
  });
  return { app, listForTenant, listForPlatform };
}

describe('configuration audit routes', () => {
  it('requires settings:manage and binds company history to the authenticated tenant', async () => {
    const { app, listForTenant } = buildHarness();
    try {
      const allowed = await app.inject({
        method: 'GET',
        url: '/company/audit?cursor=12&limit=20&scope=company.profile',
        headers: { authorization: 'Bearer company-audit-token' },
      });
      const denied = await app.inject({
        method: 'GET',
        url: '/company/audit',
        headers: { authorization: 'Bearer company-no-audit-token' },
      });
      const invalidScope = await app.inject({
        method: 'GET',
        url: '/company/audit?scope=company%2Fprofile',
        headers: { authorization: 'Bearer company-audit-token' },
      });

      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toEqual(PAGE);
      expect(listForTenant).toHaveBeenCalledWith(TENANT, { cursor: '12', scope: 'company.profile', limit: 20 });
      expect(denied.statusCode).toBe(403);
      expect(invalidScope.statusCode).toBe(400);
      expect(listForTenant).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('requires platform scope and platform:audit:read for platform history', async () => {
    const { app, listForPlatform } = buildHarness();
    try {
      const allowed = await app.inject({
        method: 'GET',
        url: `/platform/audit?tenant_id=${TENANT}&limit=10`,
        headers: { authorization: 'Bearer platform-audit-token' },
      });
      const wrongScope = await app.inject({
        method: 'GET',
        url: '/platform/audit',
        headers: { authorization: 'Bearer wrong-scope-token' },
      });

      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toEqual(PAGE);
      expect(listForPlatform).toHaveBeenCalledWith({ tenant_id: TENANT, limit: 10 });
      expect(wrongScope.statusCode).toBe(403);
      expect(listForPlatform).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
