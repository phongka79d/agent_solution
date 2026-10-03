import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { GatewayRuntime } from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { registerCampaignRoutes } from './campaigns.js';

const TENANT = 'tenant-a';
const OTHER_TENANT = 'tenant-b';
const CREATOR_TOKEN = 'creator-token';
const APPROVER_TOKEN = 'approver-token';
const REQUEST = {
  idempotency_key: 'campaign-draft-1',
  segment_id: 'inactive_90d',
  name: '90-day customer reactivation',
  objective: 'winback',
  instruction: 'Create a concise reactivation campaign for inactive customers.',
  content_constraints: {
    channel: 'EMAIL_HTML',
    locale: 'vi-VN',
    max_length: 800,
  },
};

function buildHarness() {
  const receipts = new Map<string, Record<string, unknown>>();
  const start = vi.fn(async (input: { correlation_id: string }) => ({
    run_id: 'run-campaign-1',
    task_version: 1,
    correlation_id: input.correlation_id,
    lifecycle_state: 'queued' as const,
    admission: 'ADMITTED' as const,
  }));
  const listCampaigns = vi.fn(async () => ({ items: [], next_cursor: null }));
  const runtime = {
    runs: { start },
    companyCrm: {
      listCampaigns,
      listCampaignSegments: vi.fn(async () => [30, 60, 90, 180].map((days) => ({
        segment_id: `inactive_${String(days)}d`,
        label_key: `campaigns.segments.inactive_${String(days)}d`,
        kind: 'INACTIVE_DAYS' as const,
        days,
        audience_count: 12,
      }))),
    },
    receipts: {
      receiptFor: vi.fn(async (_tenant_id: string, effect_key: string) => receipts.get(effect_key) ?? null),
      storeReceipt: vi.fn(async (_tenant_id: string, effect_key: string, receipt: Record<string, unknown>) => {
        receipts.set(effect_key, receipt);
      }),
    },
    effects: {
      computeEffectKey: (input: { tenant_id: string; skill_id: string; request_id: string }) =>
        [input.tenant_id, input.skill_id, input.request_id].join(':'),
      computeRequestFingerprint: (payload: Record<string, unknown>) => JSON.stringify(payload),
    },
    audit: { record: vi.fn(async () => undefined) },
    ids: () => 'corr-campaign-1',
  } as unknown as GatewayRuntime;

  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerCampaignRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [
        {
          token: CREATOR_TOKEN,
          tenant_id: TENANT,
          operator_id: 'operator-creator',
          permissions: ['campaign:draft'],
        },
        {
          token: APPROVER_TOKEN,
          tenant_id: TENANT,
          operator_id: 'operator-approver',
          permissions: ['approval:read', 'approval:decide'],
        },
      ],
      sessions: [],
      widgets: [],
    }),
  });

  return { app, listCampaigns, receipts, runtime, start };
}

