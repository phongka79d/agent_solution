/**
 * Unit tests for `packages/core-engine/src/config/readiness.mjs`.
 *
 * Run: `node --test packages/core-engine/test/readiness.test.mjs`
 * Every probe is injected, so the tests never open a socket. The environment fixture is
 * deliberately self-contained (rather than imported from the validator test) so each test
 * file can run on its own without registering the other file's tests.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { requiredDependencies, checkReadiness, assertStartup } from '../src/config/readiness.mjs';

const DEPENDENCIES = ['postgres', 'redis', 'qdrant', 'sor', 'temporal'];

/** A complete, valid local environment (managed-clean values, as in the validator tests). */
function validEnv(overrides = {}) {
  const env = {
    APP_ENV: 'local',
    NODE_ENV: 'development',
    JWT_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
    INTERNAL_API_KEY: 'zyxwvutsrqponmlkjihgfedcba987654',
    WEBHOOK_HMAC_SECRET: 'webhook-signing-value-4d7a91',
    AUDIT_HMAC_SECRET: 'audit-chain-signing-value-9b3e17',
    ENCRYPTION_KEY_AES256: '0123456789abcdef'.repeat(4),
    DATABASE_URL: 'postgresql://agentos_app:pg-local-password-2f8c@localhost:5432/agentos_dev?schema=agentos',
    REDIS_HOST: 'localhost',
    REDIS_PASSWORD: 'redis-local-password-8a3d',
    QDRANT_URL: 'http://localhost:6333',
    QDRANT_API_KEY: 'qdrant-local-api-key-7c1f',
    OPENAI_API_KEY: 'openai-local-api-key-4b9e',
    ERP_API_BASE_URL: 'http://localhost:8081/api/v1',
    EVENT_INGESTION_BASE_URL: 'http://localhost:8081/events/v1',
    EVENT_INGESTION_HMAC_SECRET: 'event-ingestion-signing-value-51',
    API_BASE_URL: 'http://localhost:4000',
    WEB_BASE_URL: 'http://localhost:3000',
    CORS_ALLOWED_ORIGINS: 'http://localhost:3000',
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Minimal environment for readiness-only tests (no configuration validation involved). */
function readinessEnv(overrides = {}) {
  return {
    APP_ENV: 'local',
    KNOWLEDGE_ANSWERS_ENABLED: 'false',
    MOCK_ERP_ENABLED: 'false',
    TEMPORAL_ADDRESS: '',
    ...overrides,
  };
}

/**
 * Builds a probe set covering all five dependencies. Unspecified dependencies throw when
 * called, so any probe that should not run fails the test loudly.
 *
 * @param {Record<string, { ok?: boolean, reason?: string } | string | Error | 'forbidden'>} outcomes
 * @param {string[]} calls
 */
function probeSet(outcomes, calls) {
  const probes = {};
  for (const dependency of DEPENDENCIES) {
    const spec = outcomes[dependency] ?? 'forbidden';
    probes[dependency] = async () => {
      calls.push(dependency);
      if (spec === 'forbidden') throw new Error(`${dependency} probe must not be called`);
      if (spec instanceof Error) throw spec;
      if (typeof spec === 'string') return { ok: false, reason: spec };
      return spec;
    };
  }
  return probes;
}

test('requiredDependencies returns the probe order and honours each enable flag', () => {
  assert.deepEqual(requiredDependencies({ APP_ENV: 'local', TEMPORAL_ADDRESS: 'localhost:7233' }), [
    'postgres',
    'redis',
    'qdrant',
    'sor',
    'temporal',
  ]);
  // Only the exact string "false" disables the knowledge store.
  assert.deepEqual(requiredDependencies({ APP_ENV: 'local', KNOWLEDGE_ANSWERS_ENABLED: 'false' }), ['postgres', 'redis', 'sor']);
  assert.deepEqual(requiredDependencies({ APP_ENV: 'local', KNOWLEDGE_ANSWERS_ENABLED: 'no' }), ['postgres', 'redis', 'qdrant', 'sor']);
  // Mock system-of-record: explicit false, absent in a managed profile, unknown profile.
  assert.deepEqual(requiredDependencies({ APP_ENV: 'local', MOCK_ERP_ENABLED: 'false', KNOWLEDGE_ANSWERS_ENABLED: 'false' }), [
    'postgres',
    'redis',
  ]);
  assert.deepEqual(requiredDependencies({ APP_ENV: 'production' }), ['postgres', 'redis', 'qdrant']);
  assert.deepEqual(requiredDependencies({}), ['postgres', 'redis', 'qdrant']);
  // A blank TEMPORAL_ADDRESS means the durable engine is disabled, so it is not probed.
  assert.deepEqual(
    requiredDependencies({ APP_ENV: 'local', KNOWLEDGE_ANSWERS_ENABLED: 'false', MOCK_ERP_ENABLED: 'false', TEMPORAL_ADDRESS: '' }),
    ['postgres', 'redis'],
  );
});

test('checkReadiness probes only required dependencies, in order, and collects failures', async () => {
  const calls = [];
  const result = await checkReadiness(
    readinessEnv(),
    probeSet({ postgres: 'unreachable', redis: { ok: true } }, calls),
  );

  assert.equal(result.ready, false);
  assert.deepEqual(result.failures, [{ dependency: 'postgres', reason: 'unreachable' }]);
  // qdrant, sor and temporal probes exist but are never called for this environment.
  assert.deepEqual(calls, ['postgres', 'redis']);
});

test('checkReadiness reports every failing dependency instead of short-circuiting', async () => {
  const calls = [];
  const result = await checkReadiness(
    readinessEnv({ MOCK_ERP_ENABLED: 'true' }),
    probeSet({ postgres: 'unreachable', redis: 'auth_failed', sor: { ok: false } }, calls),
  );

  assert.equal(result.ready, false);
  assert.deepEqual(result.failures, [
    { dependency: 'postgres', reason: 'unreachable' },
    { dependency: 'redis', reason: 'auth_failed' },
    { dependency: 'sor', reason: 'not ready' },
  ]);
  assert.deepEqual(calls, ['postgres', 'redis', 'sor']);
});

test('MOCK_ERP_ENABLED=false omits sor from requiredDependencies and never calls the sor probe', async () => {
  const env = readinessEnv({ MOCK_ERP_ENABLED: 'false' });
  assert.ok(!requiredDependencies(env).includes('sor'));

  const calls = [];
  const result = await checkReadiness(env, probeSet({ postgres: { ok: true }, redis: { ok: true } }, calls));

  assert.deepEqual(result, { ready: true, failures: [] });
  assert.deepEqual(calls, ['postgres', 'redis']);

  // With the mock boundary enabled, sor is required and a sor failure is reported.
  const mockCalls = [];
  const withMock = await checkReadiness(
    readinessEnv({ MOCK_ERP_ENABLED: 'true' }),
    probeSet({ postgres: { ok: true }, redis: { ok: true }, sor: 'system-of-record unreachable' }, mockCalls),
  );
  assert.equal(withMock.ready, false);
  assert.deepEqual(withMock.failures, [{ dependency: 'sor', reason: 'system-of-record unreachable' }]);
  assert.ok(mockCalls.includes('sor'));
});

test('an injected postgres failure marks the stack not ready without requiring qdrant', async () => {
  const calls = [];
  const env = readinessEnv({ KNOWLEDGE_ANSWERS_ENABLED: 'false' });
  const result = await checkReadiness(env, probeSet({ postgres: 'unreachable', redis: { ok: true } }, calls));

  assert.equal(result.ready, false);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].dependency, 'postgres');
  assert.ok(!requiredDependencies(env).includes('qdrant'));
  assert.ok(!calls.includes('qdrant'));
});

