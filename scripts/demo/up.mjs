#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './lib/main-module.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_ENV_FILE = '.env';
export const DEFAULT_HEALTH_TIMEOUT_MS = 5 * 60 * 1_000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;
const COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;
const SECRET_KEY_PATTERN = /SECRET|PASSWORD|TOKEN|KEY|_URL$|DSN/i;
// Spawned directly with the running Node: Windows refuses `.cmd` shims without a shell.
const MIGRATION_SCRIPT = 'packages/database/scripts/rehearse-migrations.mjs';

export const EXPECTED_DEFAULT_SERVICES = Object.freeze([
  'postgres',
  'redis',
  'qdrant',
  'mock-erp',
  'api',
  'worker',
  'tenant-console',
  'platform-admin',
]);

/** Data services the schema migration needs before the application containers may start. */
const INFRA_SERVICES = Object.freeze(['postgres', 'redis', 'qdrant', 'mock-erp']);

const DEMO_ACCOUNT_ENV_KEYS = Object.freeze([
  'DEMO_COMPANY_ADMIN_EMAIL',
  'DEMO_COMPANY_ADMIN_PASSWORD',
  'DEMO_PLATFORM_ADMIN_EMAIL',
  'DEMO_PLATFORM_ADMIN_PASSWORD',
]);

const USAGE = 'Usage: pnpm demo:up [-- --env-file <path>] [--profile <offline|live>] [--live]';

/**
 * Parse the small CLI surface of the demo bootstrapper without exiting the
 * process. Keeping this pure makes malformed invocations testable and lets the
 * caller decide how to report the failure.
 */
export function parseArgs(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');

  const options = {
    envFile: DEFAULT_ENV_FILE,
    help: false,
    live: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--') continue;

    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }

    if (argument === '--live') {
      options.live = true;
      continue;
    }

    const equalsIndex = argument.startsWith('--') ? argument.indexOf('=') : -1;
    const name = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);

    if (!['--env-file', '--profile'].includes(name)) {
      throw new Error(`UNKNOWN_ARGUMENT: ${argument}. Supported: --env-file <path>, --profile <offline|live>, --live`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (typeof value !== 'string' || value.length === 0 || (inlineValue === undefined && value.startsWith('--'))) {
      throw new Error(`ARGUMENT_VALUE_REQUIRED: ${name} needs a value`);
    }

    if (inlineValue === undefined) index += 1;
    if (name === '--profile') {
      if (!['offline', 'live'].includes(value)) throw new Error(`INVALID_PROFILE: ${value}`);
      options.live = value === 'live';
    } else {
      options.envFile = value;
    }
  }

  return options;
}

/**
 * Build the ordered logical steps. The compose step owns its compatibility
 * fallback: current Compose versions use `--wait`; older versions run without
 * it and then use `ps --format json` polling.
 */
export function buildPlan(options = {}) {
  const envFile = options.envFile ?? DEFAULT_ENV_FILE;
  if (typeof envFile !== 'string' || envFile.length === 0) throw new TypeError('envFile must be a non-empty string');

  const healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isFinite(healthTimeoutMs) || healthTimeoutMs <= 0) throw new TypeError('healthTimeoutMs must be positive');
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) throw new TypeError('pollIntervalMs must not be negative');

  const composePrefix = ['compose', '--env-file', envFile];
  // Preflight and smoke default to the offline profile; --live makes both require and exercise the provider.
  const profileArgs = options.live ? ['--live'] : [];
  const composeUp = (name, services) => ({
    name,
    kind: 'compose-up',
    command: 'docker',
    args: [...composePrefix, 'up', '-d', '--build', '--wait', ...services],
    fallbackArgs: [...composePrefix, 'up', '-d', '--build', ...services],
    healthArgs: [...composePrefix, 'ps', '--format', 'json'],
    healthTimeoutMs,
    pollIntervalMs,
    envFile,
    expectedServices: services.length > 0 ? services : EXPECTED_DEFAULT_SERVICES,
  });

  return [
    {
      name: 'env-file',
      kind: 'env-file',
      envFile,
    },
    {
      name: 'docker',
      kind: 'command',
      command: 'docker',
      args: ['--version'],
      envFile,
    },
    // The API and worker refuse to start on an unmigrated database, so the data services come up
    // first, the schema is migrated, and only then do the application containers start.
    composeUp('compose-infra', INFRA_SERVICES),
    {
      name: 'migrate',
      kind: 'bootstrap',
      command: process.execPath,
      args: [MIGRATION_SCRIPT],
      envFile,
    },
    composeUp('compose-up', []),
    {
      name: 'preflight',
      kind: 'command',
      command: process.execPath,
      args: ['--env-file', envFile, 'scripts/demo/preflight.mjs', ...profileArgs],
      envFile,
    },
    {
      name: 'seed',
      // The seed writes as the bootstrap user and drops to agentos_app itself; the file's own
      // DATABASE_URL (the app role) cannot mark the demo tenant's data class.
      kind: 'bootstrap',
      command: process.execPath,
      args: ['--env-file', envFile, 'scripts/demo/seed.mjs'],
      envFile,
    },
    {
      name: 'smoke',
      kind: 'command',
      command: process.execPath,
      args: ['--env-file', envFile, 'scripts/demo/smoke.mjs', ...profileArgs],
      envFile,
    },
  ];
}

