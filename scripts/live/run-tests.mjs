#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isMainModule } from '../demo/lib/main-module.mjs';
import { assertBudgetAvailable } from './budget.mjs';
import { DEFAULT_ENV_FILE, parseEnvFile } from './preflight.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
async function createBudgetContext() {
  const tempRoot = resolve(tmpdir());
  const directory = await mkdtemp(join(tempRoot, 'agentos-live-budget-'));
  const context = { directory, file: join(directory, 'calls.json'), tempRoot, ownerToken: randomUUID() };
  try {
    await chmod(directory, 0o700);
    await writeFile(join(directory, '.owner'), `${context.ownerToken}\n`, { mode: 0o600 });
    await writeFile(context.file, '{"calls":0}\n', { mode: 0o600 });
    await chmod(context.file, 0o600);
    return context;
  } catch {
    await rm(directory, { recursive: true, force: true });
    throw new Error('LIVE_TEST_RUNNER_FAILED: could not initialize the private call budget');
  }
}

async function removeBudgetContext(context) {
  const directory = resolve(context.directory);
  if (
    !directory.startsWith(`${resolve(context.tempRoot)}${sep}`)
    || !basename(directory).startsWith('agentos-live-budget-')
  ) {
    throw new Error('LIVE_TEST_RUNNER_CLEANUP_REFUSED: budget directory is outside its private temporary root');
  }
  const details = await lstat(directory);
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('LIVE_TEST_RUNNER_CLEANUP_REFUSED: budget directory is not a regular directory');
  }
  const owner = await readFile(join(directory, '.owner'), 'utf8');
  if (owner !== `${context.ownerToken}\n`) {
    throw new Error('LIVE_TEST_RUNNER_CLEANUP_REFUSED: budget directory ownership check failed');
  }
  await rm(directory, { recursive: true });
}


function runNode(args, env) {
  const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, env, stdio: 'inherit' });
  if (result.error) throw new Error('LIVE_TEST_RUNNER_FAILED: could not start a Node test process');
  return result.status ?? 1;
}

export async function runLiveSuite({ envFile = process.env.LIVE_ENV_FILE ?? DEFAULT_ENV_FILE, env = process.env } = {}) {
  const absoluteEnvFile = resolve(REPO_ROOT, envFile);
  let fileValues;
  try {
    fileValues = parseEnvFile(await readFile(absoluteEnvFile, 'utf8'));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('LIVE_PREFLIGHT_FAILED:')) throw error;
    throw new Error(`LIVE_PREFLIGHT_FAILED: cannot read env file ${envFile}`);
  }
  const preflightEnv = { ...env, ...fileValues, LIVE_ENV_FILE: absoluteEnvFile };

  const preflightStatus = runNode([
    resolve(REPO_ROOT, 'scripts/live/preflight.mjs'),
    '--env-file',
    absoluteEnvFile,
  ], preflightEnv);
  if (preflightStatus !== 0) return preflightStatus;

  const budget = await createBudgetContext();
  const childEnv = { ...preflightEnv, LIVE_BUDGET_FILE: budget.file };
  try {
    const apiStatus = runNode([
      '--test',
      '--test-concurrency=1',
      'tests/live/api/*.live.test.mjs',
    ], childEnv);
    if (apiStatus !== 0) return apiStatus;

    try {
      await assertBudgetAvailable({ budgetFile: budget.file, maxCalls: childEnv.LIVE_MAX_LLM_CALLS });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('LIVE_LLM_CALL_BUDGET_EXCEEDED:')) {
        console.error(error.message);
        return 1;
      }
      throw error;
    }

    return runNode([
      'node_modules/@playwright/test/cli.js',
      'test',
      '-c',
      'tests/live/playwright.live.config.ts',
    ], childEnv);
  } finally {
    await removeBudgetContext(budget);
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  try {
    process.exitCode = await runLiveSuite();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'LIVE_TEST_RUNNER_FAILED');
    process.exitCode = 1;
  }
}
