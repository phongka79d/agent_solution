#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { seedNovaMart, loadDemoPack, NOVAMART_TENANT_ID } from '../../scripts/demo/seed.mjs';
import { redactSecrets } from '../../scripts/demo/up.mjs';
import { startLlmStub } from './tools/llm-stub.mjs';
const requireDatabaseDependency = createRequire(new URL('../../packages/database/package.json', import.meta.url));
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const STATE_FILE = resolve(REPO_ROOT, 'tests/stack/.state/stack.json');
const PROJECT = 'agentos_stacktest';
const API_URL = 'http://127.0.0.1:14000';
const MOCK_ERP_URL = 'http://127.0.0.1:18081';
const SUPERUSER_PORT = 15433;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1_000;
const READY_TIMEOUT_MS = 3 * 60 * 1_000;
const READY_POLL_MS = 1_000;
const DOCKER = process.platform === 'win32' ? 'docker.exe' : 'docker';
const MAX_OUTPUT_LINES = 80;
const MAX_OUTPUT_LINE_CHARS = 4_096;

let llmStub;
let composeEnv;
let stackStarted = false;

const stackTestEnvKeys = [
  'DATABASE_URL',
  'DEMO_COMPANY_ADMIN_EMAIL',
  'DEMO_COMPANY_ADMIN_PASSWORD',
  'DEMO_PLATFORM_ADMIN_EMAIL',
  'DEMO_PLATFORM_ADMIN_PASSWORD',
  'DEMO_WIDGET_ORIGINS',
  'MOCK_SECRET_KEY',
  'LLM_STUB_CONTROL_TOKEN',
  'AUTH_PROVIDER',
  'EMAIL_OUTBOX_DIR',
  'LLM_STUB_URL',
  'OPENAI_BASE_URL',
  'PLATFORM_DATABASE_URL',
  'INDEXER_DATABASE_URL',
  'STACK_AUTH_PROVIDER',
  'STACK_SECOND_COMPANY_ADMIN_EMAIL',
  'STACK_SECOND_COMPANY_ADMIN_PASSWORD',
  'QUOTE_SIGNING_SECRET',
];
const priorStackTestEnv = new Map();

