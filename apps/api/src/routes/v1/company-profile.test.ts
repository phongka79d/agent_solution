import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { correlationIdOf, replyFailure } from '../../gateway/http.js';
import type { CompanyProfileRecord, GatewayRuntime } from '../../gateway/ports.js';
import { createCredentialStore } from '../../gateway/principal.js';
import { registerCompanyProfileRoutes } from './company-profile.js';

const TENANT = 'tenant-a';
const READ_TOKEN = 'profile-read-token';
const WRITE_TOKEN = 'profile-write-token';
const PROFILE: CompanyProfileRecord = {
  tenant_id: TENANT,
  company_name: 'Acme',
  industry: null,
  locale: 'en-US',
  timezone: 'America/New_York',
  currency: 'USD',
  brand_profile: { voice: 'Helpful', logo_url: 'https://example.com/logo.svg' },
  version: 3,
  updated_at: '2026-01-01T00:00:00.000Z',
};

const VALUES = {
  company_name: 'Acme Updated',
  industry: null,
  locale: 'en-US',
  timezone: 'America/New_York',
  currency: 'USD',
  brand_profile: { voice: 'Helpful', logo_url: 'https://example.com/logo.svg' },
};

function buildHarness(updateResult: unknown = { status: 'UPDATED', profile: { ...PROFILE, ...VALUES, version: 4 } }) {
  const get = vi.fn(async () => PROFILE);
  const update = vi.fn(async () => updateResult as never);
  const runtime = {
    companyProfile: { get, update },
    audit: { record: vi.fn(async () => undefined) },
    ids: () => 'corr-company-profile-test',
  } as unknown as GatewayRuntime;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => replyFailure(reply, error, correlationIdOf(request, runtime)));
  registerCompanyProfileRoutes(app, {
    runtime,
    credentials: createCredentialStore({
      operators: [
        { token: READ_TOKEN, tenant_id: TENANT, operator_id: 'reader', permissions: ['run:read'] },
        { token: WRITE_TOKEN, tenant_id: TENANT, operator_id: 'writer', permissions: ['settings:manage'] },
      ],
      sessions: [],
      widgets: [],
    }),
  });
  return { app, get, update };
}

function putHeaders(token = WRITE_TOKEN, version = '3') {
  return { authorization: `Bearer ${token}`, 'if-match': version };
}

describe('company profile settings API', () => {
  it('allows any company operator to read and requires settings:manage to write', async () => {
    const { app, get, update } = buildHarness();
    try {
      const read = await app.inject({ method: 'GET', url: '/company/settings/profile', headers: { authorization: `Bearer ${READ_TOKEN}` } });
      const denied = await app.inject({
        method: 'PUT',
        url: '/company/settings/profile',
        headers: putHeaders(READ_TOKEN),
        payload: VALUES,
      });
      expect(read.statusCode).toBe(200);
      expect(read.headers.etag).toBe('"3"');
      expect(denied.statusCode).toBe(403);
      expect(get).toHaveBeenCalledTimes(1);
      expect(update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 400 for invalid locale, timezone, currency, name, and non-HTTPS brand URLs', async () => {
    const { app, update } = buildHarness();
    const invalid = [
      { ...VALUES, company_name: '  ' },
      { ...VALUES, locale: 'not a locale!' },
      { ...VALUES, timezone: 'Mars/Olympus_Mons' },
      { ...VALUES, currency: 'ZZZ' },
      { ...VALUES, brand_profile: { logo_url: 'http://example.com/logo.svg' } },
    ];
    try {
      for (const payload of invalid) {
        const response = await app.inject({
          method: 'PUT',
          url: '/company/settings/profile',
          headers: putHeaders(),
          payload,
        });
        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ error_code: 'VALIDATION_FAILED' });
      }
      expect(update).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('returns 409 VERSION_CONFLICT for a stale If-Match version', async () => {
    const { app, update } = buildHarness({ status: 'VERSION_CONFLICT', current_version: 4 });
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/company/settings/profile',
        headers: putHeaders(WRITE_TOKEN, '"2"'),
        payload: VALUES,
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ error_code: 'VERSION_CONFLICT' });
      expect(update).toHaveBeenCalledWith(expect.objectContaining({ expected_version: 2, tenant_id: TENANT }));
    } finally {
      await app.close();
    }
  });
});
