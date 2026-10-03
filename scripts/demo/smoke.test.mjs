import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { runDemoPreflight } from './preflight.mjs';
import { runDemoSmoke, validateDemoSmokeEnvironment } from './smoke.mjs';

const OFFLINE_ENV = Object.freeze({
  APP_ENV: 'local',
  DEMO_PROVIDER_MODE: 'offline',
  DEMO_MODE: 'true',
  DEMO_TENANT_ID: '99999999-9999-4999-8999-999999999999',
  DEMO_COMPANY_ADMIN_EMAIL: 'admin@novamart.demo',
  DEMO_COMPANY_ADMIN_PASSWORD: 'company-password',
  DEMO_PLATFORM_ADMIN_EMAIL: 'admin@agentos.demo',
  DEMO_PLATFORM_ADMIN_PASSWORD: 'platform-password',
  TENANT_COOKIE_HMAC_KEY: 'tenant-cookie-key-that-is-at-least-32-bytes',
  PLATFORM_COOKIE_HMAC_KEY: 'platform-cookie-key-that-is-at-least-32-bytes',
  DATABASE_URL: 'postgresql://localhost:5432/agentos_dev',
  MOCK_SECRET_KEY: 'mock-secret',
  MOCK_ERP_ENABLED: 'true',
  ERP_API_BASE_URL: 'http://localhost:8081/api/v1',
  DEMO_WIDGET_ORIGINS: 'http://localhost:3000',
});

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function smokeFetch(task) {
  let taskPolls = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    const path = url.pathname.slice('/api/v1'.length);

    if (path === '/demo/login') {
      const { audience } = JSON.parse(init.body);
      return jsonResponse({
        access_token: `${audience}-token`,
        membership: {
          tenant_id: '99999999-9999-4999-8999-999999999999',
          scope: audience,
        },
        permissions: audience === 'company'
          ? ['approval:decide', 'campaign:draft', 'conversation:read', 'campaign:read', 'settings:read', 'customer:read', 'run:read']
          : [],
      });
    }
    if (path === '/demo/widget-session') return jsonResponse({ access_token: 'widget-token' });
    if (path === '/demo/catalog') return jsonResponse({ items: [{ sku: 'laptop-1' }] });
    if (path === '/demo/readiness') {
      return jsonResponse({ demo_mode: true, provider: { configured: false, probe: 'not_required' } });
    }
    if (path === '/storefront/stream') {
      const turn = JSON.parse(init.body);
      assert.match(turn.idempotency_key, /^demo-smoke-offline-[0-9a-f-]+-sales$/);
      return new Response(`${JSON.stringify({ task_id: 'task-sales', correlation_id: 'corr-sales' })}\n`);
    }
    if (path === '/tasks/task-sales') {
      taskPolls += 1;
      return jsonResponse(task);
    }
    if (path === '/conversations' || path === '/approvals') return jsonResponse({ items: [] });
    throw new Error(`Unexpected smoke request: ${init.method ?? 'GET'} ${url.pathname}`);
  };
  return { fetchImpl, taskPollCount: () => taskPolls };
}

describe('demo smoke profile gates', () => {
  it('accepts offline execution without live provider credentials', async () => {
    assert.deepEqual(validateDemoSmokeEnvironment({ ...OFFLINE_ENV }), { profile: 'offline' });
    const result = await runDemoPreflight({ ...OFFLINE_ENV });
    assert.equal(result.profile, 'offline');
    assert.equal(result.provider, 'not_required');
  });
  it('rejects malformed account emails and undersized cookie keys', async () => {
    await assert.rejects(
      runDemoPreflight({ ...OFFLINE_ENV, DEMO_COMPANY_ADMIN_EMAIL: 'not-an-email' }),
      /DEMO_PREFLIGHT_FAILED: DEMO_COMPANY_ADMIN_EMAIL must look like an email address/,
    );
    await assert.rejects(
      runDemoPreflight({ ...OFFLINE_ENV, TENANT_COOKIE_HMAC_KEY: 'short' }),
      /DEMO_PREFLIGHT_FAILED: TENANT_COOKIE_HMAC_KEY must be at least 32 bytes/,
    );
  });

  it('fails live acceptance closed when provider credentials are absent', () => {
    assert.throws(
      () => validateDemoSmokeEnvironment({ ...OFFLINE_ENV, DEMO_PROVIDER_MODE: 'live' }, 'live'),
      /live acceptance requires OPENAI_API_KEY, OPENAI_BASE_URL, PRIMARY_REASONING_MODEL/,
    );
  });

  it('requires provider credentials in live preflight while retaining offline compatibility', async () => {
    await assert.rejects(
      runDemoPreflight({ ...OFFLINE_ENV, DEMO_PROVIDER_MODE: 'live' }, 'live'),
      /DEMO_PREFLIGHT_FAILED: OPENAI_API_KEY is required/,
    );
    const result = await runDemoPreflight({
      ...OFFLINE_ENV,
      DEMO_PROVIDER_MODE: 'live',
      OPENAI_API_KEY: 'provider-key',
      OPENAI_BASE_URL: 'https://provider.invalid/v1',
      PRIMARY_REASONING_MODEL: 'reasoning-model',
    }, 'live');
    assert.equal(result.profile, 'live');
    assert.equal(result.provider, 'required');
  });

});
describe('demo smoke task outcomes', () => {
  const env = { ...OFFLINE_ENV, DEMO_API_URL: 'https://demo.example.test' };

  it('fails when an admitted task fails and reports its sanitized error code', async () => {
    const { fetchImpl } = smokeFetch({
      task_id: 'task-sales',
      status: 'failed',
      error: { code: 'R1', class: 'FATAL' },
    });
    await assert.rejects(
      runDemoSmoke(env, { fetchImpl }),
      /sales task ended failed; error code R1/,
    );
  });

  it('passes only when the task completes with an agent message', async () => {
    const mock = smokeFetch({
      task_id: 'task-sales',
      status: 'completed',
      answer: 'A suitable laptop is available.',
      error: null,
    });
    const result = await runDemoSmoke(env, { fetchImpl: mock.fetchImpl });

    assert.equal(mock.taskPollCount(), 1);
    assert.equal(result.agents.sales.outcome, 'completed');
    assert.equal(result.agents.sales.agent_message, true);
    assert.match(result.run_marker, /^demo-smoke-offline-[0-9a-f-]{36}$/);
  });
});
