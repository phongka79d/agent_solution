import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerAutonomyAdminRoutes } from './autonomy-admin.js';

const TENANT = 'tenant-autonomy';
const TOKEN = 'autonomy-admin-token';

function buildHarness() {
  const auditRecord = vi.fn(async () => undefined);
  const pauseTenant = vi.fn(async () => ({ state: 'PAUSED' }));
  const resumeTenant = vi.fn(async () => ({ state: 'ACTIVE' }));
  const demote = vi.fn(async () => ({ state: 'MINIMUM' }));
  const inspect = vi.fn(async () => ({ state: 'ACTIVE' }));
  const runtime = {
    ids: () => 'corr-autonomy-test',
    audit: { record: auditRecord },
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerAutonomyAdminRoutes(app, {
    autonomyAdmin: { pauseTenant, resumeTenant, demote, inspect },
    credentials: createCredentialStore({
      operators: [{
        token: TOKEN,
        tenant_id: TENANT,
        operator_id: 'operator-autonomy',
        scope: 'platform',
        permissions: ['platform:admin'],
      }],
      sessions: [],
      widgets: [],
    }),
    runtime,
  });
  return { app, auditRecord, pauseTenant, resumeTenant, demote };
}

describe('autonomy admin audit records', () => {
  it('audits pause, resume, and demotion after each operation succeeds', async () => {
    const { app, auditRecord, pauseTenant, resumeTenant, demote } = buildHarness();
    try {
      const headers = { authorization: `Bearer ${TOKEN}` };
      expect((await app.inject({ method: 'POST', url: '/admin/autonomy/pause', headers })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/admin/autonomy/resume', headers })).statusCode).toBe(200);
      expect((await app.inject({
        method: 'POST',
        url: '/admin/autonomy/demote',
        headers,
        payload: { skill_id: 'skill.autonomy', reason: 'operator request' },
      })).statusCode).toBe(200);

      expect(pauseTenant).toHaveBeenCalledWith({ tenant_id: TENANT, operator_id: 'operator-autonomy' });
      expect(resumeTenant).toHaveBeenCalledWith({ tenant_id: TENANT, operator_id: 'operator-autonomy' });
      expect(demote).toHaveBeenCalledWith({
        tenant_id: TENANT,
        operator_id: 'operator-autonomy',
        skill_id: 'skill.autonomy',
        reason: 'operator request',
      });
      expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ operation: 'autonomy.pause', outcome: 'ACCEPTED' }));
      expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ operation: 'autonomy.resume', outcome: 'ACCEPTED' }));
      expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ operation: 'autonomy.demote', outcome: 'ACCEPTED' }));
    } finally {
      await app.close();
    }
  });
});
