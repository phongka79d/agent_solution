import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { parseCommandCenterEnv } from '../../command-center/src/server.mjs';
import { start } from '../src/server.mjs';

const SENTINEL = 'SENTINEL_SECRET_VALUE_DO_NOT_LEAK_123456';

function validEnv() {
  return {
    APP_ENV: 'local',
    NODE_ENV: 'development',
    SERVICE_NAME: 'agentos-api',
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
    MOCK_ERP_ENABLED: 'false',
    KNOWLEDGE_ANSWERS_ENABLED: 'false',
  };
}

function get(port, path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, body: JSON.parse(text), text });
      });
    }).on('error', reject);
  });
}

test('invalid environment does not listen and does not leak the secret', async () => {
  const stderr = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    stderr.push(Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk));
    return original.call(process.stderr, chunk, ...rest);
  };
  try {
    const result = await start({ JWT_SECRET: SENTINEL }, { exitOnInvalid: false, host: '127.0.0.1' });
    assert.equal(result.ok, false);
    assert.equal(result.listening, false);
    assert.equal(result.server, undefined);
    const report = stderr.join('');
    assert.match(report, /\[APP_ENV\]/);
    assert.equal(report.includes(SENTINEL), false);
  } finally {
    process.stderr.write = original;
  }
});

test('unready dependencies keep liveness up and readiness down', async () => {
  const probes = {
    postgres: async () => ({ ok: false, reason: 'unreachable' }),
    redis: async () => ({ ok: true }),
  };
  const result = await start(validEnv(), {
    exitOnInvalid: false,
    exitOnUnready: false,
    host: '127.0.0.1',
    port: 0,
    attempts: 1,
    intervalMs: 0,
    probes,
  });
  assert.equal(result.listening, true, JSON.stringify(result.issues ?? result.failures));
  try {
    const health = await get(result.port, '/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    const ready = await get(result.port, '/ready');
    assert.equal(ready.status, 503);
    assert.equal(ready.body.failures.some((failure) => failure.dependency === 'postgres'), true);
    assert.equal(ready.text.includes('redis-local-password-8a3d'), false);
  } finally {
    result.server?.close();
  }
});

test('command center rejects an API URL that includes /api/v1', async () => {
  const rejected = parseCommandCenterEnv({
    APP_ENV: 'local',
    NODE_ENV: 'development',
    NEXTAUTH_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
    NEXTAUTH_URL: 'http://localhost:3000',
    NEXT_PUBLIC_API_URL: 'http://localhost:4000/api/v1',
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.issues.some((issue) => issue.path === 'NEXT_PUBLIC_API_URL'), true);

  const accepted = parseCommandCenterEnv({
    APP_ENV: 'local',
    NODE_ENV: 'development',
    NEXTAUTH_SECRET: 'abcdefghijklmnopqrstuvwxyz012345',
    NEXTAUTH_URL: 'http://localhost:3000',
    NEXT_PUBLIC_API_URL: 'http://localhost:4000',
  });
  assert.equal(accepted.ok, true);
});
