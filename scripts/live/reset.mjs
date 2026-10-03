#!/usr/bin/env node
import { isMainModule } from '../demo/lib/main-module.mjs';
import { DEFAULT_ENV_FILE, parseEnvFile, runLivePreflight } from './preflight.mjs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function apiV1Base(env) {
  if (env.APP_ENV !== 'local' || env.DEMO_MODE !== 'true' || env.DEMO_PROVIDER_MODE !== 'live') {
    throw new Error('LIVE_RESET_FORBIDDEN: only the local live-demo profile may reset TEST data');
  }
  if (typeof env.DEMO_TENANT_ID !== 'string' || !UUID.test(env.DEMO_TENANT_ID)) {
    throw new Error('LIVE_RESET_FORBIDDEN: DEMO_TENANT_ID must be a UUID');
  }
  const raw = env.DEMO_API_URL ?? env.API_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('LIVE_RESET_FORBIDDEN: API_BASE_URL must be a local API origin');
  }
  if (
    url.protocol !== 'http:'
    || !LOOPBACK_HOSTS.includes(url.hostname)
    || url.username !== ''
    || url.password !== ''
    || url.search !== ''
    || url.hash !== ''
    || !['/', '/api/v1'].includes(url.pathname)
  ) {
    throw new Error('LIVE_RESET_FORBIDDEN: API_BASE_URL must be a local API origin');
  }
  const base = url.toString().replace(/\/+$/, '');
  return base.endsWith('/api/v1') ? base : `${base}/api/v1`;
}

function requireCredentials(env) {
  const email = env.DEMO_COMPANY_ADMIN_EMAIL;
  const password = env.DEMO_COMPANY_ADMIN_PASSWORD;
  if (typeof email !== 'string' || email.trim() === '' || typeof password !== 'string' || password === '') {
    throw new Error('LIVE_RESET_CONFIGURATION_MISSING: company demo credentials are required');
  }
  return { email, password };
}

async function requestJson(fetchImpl, base, path, { method = 'GET', token, body } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetchImpl(`${base}/${path.replace(/^\/+/, '')}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error('LIVE_RESET_FAILED: testing API request failed');
  }
  if (!response.ok) throw new Error(`LIVE_RESET_FAILED: testing API returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error('LIVE_RESET_FAILED: testing API returned invalid JSON');
  }
}

export async function resetTestData({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const base = apiV1Base(env);
  const { email, password } = requireCredentials(env);
  const tenantId = env.DEMO_TENANT_ID;
  const session = await requestJson(fetchImpl, base, 'demo/login', {
    method: 'POST',
    body: { email, password, audience: 'company' },
  });
  if (
    typeof session?.access_token !== 'string'
    || session.membership?.scope !== 'company'
    || session.membership?.tenant_id !== tenantId
  ) {
    throw new Error('LIVE_RESET_FORBIDDEN: company login is not bound to DEMO_TENANT_ID');
  }

  const status = await requestJson(fetchImpl, base, 'testing/status', { token: session.access_token });
  if (
    status?.tenant_id !== tenantId
    || status.enabled !== true
    || !['DEMO', 'TEST'].includes(status.data_class)
  ) {
    throw new Error('LIVE_RESET_FORBIDDEN: the Test Customer Lab is not enabled for a DEMO or TEST tenant');
  }

  const dryRun = await requestJson(fetchImpl, base, 'testing/reset', {
    method: 'POST',
    token: session.access_token,
    body: { dry_run: true },
  });
  if (
    dryRun?.tenant_id !== tenantId
    || dryRun.dry_run !== true
    || typeof dryRun.confirm_token !== 'string'
    || dryRun.confirm_token.length === 0
  ) {
    throw new Error('LIVE_RESET_FAILED: TEST-data dry run did not return a valid confirmation');
  }

  const result = await requestJson(fetchImpl, base, 'testing/reset', {
    method: 'POST',
    token: session.access_token,
    body: { dry_run: false, confirm_token: dryRun.confirm_token },
  });
  if (result?.tenant_id !== tenantId || result.dry_run !== false || typeof result.counts !== 'object' || result.counts === null) {
    throw new Error('LIVE_RESET_FAILED: TEST-data reset returned an invalid result');
  }
  return { counts: result.counts };
}

function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const options = { envFile: DEFAULT_ENV_FILE, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--help') return { ...options, help: true };
    if (argument !== '--env-file' || !args[index + 1] || args[index + 1].startsWith('--')) {
      throw new Error('LIVE_RESET_FAILED: unsupported argument');
    }
    options.envFile = args[index + 1];
    index += 1;
  }
  return options;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log('Usage: pnpm live:reset [-- --env-file <path>]');
    return;
  }

  const envFile = resolve(options.envFile);
  await runLivePreflight({ envFile });
  const fileEnv = parseEnvFile(await readFile(envFile, 'utf8'));
  const env = { ...process.env, ...fileEnv };
  const { counts } = await resetTestData({ env });
  console.log(`TEST-data reset completed (${JSON.stringify(counts)}).`);
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'LIVE_RESET_FAILED');
    process.exitCode = 1;
  }
}
