#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

import { isMainModule } from './lib/main-module.mjs';
import { waitTask } from './lib/wait-task.mjs';

const TENANT_ID = '99999999-9999-4999-8999-999999999999';
const TERMINAL_TASK_STATES = Object.freeze(['awaiting_human', 'completed', 'failed', 'stopped']);
const TASK_TIMEOUT_MS = 120_000;

const AUTH_ENV_KEYS = Object.freeze([
  'DEMO_COMPANY_ADMIN_EMAIL',
  'DEMO_COMPANY_ADMIN_PASSWORD',
  'DEMO_PLATFORM_ADMIN_EMAIL',
  'DEMO_PLATFORM_ADMIN_PASSWORD',
]);

function apiV1Base(env) {
  const raw = (env.DEMO_API_URL ?? env.API_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('DEMO_SMOKE_FAILED: DEMO_API_URL or API_BASE_URL is required');
  return raw.endsWith('/api/v1') ? raw : `${raw}/api/v1`;
}

function requiredValue(env, key) {
  if (typeof env[key] !== 'string' || env[key].trim() === '') return false;
  return true;
}

/**
 * Validate only the inputs the selected smoke can truthfully use.
 *
 * Offline mode deliberately does not require an LLM credential or a database URL. It exercises
 * deterministic gateway paths and reports the provider as not exercised. Live mode is a separate
 * acceptance gate: it refuses to start until the provider, credentials and durable database binding
 * are all present.
 */
export function validateDemoSmokeEnvironment(env, profile = 'offline') {
  if (env.DEMO_MODE !== 'true' || !['local', 'ci'].includes(env.APP_ENV)) {
    throw new Error('DEMO_SMOKE_FAILED: DEMO_MODE=true and APP_ENV=local|ci are required');
  }
  if (!['offline', 'live'].includes(profile)) {
    throw new Error(`DEMO_SMOKE_FAILED: unsupported smoke profile ${profile}`);
  }
  if (env.DEMO_PROVIDER_MODE !== profile) {
    throw new Error(`DEMO_SMOKE_FAILED: DEMO_PROVIDER_MODE=${profile} is required for the ${profile} profile`);
  }
  if (env.DEMO_TENANT_ID !== undefined && env.DEMO_TENANT_ID !== TENANT_ID) {
    throw new Error('DEMO_SMOKE_FAILED: DEMO_TENANT_ID is not the canonical NovaMart tenant');
  }
  for (const key of AUTH_ENV_KEYS) {
    if (!requiredValue(env, key)) throw new Error(`DEMO_SMOKE_FAILED: ${key} is required`);
  }
  if (profile === 'live') {
    const requiredLive = ['DATABASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'PRIMARY_REASONING_MODEL'];
    const missing = requiredLive.filter((key) => !requiredValue(env, key));
    if (missing.length > 0) {
      throw new Error(`DEMO_SMOKE_FAILED: live acceptance requires ${missing.join(', ')}`);
    }
  }
  return { profile };
}

async function json(response) {
  try { return await response.json(); } catch { return null; }
}

async function request(base, path, init = {}, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(`${base}/${path.replace(/^\/+/, '')}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  return { response, body: await json(response) };
}

async function login(base, email, password, audience, fetchImpl) {
  const { response, body } = await request(base, 'demo/login', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, audience }),
  }, fetchImpl);
  if (
    !response.ok
    || !body
    || typeof body.access_token !== 'string'
    || body.membership?.tenant_id !== TENANT_ID
    || body.membership?.scope !== audience
  ) {
    throw new Error(`DEMO_SMOKE_FAILED: ${audience} login returned HTTP ${response.status}`);
  }
  return body;
}

async function readFirstStreamChunk(response) {
  if (!response.body) throw new Error('DEMO_SMOKE_FAILED: storefront stream has no body');
  const reader = response.body.getReader();
  try {
    const { value, done } = await reader.read();
    if (done || !value || value.byteLength === 0) throw new Error('DEMO_SMOKE_FAILED: storefront stream emitted no receipt');
    return new TextDecoder().decode(value).slice(0, 1024);
  } finally {
    await reader.cancel();
  }
}

function receiptFromChunk(chunk, label) {
  const firstLine = chunk.split(/\r?\n/, 1)[0] ?? '';
  let receipt;
  try { receipt = JSON.parse(firstLine); } catch {
    throw new Error(`DEMO_SMOKE_FAILED: ${label} stream did not emit a JSON receipt`);
  }
  if (!receipt || typeof receipt.task_id !== 'string' || typeof receipt.correlation_id !== 'string') {
    throw new Error(`DEMO_SMOKE_FAILED: ${label} stream emitted an incomplete receipt`);
  }
  return receipt;
}

async function streamTurn(base, widgetToken, origin, input, label, fetchImpl) {
  const stream = await fetchImpl(`${base}/storefront/stream`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${widgetToken}`,
      origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(15_000),
  });
  if (!stream.ok) {
    const detail = await stream.text().catch(() => '');
    throw new Error(`DEMO_SMOKE_FAILED: ${label} storefront stream HTTP ${stream.status} ${detail.slice(0, 300)}`);
  }
  return receiptFromChunk(await readFirstStreamChunk(stream), label);
}
async function pollTask(base, token, taskId, fetchImpl) {
  return waitTask({
    baseUrl: base,
    token,
    taskId,
    terminalStates: TERMINAL_TASK_STATES,
    timeoutMs: TASK_TIMEOUT_MS,
    fetchImpl,
  });
}

function assertTaskOutcome(task, label, expectedStatus, requireAgentMessage = false) {
  const errorCode = typeof task.error?.code === 'string' && task.error.code.length > 0
    ? task.error.code
    : 'unknown';
  if (task.status !== expectedStatus) {
    throw new Error(
      `DEMO_SMOKE_FAILED: ${label} task ended ${task.status}; error code ${errorCode}`,
    );
  }
  if (requireAgentMessage && (typeof task.answer !== 'string' || task.answer.trim().length === 0)) {
    throw new Error(
      `DEMO_SMOKE_FAILED: ${label} task completed without an agent message; error code ${errorCode}`,
    );
  }
}


function readinessSnapshot(body, profile) {
  if (!body || body.demo_mode !== true || typeof body.provider !== 'object' || body.provider === null) {
    throw new Error(`DEMO_SMOKE_FAILED: ${profile} readiness did not return an observed provider projection`);
  }
  if (profile === 'live') {
    if (body.provider.configured !== true || typeof body.provider.provider !== 'string') {
      throw new Error('DEMO_SMOKE_FAILED: live readiness does not prove a configured provider');
    }
    if (body.ledger?.status !== 'OBSERVED') {
      throw new Error('DEMO_SMOKE_FAILED: live readiness did not observe the durable database ledger');
    }
  }
  return body;
}

async function runFlow(env, profile, fetchImpl = globalThis.fetch) {
  validateDemoSmokeEnvironment(env, profile);
  const runMarker = `demo-smoke-${profile}-${randomUUID()}`;

  const base = apiV1Base(env);
  const origin = (env.DEMO_WIDGET_ORIGINS ?? 'http://localhost:3000').split(',')[0].trim();
  const companySession = await login(
    base,
    env.DEMO_COMPANY_ADMIN_EMAIL,
    env.DEMO_COMPANY_ADMIN_PASSWORD,
    'company',
    fetchImpl,
  );
  const platformSession = await login(
    base,
    env.DEMO_PLATFORM_ADMIN_EMAIL,
    env.DEMO_PLATFORM_ADMIN_PASSWORD,
    'platform',
    fetchImpl,
  );
  if (
    !Array.isArray(companySession.permissions)
    || !companySession.permissions.includes('approval:decide')
    || !companySession.permissions.includes('campaign:draft')
    || companySession.permissions.some((permission) => String(permission).startsWith('platform:'))
  ) {
    throw new Error('DEMO_SMOKE_FAILED: company session must hold company-admin authority and no platform authority');
  }
  if (platformSession.membership.scope !== 'platform') {
    throw new Error('DEMO_SMOKE_FAILED: platform session must have platform scope');
  }
  const companyToken = companySession.access_token;
  const platformToken = platformSession.access_token;
  const auth = (token) => ({ accept: 'application/json', authorization: `Bearer ${token}` });
  const apiRequest = (path, init) => request(base, path, init, fetchImpl);

  const widget = await apiRequest('demo/widget-session', {
    method: 'POST',
    headers: { ...auth(companyToken), origin, 'content-type': 'application/json' },
    body: JSON.stringify({ persona: 'C05' }),
  });
  if (!widget.response.ok || typeof widget.body?.access_token !== 'string') {
    throw new Error(`DEMO_SMOKE_FAILED: widget mint HTTP ${widget.response.status}`);
  }
  const widgetToken = widget.body.access_token;

  const catalog = await apiRequest('demo/catalog', { headers: auth(companyToken) });
  if (!catalog.response.ok || !Array.isArray(catalog.body?.items) || catalog.body.items.length === 0) {
    throw new Error(`DEMO_SMOKE_FAILED: catalog HTTP ${catalog.response.status}`);
  }

  const readinessBefore = readinessSnapshot(
    (await apiRequest('demo/readiness', { headers: auth(platformToken) })).body,
    profile,
  );

  const salesReceipt = await streamTurn(base, widgetToken, origin, {
    message: 'I need a laptop under 20 million VND for graphic design.',
    idempotency_key: `${runMarker}-sales`,
    module: 'sales',
  }, 'sales', fetchImpl);
  // Widget tokens are origin-bound; the operator reads the task like the console does (run:read).
  const salesTask = await pollTask(base, companyToken, salesReceipt.task_id, fetchImpl);
  assertTaskOutcome(salesTask, 'sales', 'completed', true);

  let careReceipt = null;
  let careTask = null;
  if (profile === 'live') {
    careReceipt = await streamTurn(base, widgetToken, origin, {
      message: 'What is your return policy for an order delivered last week?',
      idempotency_key: `${runMarker}-care`,
      module: 'support',
    }, 'care', fetchImpl);
    careTask = await pollTask(base, companyToken, careReceipt.task_id, fetchImpl);
    assertTaskOutcome(careTask, 'care', 'completed', true);
  }

  const conversations = await apiRequest('conversations?limit=20', { headers: auth(companyToken) });
  if (!conversations.response.ok) throw new Error(`DEMO_SMOKE_FAILED: conversations HTTP ${conversations.response.status}`);

  let campaign = null;
  let campaignTask = null;
  let approval = null;
  if (profile === 'live') {
    const idempotencyKey = `${runMarker}-marketing`;
    // Segments are tenant data offered by the API (T1.9); a draft names one of them, never a made-up id.
    const segments = await apiRequest('campaigns/segments', { headers: auth(companyToken) });
    const segmentList = Array.isArray(segments.body?.segments) ? segments.body.segments : [];
    const segmentId = (segmentList.find((segment) => segment.segment_id === 'inactive_90d') ?? segmentList[0])?.segment_id;
    if (!segments.response.ok || typeof segmentId !== 'string') {
      throw new Error(`DEMO_SMOKE_FAILED: campaign segments HTTP ${segments.response.status}`);
    }
    campaign = await apiRequest('campaigns/drafts', {
      method: 'POST',
      headers: { ...auth(companyToken), 'content-type': 'application/json', 'x-idempotency-key': idempotencyKey },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        name: `Demo smoke win-back ${Date.now().toString(36).toUpperCase()}`,
        segment_id: segmentId,
        objective: 'winback',
        instruction: 'Create a tenant-scoped reactivation draft for the inactive segment.',
      }),
    });
    if (!campaign.response.ok || typeof campaign.body?.task_id !== 'string') {
      throw new Error(`DEMO_SMOKE_FAILED: marketing draft HTTP ${campaign.response.status}`);
    }
    campaignTask = await pollTask(base, companyToken, campaign.body.task_id, fetchImpl);
    assertTaskOutcome(campaignTask, 'marketing', 'awaiting_human');

    const approvals = await apiRequest('approvals?status=PENDING&limit=100', {
      headers: auth(companyToken),
    });
    if (!approvals.response.ok || !Array.isArray(approvals.body?.items)) {
      throw new Error(`DEMO_SMOKE_FAILED: approvals HTTP ${approvals.response.status}`);
    }
    approval = approvals.body.items.find((item) =>
      item?.run_id === campaign.body.task_id && item.status === 'PENDING',
    ) ?? null;
    if (!approval) {
      throw new Error('DEMO_SMOKE_FAILED: marketing task is awaiting human review without a pending approval row');
    }
  } else {
    const approvals = await apiRequest('approvals?status=PENDING&limit=100', { headers: auth(companyToken) });
    if (!approvals.response.ok) {
      throw new Error(`DEMO_SMOKE_FAILED: approvals HTTP ${approvals.response.status}`);
    }
  }

  const readinessAfter = readinessSnapshot(
    (await apiRequest('demo/readiness', { headers: auth(platformToken) })).body,
    profile,
  );
  const providerCalls =
    typeof readinessAfter.ledger?.provider_call_count === 'number'
      ? readinessAfter.ledger.provider_call_count
      : null;

  return {
    profile,
    run_marker: runMarker,
    tenant_id: TENANT_ID,
    catalog_items: catalog.body.items.length,
    provider: profile === 'offline'
      ? { status: 'not_exercised', readiness: readinessAfter.provider?.probe ?? 'unknown' }
      : {
        status: 'exercised',
        provider: readinessAfter.provider.provider,
        readiness: readinessAfter.provider.probe,
        provider_calls_observed: providerCalls,
      },
    agents: {
      sales: { outcome: 'completed', task_id: salesReceipt.task_id, agent_message: true },
      care: profile === 'live'
        ? { outcome: 'completed', task_id: careReceipt.task_id, agent_message: true }
        : { outcome: 'not_exercised_offline' },
      marketing: profile === 'live'
        ? {
          outcome: 'awaiting_human',
          task_id: campaign.body.task_id,
          approval_id: approval.approval_id,
        }
        : { outcome: 'not_exercised_offline' },
    },
    readiness_before: readinessBefore.ledger?.status ?? 'unknown',
    conversations: 'observed',
    approvals: 'observed',
  };
}

/** Deterministic demo smoke: no live provider is called and no live success is claimed. */
export async function runDemoSmoke(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  return runFlow(env, 'offline', fetchImpl);
}

/** Provider-enabled acceptance: missing provider/auth/database prerequisites fail before requests. */
export async function runDemoLiveSmoke(env = process.env, { fetchImpl = globalThis.fetch } = {}) {
  return runFlow(env, 'live', fetchImpl);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  const live = process.argv.includes('--live');
  const offline = process.argv.includes('--offline') || !live;
  const run = live && !offline ? runDemoLiveSmoke : runDemoSmoke;
  run().then((result) => {
    const label = live && !offline ? 'live smoke passed' : 'offline smoke passed (live provider not exercised)';
    console.log(`NovaMart demo ${label}: ${JSON.stringify(result)}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : 'DEMO_SMOKE_FAILED');
    process.exitCode = 1;
  });
}
