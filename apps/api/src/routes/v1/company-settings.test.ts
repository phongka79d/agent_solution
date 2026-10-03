import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerCompanySettingsRoutes } from './company-settings.js';

const TENANT = 'tenant-a';
const READ_TOKEN = 'settings-read-token';
const MANAGE_TOKEN = 'settings-manage-token';
const OTHER_TOKEN = 'settings-no-read-token';

function buildHarness(setting: boolean) {
  const settings = {
    tenant_id: TENANT,
    require_distinct_approver: setting,
    approval_expiry_hours: 72,
    takeover_lease_seconds: 300,
    version: 4,
    updated_at: '2026-09-23T00:00:00.000Z',
  };
  const governanceGet = vi.fn(async () => settings);
  const governanceUpdate = vi.fn(async (_tenant_id: string, input: {
    require_distinct_approver: boolean;
    approval_expiry_hours: number;
    takeover_lease_seconds: number;
    expected_version: number;
  }) => input.expected_version === settings.version ? {
    ...settings,
    ...input,
    version: settings.version + 1,
    updated_at: '2026-09-24T00:00:00.000Z',
  } : null);
  const runtime = {
    governance: { get: governanceGet, update: governanceUpdate },
    audit: { record: vi.fn(async () => undefined) },
    ids: () => 'corr-company-settings-test',
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerCompanySettingsRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [
        {
          token: READ_TOKEN,
          tenant_id: TENANT,
          operator_id: 'operator-read',
          permissions: ['approval:read'],
        },
        {
          token: MANAGE_TOKEN,
          tenant_id: TENANT,
          operator_id: 'operator-manage',
          permissions: ['settings:manage'],
        },
        {
          token: OTHER_TOKEN,
          tenant_id: TENANT,
          operator_id: 'operator-other',
          permissions: ['run:read'],
        },
      ],
      sessions: [],
      widgets: [],
    }),
  });
  return { app, governanceGet, governanceUpdate };
}

describe('GET /company/settings/governance', () => {
  it('requires approval:read and returns the versioned tenant policy', async () => {
    const { app, governanceGet } = buildHarness(true);

    try {
      const allowed = await app.inject({
        method: 'GET',
        url: '/company/settings/governance',
        headers: { authorization: `Bearer ${READ_TOKEN}` },
      });
      const denied = await app.inject({
        method: 'GET',
        url: '/company/settings/governance',
        headers: { authorization: `Bearer ${OTHER_TOKEN}` },
      });

      expect(allowed.statusCode).toBe(200);
      expect(allowed.headers.etag).toBe('"4"');
      expect(allowed.json()).toEqual({
        require_distinct_approver: true,
        approval_expiry_hours: 72,
        takeover_lease_seconds: 300,
        version: 4,
        updated_at: '2026-09-23T00:00:00.000Z',
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error_code: 'INSUFFICIENT_AUTHORITY' });
      expect(governanceGet).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

describe('PUT /company/settings/governance', () => {
  const body = {
    require_distinct_approver: true,
    approval_expiry_hours: 48,
    takeover_lease_seconds: 120,
  };

  it('requires settings:manage and updates only against the supplied If-Match version', async () => {
    const { app, governanceUpdate } = buildHarness(false);
    try {
      const denied = await app.inject({
        method: 'PUT',
        url: '/company/settings/governance',
        headers: {
          authorization: `Bearer ${OTHER_TOKEN}`,
          'if-match': '"4"',
        },
        payload: body,
      });
      const updated = await app.inject({
        method: 'PUT',
        url: '/company/settings/governance',
        headers: {
          authorization: `Bearer ${MANAGE_TOKEN}`,
          'if-match': '"4"',
        },
        payload: body,
      });

      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error_code: 'INSUFFICIENT_AUTHORITY' });
      expect(updated.statusCode).toBe(200);
      expect(updated.headers.etag).toBe('"5"');
      expect(updated.json()).toMatchObject({ ...body, version: 5 });
      expect(governanceUpdate).toHaveBeenCalledWith(TENANT, {
        ...body,
        expected_version: 4,
        actor_kind: 'OPERATOR',
        actor_id: 'operator-manage',
        correlation_id: 'corr-company-settings-test',
      });
    } finally {
      await app.close();
    }
  });

  it('returns 409 for a stale version and 400 for invalid or absent preconditions', async () => {
    const { app, governanceUpdate } = buildHarness(false);
    const request = (headers: Record<string, string>, payload = body) => app.inject({
      method: 'PUT',
      url: '/company/settings/governance',
      headers: { authorization: `Bearer ${MANAGE_TOKEN}`, ...headers },
      payload,
    });
    try {
      const stale = await request({ 'if-match': '3' });
      const invalidExpiryLow = await request({ 'if-match': '"4"' }, { ...body, approval_expiry_hours: 0 });
      const invalidExpiryHigh = await request({ 'if-match': '"4"' }, { ...body, approval_expiry_hours: 721 });
      const invalidLeaseLow = await request({ 'if-match': '"4"' }, { ...body, takeover_lease_seconds: 29 });
      const invalidLeaseHigh = await request({ 'if-match': '"4"' }, { ...body, takeover_lease_seconds: 601 });
      const missing = await request({});

      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ error_code: 'VERSION_CONFLICT' });
      const invalidResponses = [invalidExpiryLow, invalidExpiryHigh, invalidLeaseLow, invalidLeaseHigh];
      for (const response of invalidResponses) {
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({
          error_code: 'VALIDATION_FAILED',
          message: 'Yêu cầu không hợp lệ.',
        });
      }
      expect(missing.statusCode).toBe(400);
      expect(governanceUpdate).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
