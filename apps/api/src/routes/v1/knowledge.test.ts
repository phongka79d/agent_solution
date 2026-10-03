import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { KnowledgeDocumentRecord, KnowledgeRepository } from '@agentos/database';
import type { GatewayRuntime } from '../../gateway/ports.js';
import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerKnowledgeRoutes } from './knowledge.js';

const TENANT = '9a2f7ed4-1fe4-4f8c-8d63-008450000002';
const DOCUMENT = '9a2f7ed4-1fe4-4f8c-8d63-008450000010';
const RECORD = {
  tenant_id: TENANT,
  document_id: DOCUMENT,
  namespace: 'company',
  type: 'FAQ',
  slug: 'faq',
  version: 1,
  title: 'Frequently asked questions',
  body: '# FAQ',
  content_sha256: 'a'.repeat(64),
  data_class: 'PRODUCTION',
  status: 'DRAFT',
  created_by: 'author',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
} as const satisfies KnowledgeDocumentRecord;
const BODY = { namespace: 'company', type: 'FAQ', slug: 'faq', title: 'FAQ', body: '# Content' };

function buildHarness(approve: KnowledgeRepository['approve'] = vi.fn(async () => RECORD)) {
  const repository = {
    list: vi.fn(async () => ({ items: [RECORD], next_cursor: null })),
    create: vi.fn(async () => RECORD),
    get: vi.fn(async () => RECORD),
    update: vi.fn(async () => RECORD),
    submit: vi.fn(async () => RECORD),
    approve,
    reject: vi.fn(async () => RECORD),
    archive: vi.fn(async () => RECORD),
    versions: vi.fn(async () => [RECORD]),
    usage: vi.fn(async () => ({ document_id: DOCUMENT, agents: [], skills: null })),
  } as unknown as KnowledgeRepository;
  const runtime = { ids: () => 'knowledge-route-test' } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerKnowledgeRoutes(app, {
    runtime,
    knowledge: repository,
    credentials: createCredentialStore({
      operators: [
        { token: 'manage', tenant_id: TENANT, operator_id: 'author', scope: 'company', permissions: ['knowledge:manage'] },
        { token: 'approve', tenant_id: TENANT, operator_id: 'reviewer', scope: 'company', permissions: ['knowledge:approve'] },
        { token: 'both', tenant_id: TENANT, operator_id: 'reviewer', scope: 'company', permissions: ['knowledge:manage', 'knowledge:approve'] },
        { token: 'none', tenant_id: TENANT, operator_id: 'reader', scope: 'company', permissions: [] },
      ],
      sessions: [],
      widgets: [],
    }),
  });
  return { app, repository };
}

const manageEndpoints = [
  { method: 'GET', url: '/knowledge/documents' },
  { method: 'GET', url: `/knowledge/documents/${DOCUMENT}` },
  { method: 'GET', url: `/knowledge/documents/${DOCUMENT}/versions` },
  { method: 'GET', url: `/knowledge/documents/${DOCUMENT}/usage` },
  { method: 'POST', url: '/knowledge/documents', payload: BODY },
  { method: 'PUT', url: `/knowledge/documents/${DOCUMENT}`, payload: BODY },
  { method: 'POST', url: `/knowledge/documents/${DOCUMENT}/submit` },
  { method: 'POST', url: `/knowledge/documents/${DOCUMENT}/reject`, payload: { reason: 'Needs revision' } },
  { method: 'POST', url: `/knowledge/documents/${DOCUMENT}/archive` },
] as const;

