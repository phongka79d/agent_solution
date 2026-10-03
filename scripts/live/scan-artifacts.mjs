#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { collectRedactionValues, redactSecrets } from '../demo/up.mjs';
import { isMainModule } from '../demo/lib/main-module.mjs';
import { DEFAULT_ENV_FILE, parseEnvFile } from './preflight.mjs';

export const DEFAULT_ARTIFACTS_DIR = 'test-results/live';

async function listFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new Error('LIVE_SCAN_FAILED: cannot read live artifact directory');
  }

  const files = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('LIVE_SCAN_FAILED: symbolic links are not allowed in live artifacts');
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function scanLiveArtifacts({ envFile = DEFAULT_ENV_FILE, artifactsDir = DEFAULT_ARTIFACTS_DIR } = {}) {
  let source;
  try {
    source = await readFile(envFile, 'utf8');
  } catch {
    throw new Error(`LIVE_SCAN_FAILED: cannot read env file ${envFile}`);
  }

  const envFileValues = parseEnvFile(source);
  const secretValues = collectRedactionValues({}, envFileValues);
  if (secretValues.length === 0) throw new Error('LIVE_SCAN_FAILED: no scannable secret values found in env file');

  const files = await listFiles(resolve(artifactsDir));
  const matches = [];
  for (const file of files) {
    let contents;
    try {
      contents = await readFile(file, 'utf8');
    } catch {
      throw new Error(`LIVE_SCAN_FAILED: cannot read artifact ${relative(resolve(artifactsDir), file)}`);
    }
    if (redactSecrets(contents, secretValues) !== contents) {
      matches.push(relative(resolve(artifactsDir), file));
    }
  }

  if (matches.length > 0) {
    throw new Error(`LIVE_SCAN_FAILED: configured secrets found in ${matches.length} artifact file(s): ${matches.join(', ')}`);
  }
  return { filesScanned: files.length };
}

function parseArgs(argv) {
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  const options = { envFile: DEFAULT_ENV_FILE, artifactsDir: DEFAULT_ARTIFACTS_DIR };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--env-file' || argument === '--artifacts-dir') {
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`LIVE_SCAN_FAILED: ${argument} requires a path`);
      if (argument === '--env-file') options.envFile = value;
      else options.artifactsDir = value;
      index += 1;
    } else if (argument === '--help') {
      return { ...options, help: true };
    } else {
      throw new Error('LIVE_SCAN_FAILED: unsupported argument');
    }
  }
  return { ...options, help: false };
}

async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log('Usage: pnpm live:scan [-- --env-file <path>] [--artifacts-dir <path>]');
      return;
    }
    const result = await scanLiveArtifacts(options);
    console.log(`Live artifact scan passed (${result.filesScanned} files checked; values withheld).`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'LIVE_SCAN_FAILED');
    process.exitCode = 1;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) await main();
