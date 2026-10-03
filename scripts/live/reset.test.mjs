import assert from 'node:assert/strict';
import test from 'node:test';

import { resetTestData } from './reset.mjs';

const TENANT_ID = '99999999-9999-4999-8999-999999999999';
const BASE_ENV = {
  APP_ENV: 'local',
  DEMO_MODE: 'true',
  DEMO_PROVIDER_MODE: 'live',
  DEMO_TENANT_ID: TENANT_ID,
  API_BASE_URL: 'http://127.0.0.1:4000',
  DEMO_COMPANY_ADMIN_EMAIL: 'company-admin@example.test',
  DEMO_COMPANY_ADMIN_PASSWORD: 'test-only-password',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestPath(url) {
  return new URL(url).pathname;
}

test('reset refuses a non-local APP_ENV before making an API request', async () => {
  let requests = 0;
  await assert.rejects(
    resetTestData({
      env: { ...BASE_ENV, APP_ENV: 'production' },
      fetchImpl: async () => {
        requests += 1;
        return jsonResponse({});
      },
    }),
    /LIVE_RESET_FORBIDDEN/,
  );
  assert.equal(requests, 0);
});

test('reset refuses a PRODUCTION tenant before calling the reset endpoint', async () => {
  const paths = [];
  await assert.rejects(
    resetTestData({
      env: BASE_ENV,
      fetchImpl: async (url) => {
        const path = requestPath(url);
        paths.push(path);
        if (path.endsWith('/demo/login')) {
          return jsonResponse({
            access_token: 'operator-token',
            membership: { tenant_id: TENANT_ID, scope: 'company' },
          });
        }
        return jsonResponse({ tenant_id: TENANT_ID, data_class: 'PRODUCTION', enabled: true });
      },
    }),
    /LIVE_RESET_FORBIDDEN/,
  );
  assert.deepEqual(paths, ['/api/v1/demo/login', '/api/v1/testing/status']);
});

test('reset confirms the Test Customer Lab dry run and calls only the TEST reset API', async () => {
  const calls = [];
  const result = await resetTestData({
    env: BASE_ENV,
    fetchImpl: async (url, init) => {
      const path = requestPath(url);
      const body = init.body === undefined ? undefined : JSON.parse(init.body);
      calls.push({ path, method: init.method, body, authorization: init.headers.authorization });
      if (path.endsWith('/demo/login')) {
        return jsonResponse({
          access_token: 'operator-token',
          membership: { tenant_id: TENANT_ID, scope: 'company' },
        });
      }
      if (path.endsWith('/testing/status')) {
        return jsonResponse({ tenant_id: TENANT_ID, data_class: 'DEMO', enabled: true });
      }
      if (body?.dry_run === true) {
        return jsonResponse({ tenant_id: TENANT_ID, dry_run: true, counts: { customers: 2 }, confirm_token: 'dry-run-confirmation' });
      }
      return jsonResponse({ tenant_id: TENANT_ID, dry_run: false, counts: { customers: 0 } });
    },
  });

  assert.deepEqual(result, { counts: { customers: 0 } });
  assert.deepEqual(calls.map(({ path, method }) => [path, method]), [
    ['/api/v1/demo/login', 'POST'],
    ['/api/v1/testing/status', 'GET'],
    ['/api/v1/testing/reset', 'POST'],
    ['/api/v1/testing/reset', 'POST'],
  ]);
  assert.deepEqual(calls[2]?.body, { dry_run: true });
  assert.deepEqual(calls[3]?.body, { dry_run: false, confirm_token: 'dry-run-confirmation' });
  assert.ok(calls.slice(1).every((call) => call.authorization === 'Bearer operator-token'));
});

test('reset refuses a company login outside the configured tenant', async () => {
  await assert.rejects(
    resetTestData({
      env: BASE_ENV,
      fetchImpl: async () => jsonResponse({
        access_token: 'operator-token',
        membership: { tenant_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', scope: 'company' },
      }),
    }),
    /LIVE_RESET_FORBIDDEN/,
  );
});
