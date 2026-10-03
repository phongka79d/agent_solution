import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';

const BUDGET_DIRECTORY_PREFIX = 'agentos-live-budget-';

function budgetPath(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('LIVE_LLM_BUDGET_STATE_MISSING: run live scenarios through pnpm test:live');
  }
  const resolvedPath = resolve(path);
  const parent = dirname(resolvedPath);
  const tempRoot = resolve(tmpdir());
  if (
    !parent.startsWith(`${tempRoot}${sep}`)
    || !basename(parent).startsWith(BUDGET_DIRECTORY_PREFIX)
    || basename(resolvedPath) !== 'calls.json'
  ) {
    throw new Error('LIVE_LLM_BUDGET_STATE_INVALID: budget state is outside its private temporary directory');
  }
  return resolvedPath;
}

function callLimit(raw) {
  const limit = Number(raw);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('LIVE_LLM_BUDGET_INVALID: LIVE_MAX_LLM_CALLS must be a positive integer');
  }
  return limit;
}

async function readState(path) {
  let state;
  try {
    state = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('LIVE_LLM_BUDGET_STATE_INVALID: cannot read live-call counter');
  }
  if (!Number.isSafeInteger(state?.calls) || state.calls < 0) {
    throw new Error('LIVE_LLM_BUDGET_STATE_INVALID: live-call counter is malformed');
  }
  return state.calls;
}

export async function assertBudgetAvailable({ budgetFile = process.env.LIVE_BUDGET_FILE, maxCalls = process.env.LIVE_MAX_LLM_CALLS } = {}) {
  const path = budgetPath(budgetFile);
  const limit = callLimit(maxCalls);
  const calls = await readState(path);
  if (calls >= limit) {
    throw new Error(`LIVE_LLM_CALL_BUDGET_EXCEEDED: ${calls} usage records reached the configured cap of ${limit}; further scenarios are aborted`);
  }
  return { calls, limit };
}

export async function recordLiveLlmCalls(addedCalls, { budgetFile = process.env.LIVE_BUDGET_FILE, maxCalls = process.env.LIVE_MAX_LLM_CALLS } = {}) {
  if (!Number.isSafeInteger(addedCalls) || addedCalls <= 0) {
    throw new Error('LIVE_LLM_BUDGET_INVALID: usage delta must be a positive integer');
  }
  const path = budgetPath(budgetFile);
  const limit = callLimit(maxCalls);
  const calls = await readState(path) + addedCalls;
  await writeFile(path, `${JSON.stringify({ calls })}\n`, { mode: 0o600 });
  if (calls > limit) {
    throw new Error(`LIVE_LLM_CALL_BUDGET_EXCEEDED: ${calls} usage records exceeded the configured cap of ${limit}; further scenarios are aborted`);
  }
  return calls;
}
