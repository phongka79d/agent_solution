import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerProvisioningRoutes } from './provisioning.js';

const COMPANY_TOKEN = 'company-provisioning-token';
const PLATFORM_TOKEN = 'platform-provisioning-token';
const TENANT = 'tenant-company';

function buildHarness() {
  const createShell = vi.fn(async () => ({
    tenant_id: TENANT,
    status: 'PROVISIONED',
    capabilities: [],
    connectors: [],
    unresolved_owner_inputs: [],
    autonomy: null,
  }));
  const auditRecord = vi.fn(async () => undefined);
  const runtime = {
    ids: () => 'corr-provisioning-test',
    audit: { record: auditRecord },
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerProvisioningRoutes(app, {
    provisioning: {
      createShell,
      getShell: vi.fn(async () => null),
    },
    credentials: createCredentialStore({
      operators: [
        {
          token: COMPANY_TOKEN,
          tenant_id: TENANT,
          operator_id: 'company-operator',
          scope: 'company',
          permissions: ['platform:admin'],
        },
        {
          token: PLATFORM_TOKEN,
          tenant_id: TENANT,
          operator_id: 'platform-operator',
          scope: 'platform',
          permissions: ['platform:admin'],
        },
      ],
      sessions: [],
      widgets: [],
    }),
    runtime,
  });
  return { app, createShell, auditRecord };
}

describe('POST /provisioning/tenants', () => {
  it('refuses a company-scoped operator even when it holds platform:admin', async () => {
    const { app, createShell } = buildHarness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/provisioning/tenants',
        headers: {
          authorization: `Bearer ${COMPANY_TOKEN}`,
          'idempotency-key': 'company-provisioning-key',
        },
        payload: { display_name: 'Should not provision' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error_code: 'INSUFFICIENT_AUTHORITY' });
      expect(createShell).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('authenticates before evaluating a body tenant assertion', async () => {
    const { app, createShell } = buildHarness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/provisioning/tenants',
        headers: {
          authorization: `Bearer ${PLATFORM_TOKEN}`,
          'idempotency-key': 'platform-provisioning-key',
        },
        payload: { tenant_id: 'tenant-attacker', display_name: 'Should not provision' },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error_code: 'TENANT_BINDING_MISMATCH' });
      expect(createShell).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('audits a successful tenant shell provisioning', async () => {
    const { app, auditRecord } = buildHarness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/provisioning/tenants',
        headers: {
          authorization: `Bearer ${PLATFORM_TOKEN}`,
          'idempotency-key': 'platform-provisioning-key',
        },
        payload: { display_name: 'Provisioned tenant' },
      });

      expect(response.statusCode).toBe(201);
      expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
        tenant_id: TENANT,
        operation: 'provisioning.tenants.create',
        outcome: 'ACCEPTED',
      }));
    } finally {
      await app.close();
    }
  });

  it('does not translate an unrelated unique violation into an idempotency conflict', async () => {
    const { app, createShell } = buildHarness();
    createShell.mockRejectedValueOnce(Object.assign(new Error('unrelated unique violation'), {
      code: '23505',
      constraint: 'other_unique_constraint',
    }));
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/provisioning/tenants',
        headers: {
          authorization: `Bearer ${PLATFORM_TOKEN}`,
          'idempotency-key': 'platform-provisioning-key',
        },
        payload: { display_name: 'Provisioned tenant' },
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({ error_code: 'INTERNAL_ERROR' });
    } finally {
      await app.close();
    }
  });

});