/** Collect sensitive env values for redacted command diagnostics. */
export function collectRedactionValues(env = {}, envFileEnv = {}) {
  const values = [
    ...Object.entries(envFileEnv)
      .filter(([key]) => SECRET_KEY_PATTERN.test(key))
      .map(([, value]) => value),
    ...Object.entries(env)
      .filter(([key]) => SECRET_KEY_PATTERN.test(key))
      .map(([, value]) => value),
  ];
  const eligible = [...new Set(values
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter((value) => value.length >= 4))];
  const encoded = eligible.map((value) => encodeURIComponent(value));

  return [...new Set([...eligible, ...encoded])].sort((left, right) => right.length - left.length);
}

/**
 * Redact values from command diagnostics while retaining variable names and
 * useful non-secret context. Values shorter than four characters are ignored.
 */
export function redactSecrets(output, envOrValues = [], envFileEnv = {}) {
  const values = Array.isArray(envOrValues)
    ? envOrValues
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim())
      .filter((value) => value.length >= 4)
      .sort((left, right) => right.length - left.length)
    : collectRedactionValues(envOrValues, envFileEnv);

  return values.reduce((redacted, value) => redacted.split(value).join('<redacted>'), String(output ?? ''));
}

/**
 * Format the operator summary without reading or interpolating any demo
 * account values. Only the two public console origins are selected from env;
 * account variables are deliberately represented by their names.
 */
export function formatSummary(env = {}) {
  const tenantUrl = publicUrl(env.WEB_BASE_URL, 'http://localhost:3000');
  const platformUrl = publicUrl(env.PLATFORM_ADMIN_URL, 'http://localhost:3001');

  return [
    'NovaMart demo is ready.',
    `Tenant console: ${tenantUrl}`,
    `Platform console: ${platformUrl}`,
    'Demo account environment variables (names only):',
    ...DEMO_ACCOUNT_ENV_KEYS.map((key) => `  ${key}`),
  ].join('\n');
}

function publicUrl(value, fallback) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : fallback;
}

/**
 * Run every plan step in order. A runner may return `{ ok: false }` or throw;
 * either form stops the plan immediately and identifies the logical step.
 */
export async function runPlan(plan, runner, failurePrefix = 'DEMO_UP_FAILED') {
  if (!Array.isArray(plan)) throw new TypeError('plan must be an array');
  if (typeof runner !== 'function') throw new TypeError('runner must be a function');
  if (typeof failurePrefix !== 'string' || failurePrefix.length === 0) throw new TypeError('failurePrefix must be non-empty');

  const results = [];
  for (const step of plan) {
    try {
      const result = await runner(step);
      if (result === false || result?.ok === false) {
        throw new Error('runner returned a failed result');
      }
      results.push(result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${failurePrefix}: step ${step.name} failed: ${reason}`, { cause: error });
    }
  }
  return results;
}

/**
 * Spawn without a shell so the same command/argument vectors work on POSIX and
 * Windows. Output is captured only for Compose fallback and redacted failure
 * diagnostics; raw child output is never printed.
 */
export function runCommand(command, args, { timeoutMs = COMMAND_TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;

    const append = (current, chunk) => {
      const next = current + chunk.toString();
      return next.length > 256 * 1024 ? next.slice(-256 * 1024) : next;
    };

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveResult({ ...result, stdout, stderr });
    };

    child.stdout.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.once('error', (error) => {
      finish({ ok: false, status: null, error });
    });
    child.once('close', (status, signal) => {
      finish({ ok: status === 0, status, signal, error: undefined });
    });

    timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, status: null, signal: 'SIGTERM', error: new Error('command timed out') });
    }, timeoutMs);
  });
}

export function verifyEnvFile(envFile) {
  const path = resolve(REPO_ROOT, envFile);
  if (!existsSync(path)) throw new Error(`ENV_FILE_MISSING: ${envFile}`);
  if (!statSync(path).isFile()) throw new Error(`ENV_FILE_NOT_FILE: ${envFile}`);
  return path;
}

export function buildBootstrapDatabaseUrl(env = {}) {
  const user = String(env.POSTGRES_USER ?? 'postgres');
  const password = String(env.POSTGRES_PASSWORD ?? '');
  const port = String(env.POSTGRES_PORT ?? '5432');
  const database = String(env.POSTGRES_DB ?? 'agentos_dev');
  if (password.length === 0) throw new Error('POSTGRES_PASSWORD is required for migration');

  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${encodeURIComponent(database)}?schema=agentos`;
}

export function formatCommandFailure(result, envFile, env = process.env) {
  const detail = result.error?.code ?? result.signal ?? `exit ${result.status ?? 'unknown'}`;
  const rawOutput = String(result.stderr ?? '').trim() || String(result.stdout ?? '').trim();
  if (rawOutput.length === 0) return `command ${detail}`;

  let envFileEnv = {};
  if (envFile) {
    try {
      envFileEnv = readEnvFile(resolve(REPO_ROOT, envFile));
    } catch {
      envFileEnv = {};
    }
  }

  const diagnostic = redactSecrets(
    rawOutput.split(/\r?\n/).slice(-20).join('\n'),
    collectRedactionValues(env, envFileEnv),
  );
  return `command ${detail}\n${diagnostic}`;
}

function commandFailure(result, envFile) {
  return new Error(formatCommandFailure(result, envFile));
}

function waitUnsupported(result) {
  const output = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return /(?:unknown|unrecognized|invalid|unsupported|does not support)[^\n]*(?:--wait|wait)/i.test(output);
}

function parseComposePs(stdout) {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return [];
  if (trimmed.startsWith('[')) return JSON.parse(trimmed);
  return trimmed.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

function serviceName(container) {
  return String(container.Service ?? container.service ?? '');
}

function containerIsHealthy(container) {
  const state = String(container.State ?? container.state ?? '').toLowerCase();
  const health = String(container.Health ?? container.health ?? '').toLowerCase();
  return state === 'running' && (health === '' || health === 'healthy');
}

function containerFailed(container) {
  const state = String(container.State ?? container.state ?? '').toLowerCase();
  return state === 'exited' || state === 'dead';
}

async function waitForComposeHealthy(step) {
  const deadline = Date.now() + step.healthTimeoutMs;
  let observed = new Map();

  for (;;) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`health timeout after ${Math.ceil(step.healthTimeoutMs / 1_000)} seconds`);
    const result = await runCommand(step.command, step.healthArgs, { timeoutMs: remainingMs });
    if (!result.ok) throw commandFailure(result, step.envFile);
    try {
      const containers = parseComposePs(result.stdout);
      observed = new Map(containers.map((container) => [serviceName(container), container]));
    } catch {
      throw new Error('compose ps returned invalid JSON');
    }

    const failed = step.expectedServices
      .map((service) => observed.get(service))
      .find((container) => container && containerFailed(container));
    if (failed) {
      throw new Error(`container ${serviceName(failed)} is ${failed.State ?? 'failed'}`);
    }

    const pending = step.expectedServices.filter((service) => {
      const container = observed.get(service);
      return container === undefined || !containerIsHealthy(container);
    });
    if (pending.length === 0) return observed;
    if (Date.now() >= deadline) {
      throw new Error(`health timeout after ${Math.ceil(step.healthTimeoutMs / 1_000)} seconds: ${pending.join(', ')}`);
    }

    const delayMs = Math.min(step.pollIntervalMs, Math.max(0, deadline - Date.now()));
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs));
  }
}

