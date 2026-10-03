import assert from 'node:assert/strict';
import test from 'node:test';

import { login, requestApi } from './lib/api.mjs';

test('R2 platform usage accepts a bounded time window', async () => {
  const platform = await login('platform');
  const query = new URLSearchParams({ from: '2025-01-01T00:00:00Z', to: '2030-01-01T00:00:00Z' });
  const { response } = await requestApi(`platform/usage?${query}`, { token: platform.access_token });
  assert.equal(response.status, 200, `GET /platform/usage returned HTTP ${response.status}`);
});
