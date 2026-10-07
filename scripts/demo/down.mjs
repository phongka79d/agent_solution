#!/usr/bin/env node

import { isMainModule } from './lib/main-module.mjs';
import {
  DEFAULT_ENV_FILE,
  formatCommandFailure,
  runCommand,
  runPlan,
  verifyEnvFile,
} from './up.mjs';

const USAGE = 'Usage: pnpm demo:down [-- --env-file <path>] [--volumes]';

export function parseArgs(argv = []) {
  if (!Array.isArray(argv)) throw new TypeError('argv must be an array');

  const options = {
    envFile: DEFAULT_ENV_FILE,
    volumes: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--') continue;

    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--volumes') {
      options.volumes = true;
      continue;
    }

    const equalsIndex = argument.startsWith('--') ? argument.indexOf('=') : -1;
    const name = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex);
    const inlineValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1);
    if (name !== '--env-file') {
      throw new Error(`UNKNOWN_ARGUMENT: ${argument}. Supported: --env-file <path>, --volumes`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (typeof value !== 'string' || value.length === 0 || (inlineValue === undefined && value.startsWith('--'))) {
      throw new Error(`ARGUMENT_VALUE_REQUIRED: ${name} needs a value`);
    }
    if (inlineValue === undefined) index += 1;
    options.envFile = value;
  }

  return options;
}

export function buildPlan(options = {}) {
  const envFile = options.envFile ?? DEFAULT_ENV_FILE;
  if (typeof envFile !== 'string' || envFile.length === 0) throw new TypeError('envFile must be a non-empty string');

  return [
    {
      name: 'env-file',
      kind: 'env-file',
      envFile,
    },
    {
      name: 'docker',
      kind: 'command',
      command: 'docker',
      args: ['--version'],
      envFile,
    },
    {
      name: 'compose-down',
      kind: 'command',
      command: 'docker',
      args: ['compose', '--env-file', envFile, 'down', ...(options.volumes ? ['--volumes'] : [])],
      envFile,
    },
  ];
}

async function executeStep(step) {
  if (step.kind === 'env-file') {
    verifyEnvFile(step.envFile);
    return { ok: true };
  }

  const result = await runCommand(step.command, step.args);
  if (!result.ok) throw new Error(formatCommandFailure(result, step.envFile));
  return result;
}

export async function main(argv = process.argv.slice(2), runner = executeStep) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(USAGE);
    return;
  }
  await runPlan(buildPlan(options), runner, 'DEMO_DOWN_FAILED');
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : 'DEMO_DOWN_FAILED';
    console.error(message.startsWith('DEMO_DOWN_FAILED:') ? message : `DEMO_DOWN_FAILED: ${message}`);
    process.exitCode = 1;
  });
}
