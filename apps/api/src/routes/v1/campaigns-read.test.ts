import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { CompanyCrmCampaignRow } from '@agentos/database';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerCampaignRoutes } from './campaigns.js';

const TENANT = 'tenant-a';
const DRAFT_TOKEN = 'campaign-draft-reader';
const APPROVAL_TOKEN = 'approval-reader';
const DENIED_TOKEN = 'customer-reader';

const campaign: CompanyCrmCampaignRow = {
  campaign_id: null,
  run_id: 'run-1',
  name: 'Winback',
  objective: 'retention',
  channels: ['EMAIL_HTML'],
  campaign_status: 'draft',
  campaign_created_at: '2026-01-01T00:00:00.000Z',
  campaign_updated_at: null,
  task_state: 'queued',
  task_payload: { signal: { payload: { module: 'marketing' } } },
  task_created_at: '2026-01-01T00:00:00.000Z',
  approval_id: null,
  approval_decision: null,
  approval_created_at: null,
  approval_decided_at: null,
  approval_payload: null,
};

function buildHarness() {
  const runtime = {
    companyCrm: {
      listCampaigns: vi.fn(async () => ({ items: [campaign], next_cursor: null })),
      getCampaign: vi.fn(async () => campaign),
    },
    audit: { record: vi.fn(async () => undefined) },
    ids: () => 'corr-campaign-read-1',
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerCampaignRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [
        { token: DRAFT_TOKEN, tenant_id: TENANT, operator_id: 'operator-draft', permissions: ['campaign:draft'] },
        { token: APPROVAL_TOKEN, tenant_id: TENANT, operator_id: 'operator-approval', permissions: ['approval:read'] },
        { token: DENIED_TOKEN, tenant_id: TENANT, operator_id: 'operator-customer', permissions: ['customer:read'] },
      ],
      sessions: [],
      widgets: [],
    }),
  });
  return { app, runtime };
}

describe('campaign read permissions', () => {
  it.each([DRAFT_TOKEN, APPROVAL_TOKEN])('allows %s to list and read campaigns', async (token) => {
    const { app, runtime } = buildHarness();
    try {
      const headers = { authorization: `Bearer ${token}` };
      const list = await app.inject({ method: 'GET', url: '/campaigns', headers });
      const detail = await app.inject({ method: 'GET', url: '/campaigns/run-1', headers });
      expect(list.statusCode).toBe(200);
      expect(list.json().items[0].dispatch).toEqual({ status: 'NOT_INTEGRATED' });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().run_id).toBe('run-1');
      expect(runtime.companyCrm?.listCampaigns).toHaveBeenCalledWith({ tenant_id: TENANT });
      expect(runtime.companyCrm?.getCampaign).toHaveBeenCalledWith(TENANT, 'run-1');
    } finally {
      await app.close();
    }
  });

  it('denies an operator who has neither campaign:draft nor approval:read', async () => {
    const { app, runtime } = buildHarness();
    try {
      const response = await app.inject({
        method: 'GET',
        url: '/campaigns',
        headers: { authorization: `Bearer ${DENIED_TOKEN}` },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error_code).toBe('INSUFFICIENT_AUTHORITY');
      expect(runtime.companyCrm?.listCampaigns).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
