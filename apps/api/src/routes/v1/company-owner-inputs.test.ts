import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { OwnerInputRecord, ResolveOwnerInputInput } from '@agentos/database';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import type { ProvisioningRoutePort } from './provisioning.js';
import { registerCompanyOwnerInputsRoutes } from './company-owner-inputs.js';

const TENANT = 'tenant-company';
const COMPANY_TOKEN = 'company-settings-token';
const DENIED_TOKEN = 'company-no-settings-token';
const CURRENT: OwnerInputRecord = {
  tenant_id: TENANT,
  input_id: 'careOnboardingItinerary',
  status: 'UNRESOLVED',
  version: 1,
  resolved_value: { private_value: 'must not be returned' },
  resolved_value_ref: null,
  resolved_by: null,
  resolved_at: null,
};

function buildHarness() {
  const listOwnerInputs = vi.fn(async () => [CURRENT]);
  const resolveOwnerInput = vi.fn(async (input: ResolveOwnerInputInput) => ({
    status: 'RESOLVED' as const,
    input: {
      ...CURRENT,
      status: 'RESOLVED' as const,
      version: input.expected_version + 1,
      resolved_by: input.actor_id,
      resolved_at: '2026-09-30T12:00:00.000Z',
    },
  }));
  const runtime = { ids: () => 'owner-input-route-test' } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerCompanyOwnerInputsRoutes(app, {
    ownerInputs: {
      createShell: async () => ({
        tenant_id: TENANT,
        status: 'PROVISIONED',
        data_class: 'PRODUCTION',
        capabilities: [],
        connectors: [],
        unresolved_owner_inputs: [],
        autonomy: null,
      }),
      getShell: async () => null,
      listOwnerInputs,
      resolveOwnerInput,
    } satisfies ProvisioningRoutePort,
    credentials: createCredentialStore({
      operators: [
        {
          token: COMPANY_TOKEN,
          tenant_id: TENANT,
          operator_id: 'company-operator',
          scope: 'company',
          permissions: ['settings:manage'],
        },
        {
          token: DENIED_TOKEN,
          tenant_id: TENANT,
          operator_id: 'company-viewer',
          scope: 'company',
          permissions: ['run:read'],
        },
      ],
      sessions: [],
      widgets: [],
    }),
    runtime,
  });
  return { app, listOwnerInputs, resolveOwnerInput };
}

describe('GET /company/owner-inputs', () => {
  it('requires settings:manage and omits stored values from the browser response', async () => {
    const { app, listOwnerInputs } = buildHarness();
    try {
      const allowed = await app.inject({
        method: 'GET',
        url: '/company/owner-inputs',
        headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
      });
      const denied = await app.inject({
        method: 'GET',
        url: '/company/owner-inputs',
        headers: { authorization: `Bearer ${DENIED_TOKEN}` },
      });

      expect(allowed.statusCode).toBe(200);
      expect(allowed.json()).toEqual({
        items: [{ input_id: 'careOnboardingItinerary', status: 'UNRESOLVED', version: 1, resolved_at: null }],
      });
      expect(allowed.body).not.toContain('must not be returned');
      expect(denied.statusCode).toBe(403);
      expect(listOwnerInputs).toHaveBeenCalledTimes(1);
      expect(listOwnerInputs).toHaveBeenCalledWith(TENANT);
    } finally {
      await app.close();
    }
  });
});

describe('POST /company/owner-inputs/:id/resolve', () => {
  it('validates the body and version before reaching the repository', async () => {
    const { app, resolveOwnerInput } = buildHarness();
    try {
      const invalidBody = await app.inject({
        method: 'POST',
        url: '/company/owner-inputs/careOnboardingItinerary/resolve',
        headers: { authorization: `Bearer ${COMPANY_TOKEN}`, 'if-match': '1' },
        payload: { value: { itinerary: [] }, value_ref: 'vault://ref' },
      });
      const missingVersion = await app.inject({
        method: 'POST',
        url: '/company/owner-inputs/careOnboardingItinerary/resolve',
        headers: { authorization: `Bearer ${COMPANY_TOKEN}` },
        payload: { value: { itinerary: [] } },
      });
      const invalidValue = await app.inject({
        method: 'POST',
        url: '/company/owner-inputs/careOnboardingItinerary/resolve',
        headers: { authorization: `Bearer ${COMPANY_TOKEN}`, 'if-match': '1' },
        payload: { value: {} },
      });

      expect(invalidBody.statusCode).toBe(400);
      expect(missingVersion.statusCode).toBe(400);
      expect(invalidValue.statusCode).toBe(400);
      expect(resolveOwnerInput).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('requires settings:manage and resolves using the authenticated actor and CAS version', async () => {
    const { app, resolveOwnerInput } = buildHarness();
    try {
      const denied = await app.inject({
        method: 'POST',
        url: '/company/owner-inputs/careOnboardingItinerary/resolve',
        headers: { authorization: `Bearer ${DENIED_TOKEN}`, 'if-match': '1' },
        payload: { value: { itinerary: [{ step: 'owner-defined' }] } },
      });
      const response = await app.inject({
        method: 'POST',
        url: '/company/owner-inputs/careOnboardingItinerary/resolve',
        headers: { authorization: `Bearer ${COMPANY_TOKEN}`, 'if-match': '1' },
        payload: { value: { itinerary: [{ step: 'owner-defined' }] } },
      });

      expect(denied.statusCode).toBe(403);
      expect(response.statusCode).toBe(200);
      expect(response.headers.etag).toBe('"2"');
      expect(response.json()).toEqual({
        input: {
          input_id: 'careOnboardingItinerary',
          status: 'RESOLVED',
          version: 2,
          resolved_at: '2026-09-30T12:00:00.000Z',
        },
      });
      expect(resolveOwnerInput).toHaveBeenCalledOnce();
      expect(resolveOwnerInput).toHaveBeenCalledWith(expect.objectContaining({
        tenant_id: TENANT,
        input_id: 'careOnboardingItinerary',
        expected_version: 1,
        value: { itinerary: [{ step: 'owner-defined' }] },
        actor_kind: 'OPERATOR',
        actor_id: 'company-operator',
        correlation_id: expect.any(String),
      }));
    } finally {
      await app.close();
    }
  });
});