test('assertStartup reports configuration failures and calls no probe', async () => {
  const calls = [];
  const result = await assertStartup(validEnv({ APP_ENV: undefined }), probeSet({}, calls));

  assert.equal(result.ready, false);
  assert.deepEqual(calls, []);
  assert.deepEqual(result.failures, [{ dependency: 'config', reason: 'APP_ENV' }]);
  assert.ok(result.configIssues.length > 0);
  assert.ok(result.configIssues.every((issue) => typeof issue.path === 'string' && typeof issue.message === 'string'));
  assert.ok(result.configIssues.some((issue) => issue.path === 'APP_ENV'));
});

test('assertStartup returns ready when the configuration and every required probe pass', async () => {
  const calls = [];
  const env = validEnv({ MOCK_ERP_ENABLED: 'false', TEMPORAL_ADDRESS: '' });
  const result = await assertStartup(env, probeSet({ postgres: { ok: true }, redis: { ok: true }, qdrant: { ok: true } }, calls));

  assert.deepEqual(result, { ready: true, failures: [], configIssues: [] });
  assert.deepEqual(calls, ['postgres', 'redis', 'qdrant']);
});

test('failure reasons never echo environment secret values', async () => {
  const env = validEnv({ MOCK_ERP_ENABLED: 'false', TEMPORAL_ADDRESS: '' });
  const calls = [];
  const result = await checkReadiness(
    env,
    probeSet(
      {
        postgres: { ok: false, reason: `authentication failed for ${env.REDIS_PASSWORD}` },
        redis: new Error(`connect failed using ${env.DATABASE_URL}`),
        qdrant: { ok: true },
      },
      calls,
    ),
  );

  assert.equal(result.ready, false);
  assert.deepEqual(result.failures.map((failure) => failure.dependency), ['postgres', 'redis']);

  const serialized = JSON.stringify(result.failures);
  assert.ok(!serialized.includes(env.REDIS_PASSWORD), 'reasons must not contain the redis password');
  assert.ok(!serialized.includes(env.DATABASE_URL), 'reasons must not contain the database URI');
  assert.equal(result.failures[0].reason, 'authentication failed for [REDACTED]');
  assert.equal(result.failures[1].reason, 'probe threw: connect failed using [REDACTED]');
});
