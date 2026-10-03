import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parseEnvFile, REQUIRED_LIVE_ENV, runLivePreflight, validateLiveEnvironment } from './preflight.mjs';

const validEnvironment = Object.freeze({
  APP_ENV: 'local',
  DEMO_MODE: 'true',
  DEMO_PROVIDER_MODE: 'live',
  DEMO_TENANT_ID: '99999999-9999-4999-8999-999999999999',
  DATABASE_URL: 'postgresql://agentos:local-password@127.0.0.1:5432/agentos_live_test',
  API_BASE_URL: 'http://127.0.0.1:4000',
  WEB_BASE_URL: 'http://127.0.0.1:3000',
  DEMO_COMPANY_ADMIN_EMAIL: 'company-admin@example.test',
  DEMO_COMPANY_ADMIN_PASSWORD: 'demo-test-company-password',
  DEMO_PLATFORM_ADMIN_EMAIL: 'platform-admin@example.test',
  DEMO_PLATFORM_ADMIN_PASSWORD: 'demo-test-platform-password',
  OPENAI_API_KEY: 'sk-live-key-not-real-for-tests',
  OPENAI_BASE_URL: 'https://api.example.test/v1',
  PRIMARY_REASONING_MODEL: 'reasoning-model-test',
  LIVE_MAX_LLM_CALLS: '12',
  LIVE_ALLOWED_LLM_HOSTS: 'api.example.test',
});


describe('live preflight', () => {
  it('accepts a dedicated demo database and an explicitly allowlisted provider host', () => {
    assert.deepEqual(validateLiveEnvironment(validEnvironment), {
      requiredVariablesChecked: REQUIRED_LIVE_ENV.length,
    });
  });

  it('identifies missing, empty, and placeholder variable names without echoing values', () => {
    const environment = {
      ...validEnvironment,
      DATABASE_URL: '',
      OPENAI_API_KEY: 'sk-xxx-not-a-provider-key',
      PRIMARY_REASONING_MODEL: 'changeme',
    };
    assert.throws(() => validateLiveEnvironment(environment), (error) => {
      assert.match(error.message, /DATABASE_URL/);
      assert.match(error.message, /OPENAI_API_KEY/);
      assert.match(error.message, /PRIMARY_REASONING_MODEL/);
      assert.doesNotMatch(error.message, /sk-xxx-not-a-provider-key|changeme/);
      return true;
    });
  });

  it('rejects non-live mode, non-isolated databases, invalid budgets, and unapproved hosts', () => {
    assert.throws(() => validateLiveEnvironment({
      ...validEnvironment,
      APP_ENV: 'production',
      DATABASE_URL: 'postgresql://app:secret@db.example.test/agentos_production',
      LIVE_MAX_LLM_CALLS: 'not-a-number',
      OPENAI_BASE_URL: 'https://unapproved.example.test/v1',
    }), (error) => {
      for (const name of ['APP_ENV', 'DATABASE_URL', 'LIVE_MAX_LLM_CALLS', 'OPENAI_BASE_URL']) {
        assert.match(error.message, new RegExp(name));
      }
      return true;
    });
    assert.throws(() => validateLiveEnvironment({
      ...validEnvironment,
      DATABASE_URL: 'https://db.example.test/agentos_live_test',
    }), /DATABASE_URL/);
  });

  it('refuses a dedicated-looking database name on a remote PostgreSQL host', () => {
    assert.throws(
      () => validateLiveEnvironment({
        ...validEnvironment,
        DATABASE_URL: 'postgresql://agentos_app:secret@db.example.test/agentos_live_test',
      }),
      /DATABASE_URL must target a local PostgreSQL server/,
    );
  });

  it('refuses live API and web endpoints that do not target local loopback services', () => {
    assert.throws(
      () => validateLiveEnvironment({ ...validEnvironment, API_BASE_URL: 'https://api.example.test/v1' }),
      /API_BASE_URL must be an HTTP loopback origin/,
    );
    assert.throws(
      () => validateLiveEnvironment({ ...validEnvironment, WEB_BASE_URL: 'http://company.example.test' }),
      /WEB_BASE_URL must be an HTTP loopback origin/,
    );
  });

  it('requires HTTPS for non-loopback provider endpoints', () => {
    assert.throws(
      () => validateLiveEnvironment({
        ...validEnvironment,
        OPENAI_BASE_URL: 'http://api.example.test/v1',
      }),
      /OPENAI_BASE_URL must use HTTPS for non-loopback providers/,
    );
  });



  it('parses standard assignments without exposing values in parser errors', () => {
    assert.deepEqual(parseEnvFile('\uFEFF# comment\nexport TOKEN="quoted-value" # inline\nURL=https://api.example.test/v1\n'), {
      TOKEN: 'quoted-value',
      URL: 'https://api.example.test/v1',
    });
    assert.throws(() => parseEnvFile('OPENAI_API_KEY="unterminated-secret'), (error) => {
      assert.match(error.message, /OPENAI_API_KEY/);
      assert.doesNotMatch(error.message, /unterminated-secret/);
      return true;
    });
  });

  it('validates the selected env file without relying on ambient database settings', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentos-live-preflight-'));
    try {
      const envFile = join(directory, 'live.env');
      await writeFile(envFile, Object.entries(validEnvironment).map(([key, value]) => `${key}=${value}`).join('\n'));
      assert.deepEqual(await runLivePreflight({
        envFile,
        env: { DATABASE_URL: 'postgresql://app:secret@db.example.test/agentos_production' },
      }), {
        requiredVariablesChecked: REQUIRED_LIVE_ENV.length,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