function exposeStackTestEnvironment(env, llmStubControlToken) {
  for (const key of stackTestEnvKeys) {
    if (!priorStackTestEnv.has(key)) priorStackTestEnv.set(key, process.env[key]);
    let value = env[key];
    // The generated secondary login is available only from the private state file.
    if (
      key === 'STACK_SECOND_COMPANY_ADMIN_EMAIL'
      || key === 'STACK_SECOND_COMPANY_ADMIN_PASSWORD'
    ) value = undefined;
    else if (key === 'LLM_STUB_CONTROL_TOKEN') value = llmStubControlToken;
    else if (key === 'DATABASE_URL') value = databaseUrl('agentos_app', env.APP_ROLE_PASSWORD);
    else if (key === 'PLATFORM_DATABASE_URL') value = databaseUrl('agentos_platform_login', env.PLATFORM_ROLE_PASSWORD);
    else if (key === 'INDEXER_DATABASE_URL') value = databaseUrl('agentos_indexer_login', env.INDEXER_ROLE_PASSWORD);
    else if (key === 'EMAIL_OUTBOX_DIR') value = outboxDirectory;
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function restoreStackTestEnvironment() {
  for (const [key, value] of priorStackTestEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  priorStackTestEnv.clear();
}

const outboxDirectory = resolve(REPO_ROOT, 'tests/stack/.state/outbox');
function secret(byteLength = 32) {
  return randomBytes(byteLength).toString('base64url');
}

function makeEnvironment(llmStubUrl) {
  const authProvider = (process.env.STACK_AUTH_PROVIDER ?? 'demo').trim().toLowerCase();
  if (authProvider !== 'demo' && authProvider !== 'db') {
    throw new Error('STACK_AUTH_PROVIDER: accepted values are `demo` and `db`');
  }
  const dbAuthCredentials = authProvider === 'db'
    ? {
        company: {
          email: `company-admin-${randomBytes(16).toString('hex')}@novamart.example.invalid`,
          password: secret(),
        },
        platform: {
          email: `platform-admin-${randomBytes(16).toString('hex')}@agentos.example.invalid`,
          password: secret(),
        },
        secondCompany: {
          email: `second-company-admin-${randomBytes(16).toString('hex')}@novamart.example.invalid`,
          password: secret(),
        },
      }
    : null;
  const postgresPassword = secret();
  const platformRolePassword = secret();
  const indexerRolePassword = secret();
  const appPassword = secret();
  const secrets = {
    JWT_SECRET: secret(48),
    INTERNAL_API_KEY: secret(48),
    WEBHOOK_HMAC_SECRET: secret(32),
    AUDIT_HMAC_SECRET: secret(32),
    PLATFORM_SECRET: secret(32),
    ENCRYPTION_KEY_AES256: randomBytes(32).toString('hex'),
    SESSION_SECRET: secret(32),
    MOCK_SECRET_KEY: secret(32),
    REDIS_PASSWORD: secret(32),
    QDRANT_API_KEY: secret(32),
    QUOTE_SIGNING_SECRET: secret(32),
  };
  const llmUrl = new URL(llmStubUrl);
  llmUrl.hostname = 'host.docker.internal';

  return {
    AUTH_PROVIDER: authProvider,
    STACK_AUTH_PROVIDER: authProvider,
    ...secrets,
    APP_ENV: 'ci',
    NODE_ENV: 'test',
    BIND_ADDRESS: '127.0.0.1',
    POSTGRES_DB: 'agentos_dev',
    POSTGRES_USER: 'postgres',
    POSTGRES_PASSWORD: postgresPassword,
    POSTGRES_PORT: String(SUPERUSER_PORT),
    POSTGRES_ENV: 'ci',
    APP_ROLE_PASSWORD: appPassword,
    PLATFORM_ROLE_PASSWORD: platformRolePassword,
    PLATFORM_DATABASE_URL: `postgresql://agentos_platform_login:${platformRolePassword}@postgres:5432/agentos_dev?schema=agentos`,
    INDEXER_ROLE_PASSWORD: indexerRolePassword,
    INDEXER_DATABASE_URL: `postgresql://agentos_indexer_login:${indexerRolePassword}@postgres:5432/agentos_dev?schema=agentos`,
    MIGRATOR_ROLE_PASSWORD: secret(),
    API_BASE_URL: API_URL,
    WEB_BASE_URL: 'http://localhost:13000',
    CORS_ALLOWED_ORIGINS: 'http://localhost:13000,http://localhost:13001,http://localhost:14000',
    // The stack console's test chat mints widgets from its own origin; API tests use the first entry.
    DEMO_WIDGET_ORIGINS: 'http://localhost:3000,http://localhost:13000',
    DEMO_MODE: 'true',
    DEMO_PROVIDER_MODE: 'stub',
    DEMO_TENANT_ID: NOVAMART_TENANT_ID,
    DEMO_COMPANY_ADMIN_EMAIL: dbAuthCredentials?.company.email ?? 'company-admin@novamart.example.invalid',
    DEMO_COMPANY_ADMIN_PASSWORD: dbAuthCredentials?.company.password ?? 'stacktest-company-admin-password',
    DEMO_PLATFORM_ADMIN_EMAIL: dbAuthCredentials?.platform.email ?? 'platform-admin@agentos.example.invalid',
    DEMO_PLATFORM_ADMIN_PASSWORD: dbAuthCredentials?.platform.password ?? 'stacktest-platform-admin-password',
    ...(dbAuthCredentials === null ? {} : {
      STACK_SECOND_COMPANY_ADMIN_EMAIL: dbAuthCredentials.secondCompany.email,
      STACK_SECOND_COMPANY_ADMIN_PASSWORD: dbAuthCredentials.secondCompany.password,
    }),
    WORKER_TENANT_IDS: authProvider === 'db' ? '' : NOVAMART_TENANT_ID,
    KNOWLEDGE_TENANT_IDS: NOVAMART_TENANT_ID,
    KNOWLEDGE_ROOT: '/repo/packages/second-brain/demo/novamart',
    ENABLED_AGENT_MODULES: 'sales,support,marketing',
    SALES_SIGNAL_SOURCE_CHANNELS: 'WEB_CHAT',
    SALES_SIGNAL_EVENT_TYPES: 'message.received',
    MARKETING_SIGNAL_SOURCE_CHANNELS: 'MARKETING_CAMPAIGN',
    MARKETING_SIGNAL_EVENT_TYPES: 'campaign.requested',
    MOCK_ERP_DEMO_PACK: 'novamart',
    MOCK_ERP_ENABLED: 'true',
    OPENAI_API_KEY: `stacktest-${secret(24)}`,
    OPENAI_BASE_URL: llmUrl.toString().replace(/\/$/, ''),
    LLM_STUB_URL: llmStubUrl,
    EMAIL_OUTBOX_DIR: '/app/tests/stack/.state/outbox',
    DEFAULT_LLM_PROVIDER: 'openai-compatible',
    PRIMARY_REASONING_MODEL: 'gpt-4o',
    FAST_COMPLETION_MODEL: 'gpt-4o-mini',
    OPENAI_STRUCTURED_OUTPUT_MODE: 'json_object',
    NEXTAUTH_URL: 'http://localhost:13000',
    NEXTAUTH_SECRET: secret(),
    TENANT_COOKIE_HMAC_KEY: secret(32),
    PLATFORM_ADMIN_URL: 'http://localhost:13001',
    PLATFORM_NEXTAUTH_SECRET: secret(),
    PLATFORM_COOKIE_HMAC_KEY: secret(32),
    NEXT_PUBLIC_API_URL: API_URL,
    WEB_PORT: '13000',
    PLATFORM_ADMIN_PORT: '13001',
    WORKER_HEALTH_PORT: '4001',
    REDIS_HOST: 'redis',
    REDIS_PORT: '6379',
    QDRANT_URL: 'http://qdrant:6333',
    QDRANT__SERVICE__HTTP_PORT: '6333',
    QDRANT__SERVICE__GRPC_PORT: '6334',
    ERP_API_BASE_URL: 'http://mock-erp:8081/api/v1',
    ERP_TIMEOUT_MS: process.env.ERP_TIMEOUT_MS || '5000',
    EVENT_INGESTION_BASE_URL: 'http://mock-erp:8081/events/v1',
    LOG_LEVEL: 'info',
    LLM_MAX_OUTPUT_TOKENS_PER_CALL: '2048',
    MAX_TOKENS_PER_RUN: '4096',
  };
}

function composeArgs(args) {
  return [
    'compose',
    '--project-name', PROJECT,
    '--env-file', '.env.example',
    '--file', 'docker-compose.yml',
    '--file', 'tests/stack/compose.stack.yml',
    ...args,
  ];
}

function run(command, args, { env = process.env, timeoutMs = COMMAND_TIMEOUT_MS, label } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const outputTail = [];
    const pendingOutput = { stdout: '', stderr: '' };
    let settled = false;

    const keepLine = (line) => {
      outputTail.push(line.slice(-MAX_OUTPUT_LINE_CHARS));
      if (outputTail.length > MAX_OUTPUT_LINES) outputTail.shift();
    };
    const capture = (stream, chunk) => {
      const lines = `${pendingOutput[stream]}${chunk.toString('utf8')}`.split(/\r?\n/);
      pendingOutput[stream] = lines.pop().slice(-MAX_OUTPUT_LINE_CHARS);
      for (const line of lines) keepLine(line);
    };
    const flushOutput = () => {
      for (const stream of ['stdout', 'stderr']) {
        if (pendingOutput[stream]) keepLine(pendingOutput[stream]);
        pendingOutput[stream] = '';
      }
    };
    const rejectWithOutput = (detail) => {
      flushOutput();
      const tail = redactSecrets(outputTail.join('\n'), env);
      rejectPromise(new Error(`${label} ${detail}${tail ? `\n${tail}` : ''}`));
    };

    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    child.stdout.on('data', (chunk) => capture('stdout', chunk));
    child.stderr.on('data', (chunk) => capture('stderr', chunk));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectWithOutput('timed out');
    }, timeoutMs);
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectWithOutput(`could not start (${error.code ?? error.name})`);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectWithOutput(`failed (exit ${code ?? signal ?? 'unknown'})`);
    });
  });
}

