import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerAutonomyAdminRoutes } from './autonomy-admin.js';

const TENANT = 'tenant-autonomy';
const TOKEN = 'autonomy-admin-token';
const COMPANY_ADMIN_TOKEN = 'company-autonomy-admin-token';

function buildHarness() {
  const auditRecord = vi.fn(async () => undefined);
  const pauseTenant = vi.fn(async () => ({ state: 'PAUSED' }));
  const resumeTenant = vi.fn(async () => ({ state: 'ACTIVE' }));
  const demote = vi.fn(async () => ({ state: 'MINIMUM' }));
  const inspect = vi.fn(async () => ({ state: 'ACTIVE' }));
  const requestPromotion = vi.fn(async () => ({ request: { status: 'PENDING' }, policy: null }));
  const decidePromotion = vi.fn(async () => ({ request: { status: 'APPROVED' }, policy: { policy_revision: 2 } }));
  const listPromotionRequests = vi.fn(async () => []);
  const runtime = {
    ids: () => 'corr-autonomy-test',
    audit: { record: auditRecord },
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerAutonomyAdminRoutes(app, {
    autonomyAdmin: { pauseTenant, resumeTenant, demote, inspect, requestPromotion, decidePromotion, listPromotionRequests },
    credentials: createCredentialStore({
      operators: [
        {
          token: TOKEN,
          tenant_id: TENANT,
          operator_id: 'operator-autonomy',
          scope: 'platform',
          permissions: ['platform:admin', 'agents:manage'],
        },
        {
          token: COMPANY_ADMIN_TOKEN,
          tenant_id: TENANT,
          operator_id: 'company-admin',
          scope: 'company',
          permissions: ['platform:admin'],
        },
      ],
      sessions: [],
      widgets: [],
    }),
    runtime,
  });
  return { app, auditRecord, pauseTenant, resumeTenant, demote, inspect, requestPromotion, decidePromotion, listPromotionRequests };
}

describe('autonomy admin audit records', () => {

  it('rejects a company-scoped operator with platform:admin on platform autonomy routes', async () => {
    const { app, inspect } = buildHarness();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/admin/autonomy',
        headers: { authorization: `Bearer ${COMPANY_ADMIN_TOKEN}` },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().error_code).toBe('INSUFFICIENT_AUTHORITY');
      expect(inspect).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
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

  it('requests and decides a promotion for a draft-gated skill under agents:manage', async () => {
    const { app, auditRecord, requestPromotion, decidePromotion } = buildHarness();
    try {
      const headers = { authorization: `Bearer ${TOKEN}` };
      const created = await app.inject({
        method: 'POST',
        url: '/company/autonomy/skill.mkt.generate_content/promotion-requests',
        headers,
        payload: { policy_version: 'v1', required_authority: 'AUTH-1', expected_revision: 3 },
      });
      expect(created.statusCode).toBe(200);
      expect(requestPromotion).toHaveBeenCalledWith({
        tenant_id: TENANT,
        operator_id: 'operator-autonomy',
        skill_id: 'skill.mkt.generate_content',
        policy_version: 'v1',
        required_authority: 'AUTH-1',
        expected_revision: 3,
      });

      const decided = await app.inject({
        method: 'POST',
        url: '/company/autonomy/promotion-requests/req-1/decision',
        headers,
        payload: { decision: 'APPROVE' },
      });
      expect(decided.statusCode).toBe(200);
      expect(decidePromotion).toHaveBeenCalledWith({
        tenant_id: TENANT,
        operator_id: 'operator-autonomy',
        request_id: 'req-1',
        decision: 'APPROVE',
      });
      expect(auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'autonomy.promotion.request', outcome: 'ACCEPTED' }),
      );
      expect(auditRecord).toHaveBeenCalledWith(
        expect.objectContaining({ operation: 'autonomy.promotion.decision', outcome: 'ACCEPTED' }),
      );
    } finally {
      await app.close();
    }
  });

  it('refuses a promotion request without a policy version', async () => {
    const { app, requestPromotion } = buildHarness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/company/autonomy/skill.mkt.generate_content/promotion-requests',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { required_authority: 'AUTH-1' },
      });
      expect(response.statusCode).toBe(400);
      expect(requestPromotion).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('refuses an unknown decision verb', async () => {
    const { app, decidePromotion } = buildHarness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/company/autonomy/promotion-requests/req-1/decision',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { decision: 'MAYBE' },
      });
      expect(response.statusCode).toBe(400);
      expect(decidePromotion).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('maps a stale policy revision to 409 VERSION_CONFLICT', async () => {
    const { app, requestPromotion } = buildHarness();
    requestPromotion.mockRejectedValueOnce(new Error('P5_AUTONOMY_REVISION_CONFLICT: the policy changed since it was read.'));
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/company/autonomy/skill.mkt.generate_content/promotion-requests',
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { policy_version: 'v1', required_authority: 'AUTH-2', expected_revision: 2 },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error_code: 'VERSION_CONFLICT' });
    } finally {
      await app.close();
    }
  });
});
