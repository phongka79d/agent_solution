import { randomUUID } from 'node:crypto';

import { waitTask as pollTask } from '../../../scripts/demo/lib/wait-task.mjs';
import { readStackState } from './stack.mjs';

const TASK_TIMEOUT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 15_000;

export function apiV1Url() {
  const base = readStackState().apiUrl.replace(/\/+$/, '');
  return base.endsWith('/api/v1') ? base : `${base}/api/v1`;
}

export async function requestApi(path, { method = 'GET', token, headers = {}, body, fetchImpl = globalThis.fetch } = {}) {
  const requestHeaders = { accept: 'application/json', ...headers };
  if (token) requestHeaders.authorization = `Bearer ${token}`;
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';
  const response = await fetchImpl(`${apiV1Url()}/${path.replace(/^\/+/, '')}`, {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    // The caller reports the HTTP status when an endpoint does not return JSON.
  }
  return { response, body: responseBody };
}

/**
 * DB-auth sessions are reused per identity within one test process: the login limiter
 * (attempts per IP+email per window) would otherwise refuse the suite's many logins.
 */
const dbSessions = new Map();

export async function login(audience, {
  authProvider = process.env.STACK_AUTH_PROVIDER ?? 'demo',
  as: account = 'primary',
} = {}) {
  if (audience !== 'company' && audience !== 'platform') {
    throw new TypeError('audience must be company or platform');
  }
  if (authProvider !== 'demo' && authProvider !== 'db') {
    throw new TypeError('authProvider must be demo or db');
  }
  if (account !== 'primary' && account !== 'second') {
    throw new TypeError('account must be primary or second');
  }
  if (account === 'second' && (audience !== 'company' || authProvider !== 'db')) {
    throw new TypeError('the second company account is available only in db-auth mode');
  }
  const prefix = audience === 'company' ? 'DEMO_COMPANY_ADMIN' : 'DEMO_PLATFORM_ADMIN';
  const credentials = authProvider === 'db'
    ? readStackState().auth?.[account === 'second' ? 'secondCompany' : audience]
    : { email: process.env[`${prefix}_EMAIL`], password: process.env[`${prefix}_PASSWORD`] };
  if (typeof credentials?.email !== 'string' || typeof credentials?.password !== 'string') {
    throw new Error(`stack ${account === 'second' ? 'second company' : audience} login credentials are missing`);
  }
  const cacheKey = `${audience}:${account}`;
  if (authProvider === 'db' && dbSessions.has(cacheKey)) return dbSessions.get(cacheKey);
  const path = authProvider === 'db' ? 'auth/login' : 'demo/login';
  const { response, body } = await requestApi(path, {
    method: 'POST',
    body: { email: credentials.email, password: credentials.password, audience },
  });
  if (!response.ok || typeof body?.access_token !== 'string' || body.membership?.scope !== audience) {
    throw new Error(`stack ${audience} login returned HTTP ${response.status}`);
  }
  if (authProvider === 'db') dbSessions.set(cacheKey, body);
  return body;
}

export async function turn(widget, message) {
  if (typeof widget?.access_token !== 'string' || typeof widget?.origin !== 'string') {
    throw new TypeError('widget must contain access_token and origin');
  }
  const response = await globalThis.fetch(`${apiV1Url()}/storefront/stream`, {
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
  if (!response.ok) throw new Error(`storefront turn returned HTTP ${response.status}`);
  if (!response.body) throw new Error('storefront turn response has no stream body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let firstLine = '';
  try {
    while (!firstLine.includes('\n')) {
      const { value, done } = await reader.read();
      if (done) break;
      firstLine += decoder.decode(value, { stream: true });
      if (firstLine.length > 16_384) throw new Error('storefront receipt exceeded the expected size');
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  let receipt;
  try {
    receipt = JSON.parse(firstLine.split(/\r?\n/, 1)[0]);
  } catch {
    throw new Error('storefront stream did not begin with a JSON receipt');
  }
  if (typeof receipt?.task_id !== 'string' || typeof receipt?.conversation_id !== 'string') {
    throw new Error('storefront receipt omitted task_id or conversation_id');
  }
  return { task_id: receipt.task_id, conversation_id: receipt.conversation_id };
}

export async function waitTask(task_id, terminal) {
  const operator = await login('company');
  return pollTask({
    baseUrl: readStackState().apiUrl,
    token: operator.access_token,
    taskId: task_id,
    terminalStates: Array.isArray(terminal) ? terminal : [terminal],
    timeoutMs: TASK_TIMEOUT_MS,
  });
}

export async function messages(operatorToken, conversation_id) {
  const { response, body } = await requestApi(
    `conversations/${encodeURIComponent(conversation_id)}/messages`,
    { token: operatorToken },
  );
  if (!response.ok || !Array.isArray(body?.items)) {
    throw new Error(`conversation messages returned HTTP ${response.status}`);
  }
  return body.items;
}
