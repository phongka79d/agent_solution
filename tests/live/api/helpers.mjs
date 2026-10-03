import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { waitTask as pollTask } from '../../../scripts/demo/lib/wait-task.mjs';
import { assertBudgetAvailable, recordLiveLlmCalls } from '../../../scripts/live/budget.mjs';

export { assertBudgetAvailable };

const REQUEST_TIMEOUT_MS = 20_000;
const TASK_TIMEOUT_MS = 240_000;
const USAGE_FROM = new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString();
const USAGE_TO = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
const TERMINAL_STATES = ['awaiting_human', 'completed', 'failed', 'stopped'];

function apiOrigin(env = process.env) {
  const raw = env.DEMO_API_URL ?? env.API_BASE_URL;
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error('LIVE_API_CONFIGURATION_MISSING');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('LIVE_API_URL_INVALID');
  }
  if (
    url.protocol !== 'http:'
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
    || !['/', '/api/v1'].includes(url.pathname)
  ) {
    throw new Error('LIVE_API_URL_MUST_BE_LOOPBACK');
  }
  return url.toString().replace(/\/+$/, '');
}

export function apiV1Url(env = process.env) {
  const base = apiOrigin(env);
  return base.endsWith('/api/v1') ? base : `${base}/api/v1`;
}

export async function requestApi(path, { method = 'GET', token, headers = {}, body, env = process.env } = {}) {
  const requestHeaders = { accept: 'application/json', ...headers };
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  const response = await fetch(`${apiV1Url(env)}/${path.replace(/^\/+/, '')}`, {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    // Callers use the status code; response bodies can contain provider details.
  }
  return { response, body: responseBody };
}

export async function login(audience, env = process.env) {
  assert.ok(audience === 'company' || audience === 'platform', 'audience must be company or platform');
  const prefix = audience === 'company' ? 'DEMO_COMPANY_ADMIN' : 'DEMO_PLATFORM_ADMIN';
  const email = env[`${prefix}_EMAIL`];
  const password = env[`${prefix}_PASSWORD`];
  if (!email || !password) throw new Error(`LIVE_LOGIN_CONFIGURATION_MISSING: ${prefix}`);
  const { response, body } = await requestApi('demo/login', {
    method: 'POST',
    body: { email, password, audience },
    env,
  });
  if (!response.ok || typeof body?.access_token !== 'string' || body.membership?.scope !== audience) {
    throw new Error(`LIVE_LOGIN_FAILED: ${audience} login returned HTTP ${response.status}`);
  }
  return body;
}

function widgetOrigin(env) {
  const configured = env.DEMO_WIDGET_ORIGINS?.split(',')[0]?.trim() || env.WEB_BASE_URL;
  if (!configured) throw new Error('LIVE_WIDGET_ORIGIN_MISSING');
  let url;
  try {
    url = new URL(configured);
  } catch {
    throw new Error('LIVE_WIDGET_ORIGIN_INVALID');
  }
  if (
    url.protocol !== 'http:'
    || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username !== ''
    || url.password !== ''
    || url.pathname !== '/'
    || url.search !== ''
    || url.hash !== ''
  ) {
    throw new Error('LIVE_WIDGET_ORIGIN_MUST_BE_LOOPBACK');
  }
  return url.origin;
}

export async function mintWidget(companyToken, env = process.env) {
  const origin = widgetOrigin(env);
  const { response, body } = await requestApi('demo/widget-session', {
    method: 'POST',
    token: companyToken,
    headers: { origin },
    body: { persona: 'anonymous' },
    env,
  });
  if (response.status !== 201 || typeof body?.access_token !== 'string' || typeof body?.session_id !== 'string') {
    throw new Error(`LIVE_WIDGET_SESSION_FAILED: API returned HTTP ${response.status}`);
  }
  return { access_token: body.access_token, session_id: body.session_id, origin };
}

export async function turn(widget, message, env = process.env) {
  assert.ok(typeof widget?.access_token === 'string' && typeof widget?.origin === 'string', 'widget credentials are incomplete');
  const response = await fetch(`${apiV1Url(env)}/storefront/stream`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${widget.access_token}`,
      origin: widget.origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ message, idempotency_key: randomUUID() }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`LIVE_TURN_FAILED: API returned HTTP ${response.status}`);
  if (!response.body) throw new Error('LIVE_TURN_FAILED: storefront response has no stream body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let firstLine = '';
  try {
    while (!firstLine.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      firstLine += decoder.decode(value, { stream: true });
      if (firstLine.length > 16_384) throw new Error('LIVE_TURN_FAILED: storefront receipt exceeded its limit');
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  let receipt;
  try {
    receipt = JSON.parse(firstLine.split(/\r?\n/, 1)[0]);
  } catch {
    throw new Error('LIVE_TURN_FAILED: storefront stream did not begin with a JSON receipt');
  }
  if (typeof receipt?.task_id !== 'string' || typeof receipt?.conversation_id !== 'string') {
    throw new Error('LIVE_TURN_FAILED: storefront receipt omitted task or conversation identifiers');
  }
  return { task_id: receipt.task_id, conversation_id: receipt.conversation_id };
}

export async function waitTask(token, taskId, terminalStates = TERMINAL_STATES, env = process.env) {
  return pollTask({
    baseUrl: apiOrigin(env),
    token,
    taskId,
    terminalStates,
    timeoutMs: TASK_TIMEOUT_MS,
  });
}

async function usageTotals(platformToken, tenantId, expectedDomain, env) {
  const query = new URLSearchParams({ from: USAGE_FROM, to: USAGE_TO });
  const { response, body } = await requestApi(`platform/usage?${query}`, { token: platformToken, env });
  assert.equal(response.status, 200, `platform usage returned HTTP ${response.status}`);
  assert.ok(Array.isArray(body?.items), 'platform usage omitted items');
  const rows = body.items.filter((item) => item.tenant_id === tenantId && item.domain === expectedDomain);
  return {
    calls: rows.reduce((total, item) => total + item.record_count, 0),
    tokens: rows.reduce((total, item) => total + item.tokens_total, 0),
  };
}

export async function assertUsageRecorded(platformToken, tenantId, expectedDomain, before, env = process.env) {
  const deadline = Date.now() + 30_000;
  let after;
  do {
    after = await usageTotals(platformToken, tenantId, expectedDomain, env);
    if (after.calls > before.calls && after.tokens > before.tokens) {
      await recordLiveLlmCalls(after.calls - before.calls);
      return after;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  assert.ok(
    after.calls > before.calls && after.tokens > before.tokens,
    `platform/usage did not record a token-bearing ${expectedDomain} LLM call`,
  );
  return after;
}

export async function usageBefore(platformToken, tenantId, expectedDomain, env = process.env) {
  return usageTotals(platformToken, tenantId, expectedDomain, env);
}