async function executeStep(step) {
  if (step.kind === 'env-file') {
    verifyEnvFile(step.envFile);
    return { ok: true };
  }

  if (step.kind === 'compose-up') {
    const started = await runCommand(step.command, step.args);
    if (started.ok) return started;

    if (waitUnsupported(started)) {
      const fallbackStart = await runCommand(step.command, step.fallbackArgs);
      if (!fallbackStart.ok) throw commandFailure(fallbackStart, step.envFile);
      await waitForComposeHealthy(step);
      return fallbackStart;
    }

    throw commandFailure(started, step.envFile);
  }

  if (step.kind === 'bootstrap') {
    const result = await runCommand(step.command, step.args, { env: bootstrapEnvironment(step.envFile) });
    if (!result.ok) throw commandFailure(result, step.envFile);
    return result;
  }

  const result = await runCommand(step.command, step.args);
  if (!result.ok) throw commandFailure(result, step.envFile);
  return result;
}

function readEnvFile(filePath) {
  const values = {};
  const source = readFileSync(filePath, 'utf8');

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    values[match[1]] = value;
  }

  return values;
}

function bootstrapEnvironment(envFile) {
  const envFromFile = readEnvFile(resolve(REPO_ROOT, envFile));
  const migrationConfig = { ...process.env, ...envFromFile };
  return {
    ...process.env,
    ...(migrationConfig.PLATFORM_ROLE_PASSWORD === undefined
      ? {}
      : { PLATFORM_ROLE_PASSWORD: migrationConfig.PLATFORM_ROLE_PASSWORD }),
    ...(migrationConfig.INDEXER_ROLE_PASSWORD === undefined
      ? {}
      : { INDEXER_ROLE_PASSWORD: migrationConfig.INDEXER_ROLE_PASSWORD }),
    DATABASE_URL: buildBootstrapDatabaseUrl(migrationConfig),
  };
}

export async function main(argv = process.argv.slice(2), runner = executeStep) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }

  const plan = buildPlan(options);
  await runPlan(plan, runner);

  const envFilePath = verifyEnvFile(options.envFile);
  const envFromFile = readEnvFile(envFilePath);
  console.log(formatSummary({ ...envFromFile, ...process.env }));
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'DEMO_UP_FAILED';
    console.error(message.startsWith('DEMO_UP_FAILED:') ? message : `DEMO_UP_FAILED: ${message}`);
    process.exitCode = 1;
  });
}