const dockerCliEnvironmentKeys = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'USERPROFILE',
  'HOME',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'SystemDrive',
  'PUBLIC',
  'DOCKER_CONFIG',
  'DOCKER_CONTEXT',
  'DOCKER_HOST',
  'DOCKER_TLS_VERIFY',
  'DOCKER_CERT_PATH',
];

function dockerCliEnvironment(env) {
  const childEnvironment = { ...env };
  for (const key of dockerCliEnvironmentKeys) {
    const value = process.env[key];
    if (value !== undefined) childEnvironment[key] = value;
  }
  return childEnvironment;
}

async function compose(args, label, env = composeEnv) {
  await run(DOCKER, composeArgs(args), { env: dockerCliEnvironment(env), label: `docker compose ${label}` });
}

function databaseUrl(user, password) {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${SUPERUSER_PORT}/agentos_dev?schema=agentos`;
}
async function seedDbAuthPlatformAdmin(env) {
  if (env.AUTH_PROVIDER !== 'db') return;
  // The repo root does not depend on workspace packages; resolve core-engine through the API package.
  const coreEngineEntry = createRequire(new URL('../../apps/api/package.json', import.meta.url)).resolve('@agentos/core-engine');
  const { hashPassword } = await import(pathToFileURL(coreEngineEntry).href);
  const { Client } = requireDatabaseDependency('pg');
  const client = new Client({ connectionString: databaseUrl('postgres', env.POSTGRES_PASSWORD) });
  await client.connect();
  try {
    await client.query('BEGIN');
    const email = env.DEMO_PLATFORM_ADMIN_EMAIL.toLowerCase();
    const displayName = 'Stack Platform Admin';
    const passwordHash = await hashPassword(env.DEMO_PLATFORM_ADMIN_PASSWORD);
    const inserted = await client.query(
      `INSERT INTO agentos.users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING
       RETURNING user_id`,
      [email, passwordHash, displayName],
    );
    const user = inserted.rows[0] ?? (await client.query(
      'SELECT user_id FROM agentos.users WHERE lower(email) = lower($1)',
      [email],
    )).rows[0];
    if (!user) throw new Error('STACK_AUTH_SEED_USER_FAILED');
    await client.query(
      `UPDATE agentos.users
          SET password_hash = $2, display_name = $3,
              failed_login_attempts = 0, last_failed_login_at = NULL, locked_until = NULL
        WHERE user_id = $1`,
      [user.user_id, passwordHash, displayName],
    );
    await client.query(
      `INSERT INTO agentos.tenant_memberships (tenant_id, user_id, role_bundle, status, scope)
       VALUES ($1, $2, 'PLATFORM_ADMIN', 'ACTIVE', 'platform')
       ON CONFLICT (tenant_id, user_id, scope)
       DO UPDATE SET role_bundle = EXCLUDED.role_bundle, status = 'ACTIVE', updated_at = clock_timestamp()`,
      [NOVAMART_TENANT_ID, user.user_id],
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

async function requestStackApi(path, { token, body }) {
  const response = await fetch(`${API_URL}/api/v1/${path.replace(/^\/+/, '')}`, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    // Report the status when the API returns no JSON payload.
  }
  return { response, body: responseBody };
}

async function invitationTokenFor(email) {
  for (const filename of await readdir(outboxDirectory)) {
    if (!filename.startsWith('invitation-') || !filename.endsWith('.json')) continue;
    const message = JSON.parse(await readFile(resolve(outboxDirectory, filename), 'utf8'));
    if (message?.to !== email || typeof message.invitation_url !== 'string') continue;
    const token = new URL(message.invitation_url).searchParams.get('token');
    if (token !== null && token.length > 0) return token;
  }
  throw new Error('STACK_AUTH_INVITATION_OUTBOX_MISSING');
}

async function seedDbAuthCompanyIdentities(env) {
  if (env.AUTH_PROVIDER !== 'db') return;
  const { response: loginResponse, body: loginBody } = await requestStackApi('auth/login', {
    body: {
      email: env.DEMO_PLATFORM_ADMIN_EMAIL,
      password: env.DEMO_PLATFORM_ADMIN_PASSWORD,
      audience: 'platform',
    },
  });
  if (!loginResponse.ok || loginBody?.membership?.scope !== 'platform'
    || typeof loginBody.access_token !== 'string') {
    throw new Error(`STACK_AUTH_PLATFORM_LOGIN_FAILED_HTTP_${loginResponse.status}`);
  }

  const accounts = [
    {
      email: env.DEMO_COMPANY_ADMIN_EMAIL,
      password: env.DEMO_COMPANY_ADMIN_PASSWORD,
      displayName: 'Stack Company Admin',
    },
    {
      email: env.STACK_SECOND_COMPANY_ADMIN_EMAIL,
      password: env.STACK_SECOND_COMPANY_ADMIN_PASSWORD,
      displayName: 'Stack Second Company Admin',
    },
  ];
  for (const account of accounts) {
    const { response: inviteResponse } = await requestStackApi(
      `platform/companies/${NOVAMART_TENANT_ID}/invitations`,
      {
        token: loginBody.access_token,
        body: { email: account.email, role_bundle: 'COMPANY_ADMIN' },
      },
    );
    if (inviteResponse.status !== 201) {
      throw new Error(`STACK_AUTH_COMPANY_INVITATION_FAILED_HTTP_${inviteResponse.status}`);
    }
    const token = await invitationTokenFor(account.email);
    const { response: acceptResponse } = await requestStackApi('auth/invitations/accept', {
      body: { token, password: account.password, display_name: account.displayName },
    });
    if (acceptResponse.status !== 200) {
      throw new Error(`STACK_AUTH_COMPANY_ACCEPT_FAILED_HTTP_${acceptResponse.status}`);
    }
  }
}


async function waitForApiReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${API_URL}/ready`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // Retry until the bounded readiness deadline; response bodies are intentionally ignored.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, READY_POLL_MS));
  }
  throw new Error('API did not become ready at /ready before the timeout');
}

