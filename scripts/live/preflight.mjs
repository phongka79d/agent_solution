#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { isMainModule } from '../demo/lib/main-module.mjs';

export const DEFAULT_ENV_FILE = '.env';
export const REQUIRED_LIVE_ENV = Object.freeze([
  'APP_ENV',
  'DEMO_MODE',
  'DEMO_PROVIDER_MODE',
  'DEMO_TENANT_ID',
  'DATABASE_URL',
  'API_BASE_URL',
  'WEB_BASE_URL',
  'DEMO_COMPANY_ADMIN_EMAIL',
  'DEMO_COMPANY_ADMIN_PASSWORD',
  'DEMO_PLATFORM_ADMIN_EMAIL',
  'DEMO_PLATFORM_ADMIN_PASSWORD',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'PRIMARY_REASONING_MODEL',
  'LIVE_MAX_LLM_CALLS',
  'LIVE_ALLOWED_LLM_HOSTS',
]);

const PLACEHOLDER_PATTERN = /(?:^|[^a-z0-9])(?:change[-_ ]?me|changeme|sk-xxx[\w-]*|placeholder|replace[-_ ]?me|xxx+|todo)(?:$|[^a-z0-9])/i;

export function parseEnvFile(source) {
  if (typeof source !== 'string') throw new TypeError('source must be a string');
  const env = {};

  for (const [index, rawLine] of source.replace(/^\uFEFF/, '').split(/\r?\n/).entries()) {
    let line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trimStart();

    const separator = line.indexOf('=');
    if (separator <= 0) throw new Error(`LIVE_PREFLIGHT_FAILED: malformed env assignment on line ${index + 1}`);
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`LIVE_PREFLIGHT_FAILED: malformed env name on line ${index + 1}`);
    }

    let value = line.slice(separator + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'" || quote === '`') {
      const quotedValue = quote === '"'
        ? value.match(/^"((?:\\.|[^"])*)"(?:\s+#.*)?$/)
        : quote === "'"
          ? value.match(/^'([^']*)'(?:\s+#.*)?$/)
          : value.match(/^`([^`]*)`(?:\s+#.*)?$/);
      if (quotedValue === null) throw new Error(`LIVE_PREFLIGHT_FAILED: malformed quoted value for ${key}`);
      value = quotedValue[1];
      if (quote === '"') value = value.replace(/\\([nr"\\])/g, (_, escaped) => (
        escaped === 'n' ? '\n' : escaped === 'r' ? '\r' : escaped
      ));
    } else {
      value = value.replace(/\s+#.*$/, '').trimEnd();
    }
    env[key] = value;
  }

  return env;
}

export function validateLiveEnvironment(env) {
  const missing = [];
  const placeholders = [];

  for (const key of REQUIRED_LIVE_ENV) {
    const value = env[key];
    if (typeof value !== 'string' || value.trim() === '') {
      missing.push(key);
    } else if (PLACEHOLDER_PATTERN.test(value.trim())) {
      placeholders.push(key);
    }
  }

  const problems = [];
  if (missing.length > 0) problems.push(`missing or empty: ${missing.join(', ')}`);
  if (placeholders.length > 0) problems.push(`placeholder values: ${placeholders.join(', ')}`);
  if (env.APP_ENV !== 'local') problems.push('APP_ENV must use the local profile');
  if (env.DEMO_MODE !== 'true') problems.push('DEMO_MODE must enable the demo boundary');
  if (env.DEMO_PROVIDER_MODE !== 'live') problems.push('DEMO_PROVIDER_MODE must enable the live provider');
  for (const key of ['API_BASE_URL', 'WEB_BASE_URL']) {
    if (typeof env[key] !== 'string' || env[key].trim() === '') continue;
    try {
      const url = new URL(env[key]);
      const allowedPath = key === 'API_BASE_URL' ? ['/', '/api/v1'] : ['/'];
      if (
        url.protocol !== 'http:'
        || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username !== ''
        || url.password !== ''
        || url.search !== ''
        || url.hash !== ''
        || !allowedPath.includes(url.pathname)
      ) {
        problems.push(`${key} must be an HTTP loopback origin`);
      }
    } catch {
      problems.push(`${key} must be a valid URL`);
    }
  }

  if (typeof env.LIVE_MAX_LLM_CALLS === 'string' && env.LIVE_MAX_LLM_CALLS.trim() !== '') {
    const maxCalls = Number(env.LIVE_MAX_LLM_CALLS);
    if (!Number.isSafeInteger(maxCalls) || maxCalls <= 0) {
      problems.push('LIVE_MAX_LLM_CALLS must be a positive integer');
    }
  }

  if (typeof env.DATABASE_URL === 'string' && env.DATABASE_URL.trim() !== '') {
    try {
      const databaseUrl = new URL(env.DATABASE_URL);
      if (databaseUrl.protocol !== 'postgres:' && databaseUrl.protocol !== 'postgresql:') {
        problems.push('DATABASE_URL must be a valid PostgreSQL URL');
      }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname)) {
        problems.push('DATABASE_URL must target a local PostgreSQL server');
      }
      const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
      if (!/(?:^|[_-])(?:live|test)(?:[_-]|$)/i.test(databaseName)) {
        problems.push('DATABASE_URL must target a dedicated live or test database');
      }
    } catch {
      problems.push('DATABASE_URL must be a valid PostgreSQL URL');
    }
  }

  if (typeof env.OPENAI_BASE_URL === 'string' && env.OPENAI_BASE_URL.trim() !== '') {
    try {
      const providerUrl = new URL(env.OPENAI_BASE_URL);
      const providerHost = providerUrl.host.toLowerCase();
      const loopbackProvider = ['localhost', '127.0.0.1', '[::1]'].includes(providerUrl.hostname);
      if (providerUrl.protocol !== 'https:' && !(providerUrl.protocol === 'http:' && loopbackProvider)) {
        problems.push('OPENAI_BASE_URL must use HTTPS for non-loopback providers');
      }
      const allowedHosts = typeof env.LIVE_ALLOWED_LLM_HOSTS === 'string'
        ? env.LIVE_ALLOWED_LLM_HOSTS.split(',').map((host) => host.trim().toLowerCase()).filter(Boolean)
        : [];
      if (!allowedHosts.includes(providerHost)) {
        problems.push('OPENAI_BASE_URL host must match LIVE_ALLOWED_LLM_HOSTS');
      }
    } catch {
      problems.push('OPENAI_BASE_URL must be a valid URL');
    }
  }

  if (problems.length > 0) throw new Error(`LIVE_PREFLIGHT_FAILED: ${problems.join('; ')}`);
  return { requiredVariablesChecked: REQUIRED_LIVE_ENV.length };
}

export async function runLivePreflight({ envFile = DEFAULT_ENV_FILE, env = process.env } = {}) {
  let source;
  try {
    source = await readFile(envFile, 'utf8');
  } catch {
    throw new Error(`LIVE_PREFLIGHT_FAILED: cannot read env file ${envFile}`);
  }
  return validateLiveEnvironment({ ...env, ...parseEnvFile(source) });
}

function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  let envFile = DEFAULT_ENV_FILE;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--env-file') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error('LIVE_PREFLIGHT_FAILED: --env-file requires a path');
      envFile = value;
      index += 1;
    } else if (argument === '--help') {
      return { help: true, envFile };
    } else {
      throw new Error('LIVE_PREFLIGHT_FAILED: unsupported argument');
    }
  }
  return { help: false, envFile };
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log('Usage: pnpm live:preflight [-- --env-file <path>]');
      return;
    }
    const result = await runLivePreflight({ envFile: options.envFile });
    console.log(`Live preflight passed (${result.requiredVariablesChecked} required variables checked; values withheld).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'LIVE_PREFLIGHT_FAILED');
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) await main();