describe('knowledge routes', () => {
  it('enforces the manage/approve permission matrix', async () => {
    const { app, repository } = buildHarness();
    try {
      for (const endpoint of manageEndpoints) {
        const allowed = await app.inject({ ...endpoint, headers: { authorization: 'Bearer manage' } });
        const approveOnly = await app.inject({ ...endpoint, headers: { authorization: 'Bearer approve' } });
        const noPermissions = await app.inject({ ...endpoint, headers: { authorization: 'Bearer none' } });
        expect(allowed.statusCode, `${endpoint.method} ${endpoint.url} for manager`).toBe(endpoint.method === 'POST' && endpoint.url === '/knowledge/documents' ? 201 : 200);
        expect(approveOnly.statusCode, `${endpoint.method} ${endpoint.url} for approver`).toBe(403);
        expect(noPermissions.statusCode, `${endpoint.method} ${endpoint.url} without permissions`).toBe(403);
      }
      const managerApprove = await app.inject({
        method: 'POST',
        url: `/knowledge/documents/${DOCUMENT}/approve`,
        headers: { authorization: 'Bearer manage' },
      });
      const reviewerApprove = await app.inject({
        method: 'POST',
        url: `/knowledge/documents/${DOCUMENT}/approve`,
        headers: { authorization: 'Bearer approve' },
      });
      expect(managerApprove.statusCode).toBe(403);
      expect(reviewerApprove.statusCode).toBe(200);
      expect(repository.approve).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('surfaces the four-eyes approver conflict as HTTP 409', async () => {
    const approve = vi.fn(async () => {
      throw new Error('knowledge approval requires a distinct approver');
    });
    const { app } = buildHarness(approve);
    try {
      const response = await app.inject({
        method: 'POST',
        url: `/knowledge/documents/${DOCUMENT}/approve`,
        headers: { authorization: 'Bearer both' },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error_code: 'VERSION_CONFLICT' });
    } finally {
      await app.close();
    }
  });

  it('forwards document filters and cursors and creates a new version through PUT', async () => {
    const { app, repository } = buildHarness();
    try {
      const cursor = 'eyJjcmVhdGVkX2F0IjoiMjAyNi0wMS0wMVQwMDowMDowMC4wMDBaIn0';
      const listed = await app.inject({
        method: 'GET',
        url: `/knowledge/documents?namespace=brand&status=APPROVED&q=return&cursor=${cursor}&limit=8`,
        headers: { authorization: 'Bearer manage' },
      });
      expect(listed.statusCode).toBe(200);
      expect(repository.list).toHaveBeenCalledWith(TENANT, {
        namespace: 'brand',
        status: 'APPROVED',
        q: 'return',
        cursor,
        limit: 8,
      });

      const updated = await app.inject({
        method: 'PUT',
        url: `/knowledge/documents/${DOCUMENT}`,
        headers: { authorization: 'Bearer manage' },
        payload: BODY,
      });
      expect(updated.statusCode).toBe(200);
      expect(repository.update).toHaveBeenCalledWith(TENANT, DOCUMENT, expect.objectContaining({
        namespace: 'company',
        type: 'FAQ',
        slug: 'faq',
        title: 'FAQ',
        body: '# Content',
        actor: expect.objectContaining({ actor_id: 'author' }),
      }));
    } finally {
      await app.close();
    }
  });

  it('accepts bounded markdown uploads and rejects oversized or unsupported files', async () => {
    const { app, repository } = buildHarness();
    try {
      const accepted = await app.inject({
        method: 'POST',
        url: '/knowledge/documents',
        headers: { authorization: 'Bearer manage' },
        payload: { namespace: 'company', type: 'FAQ', filename: 'help.md', content: '# help' },
      });
      expect(accepted.statusCode).toBe(201);
      expect(repository.create).toHaveBeenCalledWith(TENANT, expect.objectContaining({ slug: 'help', title: 'help', body: '# help' }));

      const oversized = await app.inject({
        method: 'POST',
        url: '/knowledge/documents',
        headers: { authorization: 'Bearer manage' },
        payload: { namespace: 'company', type: 'FAQ', filename: 'help.txt', content: 'x'.repeat(65_537) },
      });
      const unsupported = await app.inject({
        method: 'POST',
        url: '/knowledge/documents',
        headers: { authorization: 'Bearer manage' },
        payload: { namespace: 'company', type: 'FAQ', filename: 'help.pdf', content: 'no' },
      });
      expect(oversized.statusCode).toBe(400);
      expect(unsupported.statusCode).toBe(400);
      expect(repository.create).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