function personasFromPack(pack) {
  const verified = pack.customers.find((customer) =>
    customer.identity_verified && customer.web_chat_identity?.verified && customer.consent?.service_chat,
  );
  const unverified = pack.customers.find((customer) =>
    !customer.identity_verified && customer.consent?.service_chat,
  );
  if (!verified || !unverified) throw new Error('Demo pack does not contain the expected chat personas');
  const shape = (customer) => ({
    customerId: customer.customer_id,
    channelIdentifier: customer.web_chat_identity.channel_identifier,
    identityVerified: customer.identity_verified,
  });
  return { verified: shape(verified), unverified: shape(unverified) };
}

async function closeStub() {
  if (!llmStub) return;
  const stub = llmStub;
  llmStub = undefined;
  await stub.close();
}

async function stopStack({ force = false } = {}) {
  let teardownError;
  if (stackStarted && (force || process.env.STACK_KEEP !== '1')) {
    try {
      await compose(['--profile', 'stacktest-consoles', 'down', '--volumes', '--remove-orphans'], 'down');
      stackStarted = false;
    } catch (error) {
      teardownError = error;
    }
  }
  try {
    await closeStub();
  } catch (error) {
    teardownError ??= error;
  } finally {
    restoreStackTestEnvironment();
  }
  if (teardownError) throw teardownError;
}

