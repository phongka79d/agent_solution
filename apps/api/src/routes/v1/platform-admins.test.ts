import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayRuntime, PlatformAdminsPort } from '../../gateway/ports.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerPlatformAdminRoutes } from './platform-admins.js';

const TENANT_ID = 'platform-control-plane';
const ADMIN_EMAIL = 'secret.admin@example.test';

function createHarness() {
  const auditRecord = vi.fn(async () => undefined);
  const runtime = {
    ids: () => 'corr-platform-admins',
    audit: { record: auditRecord },
    clock: () => new Date('2026-10-01T00:00:00.000Z'),
  } as unknown as GatewayRuntime;
  const invite = vi.fn(async (input: Parameters<PlatformAdminsPort['invite']>[0]) => ({
    invitation_id: 'invitation-platform-admin',
    email: input.email,
    expires_at: '2026-10-04T00:00:00.000Z',
  }));
  const platformAdmins: PlatformAdminsPort = {
    list: async () => [{
      user_id: 'platform-admin-user',
      display_name: 'Platform Operator',
      email: ADMIN_EMAIL,
      status: 'ACTIVE',
      last_sign_in_at: '2026-09-30T00:00:00.000Z',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-30T00:00:00.000Z',
    }],
    invite,
  };
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerPlatformAdminRoutes(app, {
    platformAdmins,
    credentials: createCredentialStore({
      operators: [
        {
          token: 'platform-reader',
          tenant_id: TENANT_ID,
          operator_id: 'reader-id',
          scope: 'platform',
          permissions: ['platform:admin'],
        },
        {
          token: 'company-reader',
          tenant_id: TENANT_ID,
          operator_id: 'company-id',
          scope: 'company',
          permissions: ['platform:admin'],
        },
        {
          token: 'platform-writer',
          tenant_id: TENANT_ID,
          operator_id: 'writer-id',
          scope: 'platform',
          permissions: ['platform:companies:write'],
        },
      ],
      sessions: [],
      widgets: [],
    }),
    runtime,
  });
  return { app, auditRecord, invite };
}

describe('platform administrator routes', () => {
  it('requires platform scope and masks addresses in the admin listing', async () => {
    const { app } = createHarness();
    const denied = await app.inject({
      method: 'GET',
      url: '/platform/admins',
      headers: { authorization: 'Bearer company-reader' },
    });
    expect(denied.statusCode).toBe(403);

    const response = await app.inject({
      method: 'GET',
      url: '/platform/admins',
      headers: { authorization: 'Bearer platform-reader' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      items: [{ email: 's***@example.test', role: 'PLATFORM_ADMIN', status: 'ACTIVE' }],
    });
    expect(response.body).not.toContain(ADMIN_EMAIL);
    await app.close();
  });

  it('normalizes and invites a platform admin without exposing the address to audit or response', async () => {
    const { app, auditRecord, invite } = createHarness();
    const response = await app.inject({
      method: 'POST',
      url: '/platform/admins',
      headers: { authorization: 'Bearer platform-writer' },
      payload: { email: '  New.Admin@Example.test  ' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      invitation_id: 'invitation-platform-admin',
      email: 'n***@example.test',
      expires_at: '2026-10-04T00:00:00.000Z',
    });
    expect(invite).toHaveBeenCalledWith({
      tenant_id: TENANT_ID,
      email: 'new.admin@example.test',
      created_by: 'writer-id',
    });
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'platform_admins.invite',
      detail: expect.objectContaining({ scope: 'platform' }),
    }));
    expect(JSON.stringify(auditRecord.mock.calls)).not.toContain(ADMIN_EMAIL);
    await app.close();
  });
});
