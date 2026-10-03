import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assertBudgetAvailable, recordLiveLlmCalls } from './budget.mjs';

async function withBudgetState(run) {
  const directory = await mkdtemp(join(tmpdir(), 'agentos-live-budget-'));
  const budgetFile = join(directory, 'calls.json');
  try {
    await writeFile(budgetFile, '{"calls":0}\n', { mode: 0o600 });
    await run(budgetFile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('live usage deltas accumulate and stop the next scenario at the configured cap', async () => {
  await withBudgetState(async (budgetFile) => {
    const options = { budgetFile, maxCalls: '3' };
    assert.deepEqual(await assertBudgetAvailable(options), { calls: 0, limit: 3 });
    assert.equal(await recordLiveLlmCalls(2, options), 2);
    assert.deepEqual(await assertBudgetAvailable(options), { calls: 2, limit: 3 });
    await assert.rejects(assertBudgetAvailable({ ...options, maxCalls: '2' }), /LIVE_LLM_CALL_BUDGET_EXCEEDED/);
  });
});

test('live usage deltas fail clearly when a scenario crosses the cap', async () => {
  await withBudgetState(async (budgetFile) => {
    const options = { budgetFile, maxCalls: '2' };
    assert.equal(await recordLiveLlmCalls(1, options), 1);
    await assert.rejects(recordLiveLlmCalls(2, options), /LIVE_LLM_CALL_BUDGET_EXCEEDED: 3 usage records exceeded the configured cap of 2/);
    assert.deepEqual(JSON.parse(await readFile(budgetFile, 'utf8')), { calls: 3 });
  });
});

test('budget counter rejects invalid limits and non-private counter paths', async () => {
  await withBudgetState(async (budgetFile) => {
    await assert.rejects(assertBudgetAvailable({ budgetFile, maxCalls: '0' }), /LIVE_LLM_BUDGET_INVALID/);
    await assert.rejects(assertBudgetAvailable({ budgetFile: join(tmpdir(), 'calls.json'), maxCalls: '2' }), /LIVE_LLM_BUDGET_STATE_INVALID/);
  });
});