export async function globalSetup() {
  let stage = 'start LLM stub';
  try {
    // The stub itself enforces a local/CI profile. Keep any caller profile untouched afterward.
    const previousAppEnv = process.env.APP_ENV;
    process.env.APP_ENV = 'ci';
    try {
      llmStub = await startLlmStub({ port: 0 });
    } finally {
      if (previousAppEnv === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = previousAppEnv;
    }

    composeEnv = makeEnvironment(llmStub.url);
    delete composeEnv.LLM_STUB_CONTROL_TOKEN;
    exposeStackTestEnvironment(composeEnv, llmStub.controlToken);
    await mkdir(outboxDirectory, { recursive: true, mode: 0o700 });
    stage = 'build API, worker, and mock ERP images';
    await compose(['build', 'api', 'worker', 'mock-erp'], stage);
    stage = 'start isolated infrastructure';
    stackStarted = true;
    await compose(['up', '--detach', '--wait', 'postgres', 'redis', 'qdrant', 'mock-erp'], stage);

    stage = 'apply migrations as bootstrap superuser';
    const superDatabaseUrl = databaseUrl('postgres', composeEnv.POSTGRES_PASSWORD);
    await run(process.execPath, ['packages/database/scripts/rehearse-migrations.mjs'], {
      env: { ...composeEnv, DATABASE_URL: superDatabaseUrl },
      label: stage,
    });

    stage = 'seed NovaMart demo';
    await seedNovaMart({
      ...composeEnv,
      DATABASE_URL: superDatabaseUrl,
      PLATFORM_DATABASE_URL: databaseUrl('agentos_platform_login', composeEnv.PLATFORM_ROLE_PASSWORD),
      APP_ENV: 'ci',
      DEMO_MODE: 'true',
    });
    stage = 'seed DB stack platform administrator';
    await seedDbAuthPlatformAdmin(composeEnv);

    stage = 'start API and worker';
    await compose(['up', '--detach', '--wait', 'api', 'worker'], stage);

    stage = 'wait for API readiness';
    await waitForApiReady();
    if (composeEnv.AUTH_PROVIDER === 'db') {
      stage = 'bootstrap DB-auth company identities';
      await seedDbAuthCompanyIdentities(composeEnv);
    }
    if (process.env.STACK_WITH_CONSOLES === '1') {
      stage = 'start tenant and platform consoles';
      await compose(['up', '--build', '--detach', '--wait', 'tenant-console', 'platform-admin'], stage);
    }


    const pack = await loadDemoPack();
    const state = {
      apiUrl: API_URL,
      mockErpUrl: MOCK_ERP_URL,
      llmStubUrl: llmStub.url,
      superDatabaseUrl,
      tenantId: NOVAMART_TENANT_ID,
      erpTimeoutMs: Number(composeEnv.ERP_TIMEOUT_MS),
      personas: personasFromPack(pack),
      ...(composeEnv.AUTH_PROVIDER === 'db' ? {
        auth: {
          company: {
            email: composeEnv.DEMO_COMPANY_ADMIN_EMAIL,
            password: composeEnv.DEMO_COMPANY_ADMIN_PASSWORD,
          },
          platform: {
            email: composeEnv.DEMO_PLATFORM_ADMIN_EMAIL,
            password: composeEnv.DEMO_PLATFORM_ADMIN_PASSWORD,
          },
          secondCompany: {
            email: composeEnv.STACK_SECOND_COMPANY_ADMIN_EMAIL,
            password: composeEnv.STACK_SECOND_COMPANY_ADMIN_PASSWORD,
          },
        },
      } : {}),
    };
    await mkdir(dirname(STATE_FILE), { recursive: true });
    await writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    // A container that fails its health check is removed by teardown; keep its last log lines.
    const serviceLogs = stage === 'start API and worker'
      || stage === 'wait for API readiness'
      || stage === 'bootstrap DB-auth company identities'
      ? spawnSync(DOCKER, composeArgs(['logs', '--no-color', '--tail', '40', 'api', 'worker']), {
          cwd: REPO_ROOT,
          env: dockerCliEnvironment(composeEnv ?? process.env),
          encoding: 'utf8',
          windowsHide: true,
        }).stdout ?? ''
      : '';
    await stopStack({ force: true }).catch(() => undefined);
    const causeMessage = error instanceof Error ? error.message : String(error);
    throw new Error(
      `STACK_BOOT_FAILED during ${stage}: ${redactSecrets(`${causeMessage}\n${serviceLogs}`, composeEnv ?? process.env)}`,
      { cause: error },
    );
  }
}

export async function globalTeardown() {
  await stopStack();
}
