#!/usr/bin/env node
/**
 * Gate-task coverage guard for the CI pipeline
 * (`.github/workflows/production-pipeline.yml`).
 *
 * The root `package.json` scripts invoke Turborepo tasks (`test:contracts`,
 * `test:adversarial`, `test:security`) that are declared in `turbo.json`. A
 * declared task that no workspace package implements is a no-op: `turbo run`
 * reports "0 total" and exits 0, so a CI job that runs it would report a green
 * gate for a suite that never ran. `implement/09` §4 forbids claiming an
 * unexecuted gate, so this guard fails closed instead.
 *
 * Turborepo marks an unimplemented task with `command: "<NONEXISTENT>"` in
 * `--dry=json` output (pinned turbo 1.13.x); output that cannot be read also
 * fails closed rather than being treated as coverage. The same output carries
 * the requested task's dependencies, so only entries whose `task` matches the
 * argument being checked are counted as implementers.
 *
 * Usage: node scripts/require-implemented-tasks.mjs <task> [<task>...]
 */
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Turborepo's marker for a task no workspace package implements. */
const NONEXISTENT_COMMAND = '<NONEXISTENT>';

/**
 * Reads the first JSON object out of Turborepo's stdout.
 *
 * @param stdout - Raw `--dry=json` stdout.
 * @returns The parsed task graph, or `undefined` when it cannot be parsed.
 */
function parseTaskGraph(stdout) {
  const start = stdout.indexOf('{');

  if (start === -1) {
    return undefined;
  }

  try {
    return JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
}

const tasks = process.argv.slice(2);

if (tasks.length === 0) {
  console.error('TASK_REQUIRED: pass at least one Turborepo task name, e.g. `test:contracts`.');
  process.exit(1);
}

const require = createRequire(import.meta.url);
let turboBinary;

try {
  // The pinned `turbo` package exposes the CLI as a Node entry point, so the
  // guard needs neither a shell nor `pnpm` on PATH to ask Turborepo the question.
  turboBinary = require.resolve('turbo/bin/turbo');
} catch {
  console.error('TURBO_NOT_INSTALLED: run `pnpm install --frozen-lockfile` before this guard.');
  process.exit(1);
}

const unimplemented = [];

for (const task of tasks) {
  const dryRun = spawnSync(process.execPath, [turboBinary, 'run', task, '--dry=json'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  if (dryRun.status !== 0) {
    console.error(`TURBO_DRY_RUN_FAILED: \`turbo run ${task} --dry=json\` exited ${dryRun.status ?? 'unknown'}.`);
    console.error((dryRun.stderr ?? '').trim());
    unimplemented.push(task);
    continue;
  }

  const graph = parseTaskGraph(dryRun.stdout ?? '');
  const taskEntries = Array.isArray(graph?.tasks) ? graph.tasks : undefined;

  if (taskEntries === undefined) {
    console.error(`TURBO_DRY_RUN_UNREADABLE: could not read the task graph for \`${task}\`.`);
    unimplemented.push(task);
    continue;
  }

  // `--dry=json` lists dependency tasks alongside the requested one, so a
  // `dependsOn: ["^build"]` task such as `test:contracts` drags every package's
  // real `build` command into the graph. Counting the graph without narrowing it
  // to the requested task therefore reports implementers a task does not have and
  // turns this guard into a false green, so the entries are narrowed first.
  const implementers = taskEntries
    .filter((entry) => entry?.task === task)
    .filter((entry) => entry?.command !== NONEXISTENT_COMMAND)
    .map((entry) => entry.package);

  if (implementers.length === 0) {
    console.error(`GATE_TASK_UNIMPLEMENTED: no workspace package declares a \`${task}\` script.`);
    unimplemented.push(task);
    continue;
  }

  console.log(`${task}: implemented by ${implementers.length} package(s) — ${implementers.join(', ')}`);
}

if (unimplemented.length > 0) {
  console.error(
    `GATE_TASKS_MISSING: ${unimplemented.join(', ')}. Running these would report a green gate for a suite that ` +
      'never ran, so the pipeline refuses to continue. Add the suite script to the package that owns it, or remove ' +
      'the task from turbo.json and the workflow.',
  );
  process.exit(1);
}
