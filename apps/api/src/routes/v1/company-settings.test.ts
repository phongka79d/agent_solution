import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerCompanySettingsRoutes } from './company-settings.js';

const TENANT = 'tenant-a';
const READ_TOKEN = 'settings-read-token';
const OTHER_TOKEN = 'settings-no-read-token';

function buildHarness(setting: boolean) {
  const governanceGet = vi.fn(async () => ({ require_distinct_approver: setting }));
  const runtime = {
    governance: { get: governanceGet },
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
  return { app, governanceGet };
}

describe('GET /company/settings/governance', () => {
  it('requires approval:read and returns the tenant boolean', async () => {
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
      expect(allowed.json()).toEqual({ require_distinct_approver: true });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ error_code: 'INSUFFICIENT_AUTHORITY' });
      expect(governanceGet).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