it('returns the tenant-scoped supported campaign segment options', async () => {
  const { app, runtime } = buildHarness();
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/campaigns/segments',
      headers: { authorization: `Bearer ${CREATOR_TOKEN}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      segments: [30, 60, 90, 180].map((days) => ({
        segment_id: `inactive_${String(days)}d`,
        label_key: `campaigns.segments.inactive_${String(days)}d`,
        kind: 'INACTIVE_DAYS',
        days,
        audience_count: 12,
      })),
    });
    expect(runtime.companyCrm?.listCampaignSegments).toHaveBeenCalledWith(TENANT);
  } finally {
    await app.close();
  }
});

describe('POST /campaigns/drafts', () => {
  it('admits a tenant-bound Marketing draft and returns only its durable task receipt', async () => {
    const { app, start } = buildHarness();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/campaigns/drafts',
        headers: { authorization: `Bearer ${CREATOR_TOKEN}` },
        payload: REQUEST,
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({
        task_id: 'run-campaign-1',
        conversation_id: null,
        status: 'accepted',
        task_version: 1,
        correlation_id: 'corr-campaign-1',
      });
      expect(start).toHaveBeenCalledTimes(1);
      expect(start).toHaveBeenCalledWith({
        tenant_id: TENANT,
        correlation_id: 'corr-campaign-1',
        request_id: REQUEST.idempotency_key,
        admission_skill_id: 'campaign.draft',
        source_channel: 'MARKETING_CAMPAIGN',
        event_type: 'campaign.requested',
        session_id: 'operator-creator',
        channel_type: 'MARKETING_CAMPAIGN',
        channel_identifier: 'operator-creator',
        payload: {
          module: 'marketing',
          skill_id: 'skill.mkt.generate_content',
          input: {
            segment_id: REQUEST.segment_id,
            name: REQUEST.name,
            objective: REQUEST.objective,
            instruction: REQUEST.instruction,
            content_constraints: REQUEST.content_constraints,
          },
        },
        campaign: {
          campaign_id: 'corr-campaign-1',
          name: REQUEST.name,
          objective: REQUEST.objective,
          channels: ['EMAIL_HTML'],
          audience_count: 12,
        },
      });
    } finally {
      await app.close();
    }
  });

  it('rejects a segment not advertised by the worker-supported segment list', async () => {
    const { app, start } = buildHarness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/campaigns/drafts',
        headers: { authorization: `Bearer ${CREATOR_TOKEN}` },
        payload: { ...REQUEST, segment_id: 'inactive_15d' },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error_code: 'VALIDATION_FAILED',
        message: 'Phân khúc chiến dịch không hợp lệ.',
      });
      expect(start).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a missing campaign name', async () => {
    const { app, start } = buildHarness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/campaigns/drafts',
        headers: { authorization: `Bearer ${CREATOR_TOKEN}` },
        payload: {
          idempotency_key: REQUEST.idempotency_key,
          segment_id: REQUEST.segment_id,
          objective: REQUEST.objective,
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().error_code).toBe('VALIDATION_FAILED');
      expect(start).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });


  it('accepts a campaign name at the 120-character limit', async () => {
    const { app, start } = buildHarness();
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/campaigns/drafts',
        headers: { authorization: `Bearer ${CREATOR_TOKEN}` },
        payload: { ...REQUEST, name: 'x'.repeat(120) },
      });
      expect(response.statusCode).toBe(202);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('rejects empty, whitespace-only, and over-limit campaign names', async () => {
    const { app, start } = buildHarness();
    try {
      for (const name of ['', '   ', 'x'.repeat(121)]) {
        const response = await app.inject({
          method: 'POST',
          url: '/campaigns/drafts',
          headers: { authorization: `Bearer ${CREATOR_TOKEN}` },
          payload: { ...REQUEST, name },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error_code).toBe('VALIDATION_FAILED');
      }
      expect(start).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('replays the same receipt, maps IN_FLIGHT status, and refuses changed bytes under the same idempotency key', async () => {
    const { app, start, receipts } = buildHarness();

    try {
      const headers = { authorization: `Bearer ${CREATOR_TOKEN}` };
      const first = await app.inject({ method: 'POST', url: '/campaigns/drafts', headers, payload: REQUEST });
      const stored = receipts.get(`${TENANT}:campaign.draft:${REQUEST.idempotency_key}`);
      if (stored === undefined) throw new Error('test receipt was not stored');
      stored.status = 'IN_FLIGHT';
      const replay = await app.inject({ method: 'POST', url: '/campaigns/drafts', headers, payload: REQUEST });
      const conflict = await app.inject({
        method: 'POST',
        url: '/campaigns/drafts',
        headers,
        payload: { ...REQUEST, objective: 'retention' },
      });

      expect(first.statusCode).toBe(202);
      expect(replay.statusCode).toBe(202);
      expect(replay.json()).toMatchObject({ status: 'in_flight' });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json().error_code).toBe('IDEMPOTENCY_CONFLICT');
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('rejects anonymous requests before starting a run', async () => {
    const { app, start } = buildHarness();

    try {
      const response = await app.inject({ method: 'POST', url: '/campaigns/drafts', payload: REQUEST });
      expect(response.statusCode).toBe(401);
      expect(response.json().error_code).toBe('AUTHENTICATION_FAILED');
      expect(start).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects an authenticated operator without campaign:draft authority', async () => {
    const { app, start } = buildHarness();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/campaigns/drafts',
        headers: { authorization: `Bearer ${APPROVER_TOKEN}` },
        payload: REQUEST,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error_code).toBe('INSUFFICIENT_AUTHORITY');
      expect(start).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects malformed or unscoped draft input', async () => {
    const { app, start } = buildHarness();

    try {
      for (const payload of [
        { idempotency_key: 'missing-fields' },
        { ...REQUEST, segment_id: '' },
        { ...REQUEST, objective: ' ' },
        { ...REQUEST, content_constraints: { channel: 'UNTRUSTED_CHANNEL' } },
        { ...REQUEST, unsupported: true },
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: '/campaigns/drafts',
          headers: { authorization: `Bearer ${CREATOR_TOKEN}` },
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error_code).toBe('VALIDATION_FAILED');
      }
      expect(start).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rejects a tenant assertion that does not match the authenticated operator', async () => {
    const { app, start } = buildHarness();

    try {
      const response = await app.inject({
        method: 'POST',
        url: '/campaigns/drafts',
        headers: {
          authorization: `Bearer ${CREATOR_TOKEN}`,
          'x-tenant-id': OTHER_TENANT,
        },
        payload: REQUEST,
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error_code).toBe('TENANT_BINDING_MISMATCH');
      expect(start).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
describe('GET /campaigns list limit validation', () => {
  it('rejects non-integer and out-of-range limits and passes a valid limit through', async () => {
    const { app, listCampaigns } = buildHarness();
    try {
      for (const limit of ['abc', '0', '1000']) {
        const response = await app.inject({
          method: 'GET',
          url: `/campaigns?limit=${limit}`,
          headers: { authorization: `Bearer ${CREATOR_TOKEN}` },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error_code).toBe('VALIDATION_FAILED');
      }
      expect(listCampaigns).not.toHaveBeenCalled();

      const valid = await app.inject({
        method: 'GET',
        url: '/campaigns?limit=200',
        headers: { authorization: `Bearer ${CREATOR_TOKEN}` },
      });
      expect(valid.statusCode).toBe(200);
      expect(listCampaigns).toHaveBeenCalledWith({ tenant_id: TENANT, limit: 200 });
    } finally {
      await app.close();
    }
  });
});
