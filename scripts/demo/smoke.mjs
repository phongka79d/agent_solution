#!/usr/bin/env node

import { isMainModule } from './lib/main-module.mjs';
import { stableUuid } from './seed.mjs';

const TENANT_ID = '99999999-9999-4999-8999-999999999999';
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

async function request(base, path, init = {}) {
  const response = await fetch(`${base}/${path.replace(/^\/+/, '')}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(15_000),
  });
  return { response, body: await json(response) };
}

async function login(base, email, password, audience) {
  const { response, body } = await request(base, 'demo/login', {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, audience }),
  });
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

async function streamTurn(base, widgetToken, origin, input, label) {
  const stream = await fetch(`${base}/storefront/stream`, {
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

async function runFlow(env, profile) {
  validateDemoSmokeEnvironment(env, profile);
  const base = apiV1Base(env);
  const origin = (env.DEMO_WIDGET_ORIGINS ?? 'http://localhost:3000').split(',')[0].trim();
  const companySession = await login(
    base,
    env.DEMO_COMPANY_ADMIN_EMAIL,
    env.DEMO_COMPANY_ADMIN_PASSWORD,
    'company',
  );
  const platformSession = await login(
    base,
    env.DEMO_PLATFORM_ADMIN_EMAIL,
    env.DEMO_PLATFORM_ADMIN_PASSWORD,
    'platform',
  );
  if (
    !Array.isArray(companySession.permissions)
    || companySession.permissions.length !== 7
    || !companySession.permissions.includes('approval:decide')
    || !companySession.permissions.includes('campaign:draft')
  ) {
    throw new Error('DEMO_SMOKE_FAILED: company session must expose the seven company-admin permissions');
  }
  if (platformSession.membership.scope !== 'platform') {
    throw new Error('DEMO_SMOKE_FAILED: platform session must have platform scope');
  }
  const companyToken = companySession.access_token;
  const platformToken = platformSession.access_token;
  const auth = (token) => ({ accept: 'application/json', authorization: `Bearer ${token}` });

  const widget = await request(base, 'demo/widget-session', {
    method: 'POST',
    headers: { ...auth(companyToken), origin, 'content-type': 'application/json' },
    body: JSON.stringify({ persona: 'C05' }),
  });
  if (!widget.response.ok || typeof widget.body?.access_token !== 'string') {
    throw new Error(`DEMO_SMOKE_FAILED: widget mint HTTP ${widget.response.status}`);
  }
  const widgetToken = widget.body.access_token;

  const catalog = await request(base, 'demo/catalog', { headers: auth(companyToken) });
  if (!catalog.response.ok || !Array.isArray(catalog.body?.items) || catalog.body.items.length === 0) {
    throw new Error(`DEMO_SMOKE_FAILED: catalog HTTP ${catalog.response.status}`);
  }

  const readinessBefore = readinessSnapshot(
    (await request(base, 'demo/readiness', { headers: auth(platformToken) })).body,
    profile,
  );

  const salesReceipt = await streamTurn(base, widgetToken, origin, {
    message: 'I need a laptop under 20 million VND for graphic design.',
    idempotency_key: `demo-smoke-${profile}-sales-${Date.now()}`,
    module: 'sales',
  }, 'sales');

  let careReceipt = null;
  if (profile === 'live') {
    careReceipt = await streamTurn(base, widgetToken, origin, {
      message: 'What is your return policy for an order delivered last week?',
      idempotency_key: `demo-smoke-${profile}-care-${Date.now()}`,
      module: 'support',
    }, 'care');
  }

  const conversations = await request(base, 'conversations?limit=20', { headers: auth(companyToken) });
  if (!conversations.response.ok) throw new Error(`DEMO_SMOKE_FAILED: conversations HTTP ${conversations.response.status}`);

  const approvals = await request(base, 'approvals?status=PENDING&limit=20', { headers: auth(companyToken) });
  if (!approvals.response.ok) throw new Error(`DEMO_SMOKE_FAILED: approvals HTTP ${approvals.response.status}`);

  let campaign = null;
  if (profile === 'live') {
    const idempotencyKey = `demo-smoke-${profile}-marketing-${Date.now()}`;
    campaign = await request(base, 'campaigns/drafts', {
      method: 'POST',
      headers: { ...auth(companyToken), 'content-type': 'application/json', 'x-idempotency-key': idempotencyKey },
      body: JSON.stringify({
        idempotency_key: idempotencyKey,
        segment_id: 'inactive_90d',
        objective: 'winback',
        instruction: 'Create a tenant-scoped reactivation draft for the inactive segment.',
        content_constraints: { channel: 'EMAIL_HTML', locale: 'en-US', max_length: 600 },
      }),
    });
    if (!campaign.response.ok || typeof campaign.body?.task_id !== 'string') {
      throw new Error(`DEMO_SMOKE_FAILED: marketing draft HTTP ${campaign.response.status}`);
    }
  }

  const readinessAfter = readinessSnapshot(
    (await request(base, 'demo/readiness', { headers: auth(platformToken) })).body,
    profile,
  );
  const providerCalls =
    typeof readinessAfter.ledger?.provider_call_count === 'number'
      ? readinessAfter.ledger.provider_call_count
      : null;

  return {
    profile,
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
      sales: { outcome: 'turn_accepted', task_id: salesReceipt.task_id },
      care: profile === 'live'
        ? { outcome: 'turn_accepted', task_id: careReceipt.task_id }
        : { outcome: 'not_exercised_offline' },
      marketing: profile === 'live'
        ? { outcome: 'draft_admitted', task_id: campaign.body.task_id }
        : { outcome: 'not_exercised_offline' },
    },
    readiness_before: readinessBefore.ledger?.status ?? 'unknown',
    conversations: 'observed',
    approvals: 'observed',
  };
}

/** Deterministic demo smoke: no live provider is called and no live success is claimed. */
export async function runDemoSmoke(env = process.env) {
  return runFlow(env, 'offline');
}

/** Provider-enabled acceptance: missing provider/auth/database prerequisites fail before requests. */
export async function runDemoLiveSmoke(env = process.env) {
  return runFlow(env, 'live');
}

if (isMainModule(import.meta.url, process.argv[1])) {
  if (typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(); } catch { /* ignore if .env is missing */ }
  }
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
