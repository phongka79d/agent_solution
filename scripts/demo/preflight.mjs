#!/usr/bin/env node
import { isMainModule } from './lib/main-module.mjs';
import { loadDemoPack, NOVAMART_TENANT_ID } from './seed.mjs';

const REQUIRED = [
  'DEMO_MODE',
  'APP_ENV',
  'DEMO_TENANT_ID',
  'DEMO_COMPANY_ADMIN_EMAIL',
  'DEMO_COMPANY_ADMIN_PASSWORD',
  'DEMO_PLATFORM_ADMIN_EMAIL',
  'DEMO_PLATFORM_ADMIN_PASSWORD',
  'DATABASE_URL',
  'MOCK_SECRET_KEY',
  'ERP_API_BASE_URL',
];
const EMAIL_KEYS = Object.freeze([
  'DEMO_COMPANY_ADMIN_EMAIL',
  'DEMO_PLATFORM_ADMIN_EMAIL',
]);
const COOKIE_KEYS = Object.freeze([
  'TENANT_COOKIE_HMAC_KEY',
  'PLATFORM_COOKIE_HMAC_KEY',
]);
const LIVE_PROVIDER_REQUIRED = [
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'PRIMARY_REASONING_MODEL',
];

function requireValue(env, key) {
  if (typeof env[key] !== 'string' || env[key].trim() === '') throw new Error(`DEMO_PREFLIGHT_FAILED: ${key} is required`);
}

/**
 * Validate the environment for one explicitly named profile.
 *
 * The default is offline for backwards compatibility. It still checks the local database and
 * simulated ERP needed by the deterministic demo, but it never requires (or implies) an LLM
 * provider. Live acceptance opts in with `profile=live` and requires the provider binding too.
 */
export async function runDemoPreflight(env = process.env, profile = 'offline') {
  if (profile !== 'offline' && profile !== 'live') {
    throw new Error(`DEMO_PREFLIGHT_FAILED: unsupported profile ${profile}`);
  }
  if (env.DEMO_PROVIDER_MODE !== profile) {
    throw new Error(`DEMO_PREFLIGHT_FAILED: DEMO_PROVIDER_MODE=${profile} is required for the ${profile} profile`);
  }
  if (env.DEMO_MODE !== 'true') throw new Error('DEMO_PREFLIGHT_FAILED: DEMO_MODE=true is required');
  if (env.APP_ENV !== 'local' && env.APP_ENV !== 'ci') throw new Error('DEMO_PREFLIGHT_FAILED: APP_ENV must be local or ci');
  const required = [
    ...REQUIRED,
    ...(profile === 'live' ? LIVE_PROVIDER_REQUIRED : []),
    ...(env.DEMO_MODE === 'true' ? COOKIE_KEYS : []),
  ];
  for (const key of required) requireValue(env, key);
  for (const key of EMAIL_KEYS) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env[key].trim())) {
      throw new Error(`DEMO_PREFLIGHT_FAILED: ${key} must look like an email address`);
    }
  }
  if (env.DEMO_MODE === 'true') {
    for (const key of COOKIE_KEYS) {
      if (Buffer.byteLength(env[key].trim(), 'utf8') < 32) {
        throw new Error(`DEMO_PREFLIGHT_FAILED: ${key} must be at least 32 bytes`);
      }
    }
  }
  if (env.DEMO_TENANT_ID !== NOVAMART_TENANT_ID) throw new Error('DEMO_PREFLIGHT_FAILED: DEMO_TENANT_ID is not the canonical NovaMart tenant');
  if (env.MOCK_ERP_ENABLED !== 'true') throw new Error('DEMO_PREFLIGHT_FAILED: MOCK_ERP_ENABLED=true is required for NovaMart');
  const origins = String(env.DEMO_WIDGET_ORIGINS ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const pack = await loadDemoPack();
  return {
    profile,
    tenant_id: NOVAMART_TENANT_ID,
    pack_version: pack.pack_version,
    demo_as_of: pack.demo_as_of,
    required_values_checked: required.length,
    provider: profile === 'live' ? 'required' : 'not_required',
    widget_origins: origins,
  };
}

export async function runDemoLivePreflight(env = process.env) {
  return runDemoPreflight(env, 'live');
}

if (isMainModule(import.meta.url, process.argv[1])) {
  if (typeof process.loadEnvFile === 'function') {
    try { process.loadEnvFile(); } catch { /* ignore if .env is missing */ }
  }
  const profile = process.argv.includes('--live') && !process.argv.includes('--offline') ? 'live' : 'offline';
  runDemoPreflight(process.env, profile).then((result) => {
    console.log(`NovaMart demo ${profile} preflight passed: ${JSON.stringify(result)}`);
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : 'DEMO_PREFLIGHT_FAILED');
    process.exitCode = 1;
  });
}
