/**
 * Unit tests for `packages/core-engine/src/config/env.validator.mjs`.
 *
 * Run: `node --test packages/core-engine/test/env.validator.test.mjs`
 * No test framework, no dependencies: `node:test` + `node:assert/strict` only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseEnvironment, validateEnvironment, isPlaceholder } from '../src/config/env.validator.mjs';

const ENCRYPTION_KEY_64_HEX = '0123456789abcdef'.repeat(4);
const DATABASE_URL_LOCAL = 'postgresql://agentos_app:pg-local-password-2f8c@localhost:5432/agentos_dev?schema=agentos';
const DATABASE_URL_MANAGED = `${DATABASE_URL_LOCAL}&sslmode=verify-full`;

/**
 * A complete, valid local environment. Values are long enough and deliberately outside the
 * placeholder denylist, so the same object can be reused for managed profiles by overriding
 * `APP_ENV`, `NODE_ENV`, `DATABASE_URL` and `MOCK_ERP_ENABLED`.
 *
 * Pass `undefined` for a key to remove it from the object (absence test).
 */
function validLocalEnv(overrides = {}) {
  const env = {
    APP_ENV: 'local',
    NODE_ENV: 'development',
    PORT: '4000',
    SERVICE_NAME: 'agentos-api',

    JWT_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
    JWT_EXPIRES_IN: '24h',
    INTERNAL_API_KEY: 'zyxwvutsrqponmlkjihgfedcba987654',
    WEBHOOK_HMAC_SECRET: 'webhook-signing-value-4d7a91',
    AUDIT_HMAC_SECRET: 'audit-chain-signing-value-9b3e17',
    ENCRYPTION_KEY_AES256: ENCRYPTION_KEY_64_HEX,

    DATABASE_URL: DATABASE_URL_LOCAL,
    DATABASE_POOL_MIN: '5',
    DATABASE_POOL_MAX: '20',

    REDIS_HOST: 'localhost',
    REDIS_PORT: '6379',
    REDIS_PASSWORD: 'redis-local-password-8a3d',
    REDIS_DB: '0',
    REDIS_KEY_PREFIX: 'agentos:',
    SESSION_MUTEX_TTL_SECONDS: '30',
    IDEMPOTENCY_TTL_SECONDS: '259200',

    QDRANT_URL: 'http://localhost:6333',
    QDRANT_API_KEY: 'qdrant-local-api-key-7c1f',
    EMBEDDING_DIMENSIONS: '1536',

    OPENAI_API_KEY: 'openai-local-api-key-4b9e',
    PRIMARY_REASONING_MODEL: 'gpt-4o',
    FAST_COMPLETION_MODEL: 'gpt-4o-mini',

    ERP_API_BASE_URL: 'http://localhost:8081/api/v1',
    ERP_TIMEOUT_MS: '5000',
    EVENT_INGESTION_BASE_URL: 'http://localhost:8081/events/v1',
    EVENT_INGESTION_HMAC_SECRET: 'event-ingestion-signing-value-51',

    API_BASE_URL: 'http://localhost:4000',
    WEB_BASE_URL: 'http://localhost:3000',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000,http://localhost:8080',

    LOG_LEVEL: 'info',
    MOCK_ERP_ENABLED: 'true',
    STORAGE_PROVIDER: 's3',

    TEMPORAL_ADDRESS: 'localhost:7233',
    TEMPORAL_NAMESPACE: 'default',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Managed-profile environment: no mocks, TLS pinned, placeholder-free values. */
function managedEnv(appEnv, overrides = {}) {
  return validLocalEnv({
    APP_ENV: appEnv,
    NODE_ENV: 'production',
    LOG_LEVEL: 'info',
    MOCK_ERP_ENABLED: 'false',
    DATABASE_URL: DATABASE_URL_MANAGED,
    ENCRYPTION_KEY_AES256: 'fedcba9876543210'.repeat(4),
    ...overrides,
  });
}

/** @returns {string[]} issue paths of a failing result (`[]` when it passed) */
function failingPaths(result) {
  return result.ok ? [] : result.issues.map((issue) => issue.path);
}

/** @returns {string} the joined messages for one path, for message assertions */
function messagesFor(result, path) {
  return result.ok ? '' : result.issues.filter((issue) => issue.path === path).map((issue) => issue.message).join(' | ');
}

function expectOk(result) {
  assert.equal(result.ok, true, result.ok ? '' : `unexpected issues: ${JSON.stringify(result.issues, null, 2)}`);
  return result.data;
}

function expectFailure(result, path) {
  assert.equal(result.ok, false, 'expected validation to fail');
  assert.ok(failingPaths(result).includes(path), `expected an issue for ${path}, got ${JSON.stringify(result.issues)}`);
  return messagesFor(result, path);
}

test('accepts a complete local environment and applies the documented defaults', () => {
  const data = expectOk(
    parseEnvironment(
      validLocalEnv({
        PORT: undefined,
        JWT_EXPIRES_IN: undefined,
        DATABASE_POOL_MIN: undefined,
        DATABASE_POOL_MAX: undefined,
        REDIS_PORT: undefined,
        REDIS_KEY_PREFIX: undefined,
        REDIS_DB: undefined,
        SESSION_MUTEX_TTL_SECONDS: undefined,
        IDEMPOTENCY_TTL_SECONDS: undefined,
        EMBEDDING_DIMENSIONS: undefined,
        PRIMARY_REASONING_MODEL: undefined,
        FAST_COMPLETION_MODEL: undefined,
        ERP_TIMEOUT_MS: undefined,
        LOG_LEVEL: undefined,
        TEMPORAL_NAMESPACE: undefined,
      }),
    ),
  );

  assert.equal(data.APP_ENV, 'local');
  assert.equal(data.NODE_ENV, 'development');
  assert.equal(data.PORT, 4000);
  assert.equal(data.SERVICE_NAME, 'agentos-api');
  assert.equal(data.JWT_EXPIRES_IN, '24h');
  assert.equal(data.DATABASE_POOL_MIN, 5);
  assert.equal(data.DATABASE_POOL_MAX, 20);
  assert.equal(data.REDIS_PORT, 6379);
  assert.equal(data.REDIS_KEY_PREFIX, 'agentos:');
  assert.equal(data.REDIS_DB, 0);
  assert.equal(data.SESSION_MUTEX_TTL_SECONDS, 30);
  assert.equal(data.IDEMPOTENCY_TTL_SECONDS, 259200);
  assert.equal(data.EMBEDDING_DIMENSIONS, 1536);
  assert.equal(data.PRIMARY_REASONING_MODEL, 'gpt-4o');
  assert.equal(data.FAST_COMPLETION_MODEL, 'gpt-4o-mini');
  assert.equal(data.ERP_TIMEOUT_MS, 5000);
  assert.equal(data.LOG_LEVEL, 'info');
  assert.equal(data.STORAGE_PROVIDER, 's3');
  assert.equal(data.MOCK_ERP_ENABLED, true);
  assert.equal(data.TEMPORAL_NAMESPACE, 'default');
});

test('missing APP_ENV fails and names APP_ENV', () => {
  const result = parseEnvironment(validLocalEnv({ APP_ENV: undefined }));

  expectFailure(result, 'APP_ENV');
  assert.match(messagesFor(result, 'APP_ENV'), /APP_ENV/);
});

test('unknown APP_ENV is rejected', () => {
  expectFailure(parseEnvironment(validLocalEnv({ APP_ENV: 'qa' })), 'APP_ENV');
  expectFailure(parseEnvironment(validLocalEnv({ APP_ENV: 'LOCAL' })), 'APP_ENV');
});

test('NODE_ENV is required, validated, and mapped from APP_ENV (never the other way round)', () => {
  expectFailure(parseEnvironment(validLocalEnv({ NODE_ENV: undefined })), 'NODE_ENV');
  expectFailure(parseEnvironment(validLocalEnv({ NODE_ENV: 'staging' })), 'NODE_ENV');

  // A NODE_ENV that looks like a profile must not select one: APP_ENV stays required.
  expectFailure(parseEnvironment(validLocalEnv({ APP_ENV: undefined, NODE_ENV: 'production' })), 'APP_ENV');
});

test('APP_ENV=staging with NODE_ENV=development fails the mapping and names both variables', () => {
  const message = expectFailure(parseEnvironment(managedEnv('staging', { NODE_ENV: 'development' })), 'NODE_ENV');

  assert.match(message, /NODE_ENV/);
  assert.match(message, /APP_ENV/);
  // A matching NODE_ENV is accepted for every managed profile, and ci maps to test.
  expectOk(parseEnvironment(managedEnv('staging')));
  expectOk(parseEnvironment(managedEnv('sandbox')));
  expectOk(parseEnvironment(managedEnv('production')));
  expectOk(parseEnvironment(validLocalEnv({ APP_ENV: 'ci', NODE_ENV: 'test' })));
  expectFailure(parseEnvironment(validLocalEnv({ APP_ENV: 'ci', NODE_ENV: 'production' })), 'NODE_ENV');
  expectFailure(parseEnvironment(validLocalEnv({ APP_ENV: 'local', NODE_ENV: 'production' })), 'NODE_ENV');
});

test('placeholder secrets are refused in managed profiles and the report never carries the value', () => {
  const sentinel = 'mock-jwt-sentinel-must-not-be-printed-9f2b7c1a4e';
  const result = parseEnvironment(managedEnv('staging', { JWT_SECRET: sentinel }));

  expectFailure(result, 'JWT_SECRET');
  assert.ok(!JSON.stringify(result.issues).includes(sentinel), 'issue messages must not contain the rejected value');

  // Local/CI may still run on placeholders.
  expectOk(parseEnvironment(validLocalEnv({ JWT_SECRET: sentinel })));

  // Banner values from the blueprint are refused in managed profiles too, even when they do
  // not match the generic placeholder pattern.
  expectFailure(
    parseEnvironment(managedEnv('production', { INTERNAL_API_KEY: 'agentos_internal_service_mesh_key_64_characters_min' })),
    'INTERNAL_API_KEY',
  );
  expectFailure(
    parseEnvironment(managedEnv('staging', { ENCRYPTION_KEY_AES256: ENCRYPTION_KEY_64_HEX })),
    'ENCRYPTION_KEY_AES256',
  );
  expectFailure(
    parseEnvironment(
      managedEnv('sandbox', {
        DATABASE_URL: 'postgresql://agentos_app:postgres_dev_secret_password@db.internal:5432/agentos?sslmode=verify-full',
      }),
    ),
    'DATABASE_URL',
  );
  expectFailure(
    parseEnvironment(managedEnv('staging', { OPENAI_API_KEY: 'sk-proj-mock-or-valid-openai-key-here' })),
    'OPENAI_API_KEY',
  );
});

test('ENCRYPTION_KEY_AES256 must be exactly 64 hex characters (never cropped or padded)', () => {
  expectOk(parseEnvironment(validLocalEnv()));
  expectFailure(parseEnvironment(validLocalEnv({ ENCRYPTION_KEY_AES256: '0123456789abcdef'.repeat(4).slice(0, 63) })), 'ENCRYPTION_KEY_AES256');
  expectFailure(parseEnvironment(validLocalEnv({ ENCRYPTION_KEY_AES256: `${ENCRYPTION_KEY_64_HEX}ab` })), 'ENCRYPTION_KEY_AES256');
  expectFailure(parseEnvironment(validLocalEnv({ ENCRYPTION_KEY_AES256: `${'z'.repeat(63)}` })), 'ENCRYPTION_KEY_AES256');
  expectFailure(parseEnvironment(validLocalEnv({ ENCRYPTION_KEY_AES256: undefined })), 'ENCRYPTION_KEY_AES256');
});

test('DATABASE_URL must be a postgres URI and pin verify-full TLS outside local/ci', () => {
  const mysqlMessage = expectFailure(
    parseEnvironment(validLocalEnv({ DATABASE_URL: 'mysql://agentos_app:pg-local-password-2f8c@localhost:3306/agentos_dev' })),
    'DATABASE_URL',
  );
  assert.match(mysqlMessage, /postgres/);

  expectFailure(parseEnvironment(managedEnv('staging', { DATABASE_URL: DATABASE_URL_LOCAL })), 'DATABASE_URL');
  expectFailure(
    parseEnvironment(managedEnv('staging', { DATABASE_URL: `${DATABASE_URL_LOCAL}&sslmode=require` })),
    'DATABASE_URL',
  );

  // Local and CI keep the plain local connection string; managed profiles accept verify-full.
  expectOk(parseEnvironment(validLocalEnv()));
  expectOk(parseEnvironment(validLocalEnv({ APP_ENV: 'ci', NODE_ENV: 'test' })));
  expectOk(parseEnvironment(managedEnv('production')));
});

test('MOCK_ERP_ENABLED=true is refused in sandbox and production and allowed in local and ci', () => {
  for (const appEnv of ['sandbox', 'production']) {
    expectFailure(parseEnvironment(managedEnv(appEnv, { MOCK_ERP_ENABLED: 'true' })), 'MOCK_ERP_ENABLED');
  }
  expectOk(parseEnvironment(validLocalEnv({ MOCK_ERP_ENABLED: 'true' })));
  expectOk(parseEnvironment(validLocalEnv({ APP_ENV: 'ci', NODE_ENV: 'test', MOCK_ERP_ENABLED: 'true' })));
});

test('MOCK_ERP_ENABLED defaults to true only for local and ci', () => {
  assert.equal(expectOk(parseEnvironment(validLocalEnv({ MOCK_ERP_ENABLED: undefined }))).MOCK_ERP_ENABLED, true);
  assert.equal(
    expectOk(parseEnvironment(validLocalEnv({ APP_ENV: 'ci', NODE_ENV: 'test', MOCK_ERP_ENABLED: undefined }))).MOCK_ERP_ENABLED,
    true,
  );
  assert.equal(expectOk(parseEnvironment(managedEnv('production', { MOCK_ERP_ENABLED: undefined }))).MOCK_ERP_ENABLED, false);
  expectFailure(parseEnvironment(validLocalEnv({ MOCK_ERP_ENABLED: 'sometimes' })), 'MOCK_ERP_ENABLED');
});

test('optional adapter credential sets are all-or-nothing and never defaulted', () => {
  const partialMessage = expectFailure(parseEnvironment(validLocalEnv({ LINE_CHANNEL_ID: 'line-channel-2f81' })), 'LINE_CHANNEL_ID');
  assert.match(partialMessage, /LINE_CHANNEL_SECRET/);

  const complete = expectOk(
    parseEnvironment(
      validLocalEnv({
        LINE_CHANNEL_ID: 'line-channel-2f81',
        LINE_CHANNEL_SECRET: 'line-channel-secret-6a1c',
        LINE_CHANNEL_ACCESS_TOKEN: 'line-access-token-77bd',
        EMAIL_PROVIDER: 'sendgrid',
        EMAIL_API_KEY: 'email-provider-api-key-31c9',
        EMAIL_WEBHOOK_SIGNING_KEY: 'email-webhook-signing-key-2ab4',
        STRIPE_SECRET_KEY: 'stripe-secret-key-9d2e',
        STRIPE_WEBHOOK_SECRET: 'stripe-webhook-secret-4c71',
      }),
    ),
  );
  assert.equal(complete.LINE_CHANNEL_ACCESS_TOKEN, 'line-access-token-77bd');
  assert.equal(complete.EMAIL_PROVIDER, 'sendgrid');
  assert.equal(complete.STRIPE_WEBHOOK_SECRET, 'stripe-webhook-secret-4c71');

  // An absent set leaves the adapter disabled; nothing is defaulted to a mock credential.
  const absent = expectOk(parseEnvironment(validLocalEnv()));
  assert.equal(absent.LINE_CHANNEL_ID, undefined);
  assert.equal(absent.EMAIL_API_KEY, undefined);
  assert.equal(absent.STRIPE_SECRET_KEY, undefined);

  // Credentials without their provider are still a half-configured adapter.
  expectFailure(
    parseEnvironment(validLocalEnv({ EMAIL_API_KEY: 'email-provider-api-key-31c9', EMAIL_WEBHOOK_SIGNING_KEY: 'email-webhook-signing-key-2ab4' })),
    'EMAIL_PROVIDER',
  );
});

test('CORS_ALLOWED_ORIGINS must be a URL list and refuses the wildcard outside local/ci', () => {
  expectFailure(parseEnvironment(managedEnv('staging', { CORS_ALLOWED_ORIGINS: '*' })), 'CORS_ALLOWED_ORIGINS');
  expectFailure(parseEnvironment(managedEnv('sandbox', { CORS_ALLOWED_ORIGINS: 'https://admin.example.org,*' })), 'CORS_ALLOWED_ORIGINS');
  expectOk(parseEnvironment(validLocalEnv({ CORS_ALLOWED_ORIGINS: '*' })));
  expectFailure(parseEnvironment(validLocalEnv({ CORS_ALLOWED_ORIGINS: 'http://localhost:3000,not-a-url' })), 'CORS_ALLOWED_ORIGINS');
  expectFailure(parseEnvironment(validLocalEnv({ CORS_ALLOWED_ORIGINS: undefined })), 'CORS_ALLOWED_ORIGINS');
});

test('LOG_LEVEL is an enum and debug is refused outside local/ci', () => {
  expectFailure(parseEnvironment(managedEnv('staging', { LOG_LEVEL: 'debug' })), 'LOG_LEVEL');
  expectFailure(parseEnvironment(validLocalEnv({ LOG_LEVEL: 'trace' })), 'LOG_LEVEL');
  assert.equal(expectOk(parseEnvironment(validLocalEnv({ LOG_LEVEL: 'debug' }))).LOG_LEVEL, 'debug');
  assert.equal(expectOk(parseEnvironment(managedEnv('production', { LOG_LEVEL: 'error' }))).LOG_LEVEL, 'error');
});

test('STORAGE_PROVIDER and PAYPAL_MODE follow the profile policy', () => {
  expectFailure(parseEnvironment(managedEnv('staging', { STORAGE_PROVIDER: 'local' })), 'STORAGE_PROVIDER');
  expectFailure(parseEnvironment(validLocalEnv({ STORAGE_PROVIDER: 'gcs' })), 'STORAGE_PROVIDER');
  assert.equal(expectOk(parseEnvironment(validLocalEnv({ STORAGE_PROVIDER: 'local' }))).STORAGE_PROVIDER, 'local');
  assert.equal(expectOk(parseEnvironment(managedEnv('production', { STORAGE_PROVIDER: 'r2' }))).STORAGE_PROVIDER, 'r2');

  expectFailure(parseEnvironment(managedEnv('staging', { PAYPAL_MODE: 'live' })), 'PAYPAL_MODE');
  expectFailure(parseEnvironment(managedEnv('sandbox', { PAYPAL_MODE: 'live' })), 'PAYPAL_MODE');
  assert.equal(expectOk(parseEnvironment(managedEnv('production', { PAYPAL_MODE: 'live' }))).PAYPAL_MODE, 'live');
  assert.equal(expectOk(parseEnvironment(validLocalEnv({ PAYPAL_MODE: 'sandbox' }))).PAYPAL_MODE, 'sandbox');
});

test('numeric and duration fields reject out-of-range or malformed values', () => {
  expectFailure(parseEnvironment(validLocalEnv({ PORT: '70000' })), 'PORT');
  expectFailure(parseEnvironment(validLocalEnv({ PORT: '0' })), 'PORT');
  expectFailure(parseEnvironment(validLocalEnv({ PORT: '4000.5' })), 'PORT');
  expectFailure(parseEnvironment(validLocalEnv({ JWT_EXPIRES_IN: 'twenty-four-hours' })), 'JWT_EXPIRES_IN');
  expectFailure(parseEnvironment(validLocalEnv({ REDIS_DB: '-1' })), 'REDIS_DB');
  expectFailure(parseEnvironment(validLocalEnv({ SESSION_MUTEX_TTL_SECONDS: '0' })), 'SESSION_MUTEX_TTL_SECONDS');
  expectFailure(parseEnvironment(validLocalEnv({ IDEMPOTENCY_TTL_SECONDS: '-5' })), 'IDEMPOTENCY_TTL_SECONDS');
  expectFailure(parseEnvironment(validLocalEnv({ EMBEDDING_DIMENSIONS: '0' })), 'EMBEDDING_DIMENSIONS');
  expectFailure(parseEnvironment(validLocalEnv({ DATABASE_POOL_MIN: '30', DATABASE_POOL_MAX: '20' })), 'DATABASE_POOL_MAX');
  expectFailure(parseEnvironment(validLocalEnv({ DATABASE_POOL_MAX: '3' })), 'DATABASE_POOL_MAX');

  const data = expectOk(parseEnvironment(validLocalEnv({ JWT_EXPIRES_IN: '30m', PORT: '8080', REDIS_DB: '3' })));
  assert.equal(data.JWT_EXPIRES_IN, '30m');
  assert.equal(data.PORT, 8080);
  assert.equal(data.REDIS_DB, 3);
});

test('replication URLs and temporal settings are validated when present', () => {
  expectFailure(
    parseEnvironment(managedEnv('staging', { POSTGRES_PRIMARY_URL: 'postgresql://agentos_app:pg-local-password-2f8c@primary.internal:5432/agentos' })),
    'POSTGRES_PRIMARY_URL',
  );
  expectFailure(parseEnvironment(validLocalEnv({ POSTGRES_REPLICA_URL: 'mysql://replica.internal:3306/agentos' })), 'POSTGRES_REPLICA_URL');

  const data = expectOk(
    parseEnvironment(
      managedEnv('production', {
        POSTGRES_PRIMARY_URL: 'postgresql://agentos_app:pg-local-password-2f8c@primary.internal:5432/agentos?sslmode=verify-full',
        POSTGRES_REPLICA_URL: 'postgresql://agentos_app:pg-local-password-2f8c@replica.internal:5432/agentos?sslmode=verify-full',
      }),
    ),
  );
  assert.equal(data.POSTGRES_PRIMARY_URL, 'postgresql://agentos_app:pg-local-password-2f8c@primary.internal:5432/agentos?sslmode=verify-full');

  expectFailure(parseEnvironment(validLocalEnv({ TEMPORAL_ADDRESS: 'localhost' })), 'TEMPORAL_ADDRESS');
  const withoutTemporal = expectOk(parseEnvironment(validLocalEnv({ TEMPORAL_ADDRESS: '', TEMPORAL_NAMESPACE: undefined })));
  assert.equal(withoutTemporal.TEMPORAL_ADDRESS, undefined);
  assert.equal(withoutTemporal.TEMPORAL_NAMESPACE, undefined);
});

test('validateEnvironment prints a FATAL report and exits 1 without echoing the rejected value', () => {
  const sentinel = 'placeholder-audit-value-must-not-be-printed-7f21';
  const env = managedEnv('production', { AUDIT_HMAC_SECRET: sentinel });
  const originalError = console.error;
  const originalExit = process.exit;

  let stderr = '';
  let exitCode;
  console.error = (...args) => {
    stderr += `${args.join(' ')}\n`;
  };
  process.exit = (code) => {
    exitCode = code;
    throw new Error('__ENV_VALIDATOR_EXIT__');
  };

  try {
    assert.throws(() => validateEnvironment(env), /__ENV_VALIDATOR_EXIT__/);
  } finally {
    console.error = originalError;
    process.exit = originalExit;
  }

  assert.equal(exitCode, 1);
  const lines = stderr.trimEnd().split('\n');
  assert.equal(lines[0], 'FATAL: Environment validation failed');
  assert.ok(lines.length > 1, 'expected one line per issue after the FATAL line');
  assert.ok(
    lines.slice(1).every((line) => /^\[[A-Z0-9_]+\] .+/.test(line)),
    `unexpected issue lines: ${JSON.stringify(lines)}`,
  );
  assert.ok(lines.some((line) => line.startsWith('[AUDIT_HMAC_SECRET]')));
  assert.ok(!stderr.includes(sentinel), 'the fail-closed report must not contain the rejected value');
});

test('validateEnvironment returns the parsed configuration when the environment is valid', () => {
  const data = validateEnvironment(validLocalEnv({ MOCK_ERP_ENABLED: undefined }));

  assert.equal(data.APP_ENV, 'local');
  assert.equal(data.MOCK_ERP_ENABLED, true);
  assert.equal(data.PORT, 4000);
});

test('isPlaceholder flags pattern and banner values only', () => {
  assert.equal(isPlaceholder('mock_jwt_value'), true);
  assert.equal(isPlaceholder('sk-proj-mock-or-valid-openai-key-here'), true);
  assert.equal(isPlaceholder('change-me'), true);
  assert.equal(isPlaceholder('change_me'), true);
  assert.equal(isPlaceholder('test-secret'), true);
  assert.equal(isPlaceholder('no-reply@example.invalid'), true);
  assert.equal(isPlaceholder('postgres_dev_secret_password'), true);
  assert.equal(isPlaceholder('abcdefghijklmnopqrstuvwxyz012345'), false);
  assert.equal(isPlaceholder('agentos:'), false);
  assert.equal(isPlaceholder(''), false);
  assert.equal(isPlaceholder(undefined), false);
});
