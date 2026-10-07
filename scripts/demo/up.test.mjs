import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildBootstrapDatabaseUrl,
  buildPlan,
  formatCommandFailure,
  formatSummary,
  parseArgs,
  redactSecrets,
  runPlan,
} from './up.mjs';
import { buildPlan as buildDownPlan, parseArgs as parseDownArgs } from './down.mjs';
describe('demo:up argument parsing', () => {
  it('uses .env by default and accepts a separate env file', () => {
    assert.deepEqual(parseArgs([]), { envFile: '.env', help: false });
    assert.deepEqual(parseArgs(['--env-file', 'demo.env']), { envFile: 'demo.env', help: false });
    assert.deepEqual(parseArgs(['--', '--env-file', 'demo.env', '--help']), { envFile: 'demo.env', help: true });
  });

  it('rejects unknown arguments and missing env-file values', () => {
    assert.throws(() => parseArgs(['--unknown']), /UNKNOWN_ARGUMENT/);
    assert.throws(() => parseArgs(['--env-file']), /ARGUMENT_VALUE_REQUIRED/);
  });
});

describe('demo:down argument parsing', () => {
  it('accepts the forwarded delimiter, custom env file, and volume opt-in', () => {
    assert.deepEqual(parseDownArgs(['--', '--env-file', 'demo.env', '--volumes']), {
      envFile: 'demo.env',
      volumes: true,
      help: false,
    });
    const plan = buildDownPlan({ envFile: 'demo.env', volumes: true });
    assert.deepEqual(plan.at(-1).args, ['compose', '--env-file', 'demo.env', 'down', '--volumes']);
  });
});

describe('demo:up plan', () => {
  it('keeps startup and verification steps in order', () => {
    const plan = buildPlan({ envFile: 'demo.env' });
    assert.deepEqual(plan.map((step) => step.name), [
      'env-file',
      'docker',
      'compose-up',
      'migrate',
      'preflight',
      'seed',
      'smoke',
    ]);
    assert.deepEqual(plan[2].args, ['compose', '--env-file', 'demo.env', 'up', '-d', '--build', '--wait']);
    assert.equal(plan[4].args.at(-1), 'scripts/demo/preflight.mjs');
    assert.equal(plan[5].args.at(-1), 'scripts/demo/seed.mjs');
    assert.deepEqual(plan[3].args, ['packages/database/scripts/rehearse-migrations.mjs']);
    assert.equal(
      buildBootstrapDatabaseUrl({
        POSTGRES_USER: 'postgres',
        POSTGRES_PASSWORD: 'secret@word',
        POSTGRES_PORT: '5432',
        POSTGRES_DB: 'agentos_dev',
      }),
      'postgresql://postgres:secret%40word@127.0.0.1:5432/agentos_dev?schema=agentos',
    );
    assert.equal(plan[6].args.at(-1), 'scripts/demo/smoke.mjs');
  });
});

describe('demo:up summary', () => {
  it('prints URLs and account variable names without account values', () => {
    const env = {
      WEB_BASE_URL: 'http://localhost:3100',
      PLATFORM_ADMIN_URL: 'http://localhost:3101',
      DEMO_COMPANY_ADMIN_EMAIL: 'company@example.test',
      DEMO_COMPANY_ADMIN_PASSWORD: 'company-password-secret',
      DEMO_PLATFORM_ADMIN_EMAIL: 'platform@example.test',
      DEMO_PLATFORM_ADMIN_PASSWORD: 'platform-password-secret',
    };
    const summary = formatSummary(env);

    assert.match(summary, /Tenant console: http:\/\/localhost:3100/);
    assert.match(summary, /Platform console: http:\/\/localhost:3101/);
    for (const key of ['DEMO_COMPANY_ADMIN_EMAIL', 'DEMO_COMPANY_ADMIN_PASSWORD', 'DEMO_PLATFORM_ADMIN_EMAIL', 'DEMO_PLATFORM_ADMIN_PASSWORD']) {
      assert.match(summary, new RegExp(key));
    }
    for (const secret of Object.values(env).slice(2)) {
      assert.doesNotMatch(summary, new RegExp(secret));
    }
  });
});

describe('demo:up command diagnostics', () => {
  it('redacts secret values while preserving variable names and non-secret context', () => {
    const secret = 'platform-secret-value';
    const output = `PLATFORM_PASSWORD=${secret}\nPOSTGRES_USER=postgres\ncompose failed`;
    const redacted = redactSecrets(output, { PLATFORM_PASSWORD: secret, POSTGRES_USER: 'postgres' });
    assert.match(redacted, /PLATFORM_PASSWORD=<redacted>/);
    assert.match(redacted, /POSTGRES_USER=postgres/);
    assert.doesNotMatch(redacted, new RegExp(secret));

    const failure = formatCommandFailure({ status: 1, stderr: output }, undefined, {
      PLATFORM_PASSWORD: secret,
      POSTGRES_USER: 'postgres',
    });
    assert.match(failure, /PLATFORM_PASSWORD=<redacted>/);
    assert.match(failure, /POSTGRES_USER=postgres/);
    assert.match(`DEMO_UP_FAILED: step compose-up failed: ${failure}`, /step compose-up failed/);
    assert.doesNotMatch(failure, new RegExp(secret));
  });
});

describe('demo:up failure propagation', () => {
  it('stops at the first failed step', async () => {
    const calls = [];
    const plan = buildPlan({ envFile: 'demo.env' });

    await assert.rejects(
      runPlan(plan, async (step) => {
        calls.push(step.name);
        if (step.name === 'seed') throw new Error('seed failed');
        return { ok: true };
      }),
      /DEMO_UP_FAILED: step seed failed: seed failed/,
    );

    assert.deepEqual(calls, ['env-file', 'docker', 'compose-up', 'migrate', 'preflight', 'seed']);
  });
});
