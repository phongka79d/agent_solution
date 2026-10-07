#!/usr/bin/env node

import { readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIRECTORY = resolve(SCRIPT_DIRECTORY, '..', 'packages', 'database', 'migrations');
/** Migration 0008 is intentionally absent; preserve this documented historical gap. */
export const DOCUMENTED_GAP = 8;

const MIGRATION_FILENAME = /^(\d{4})(?:_|-).+\.sql$/i;

/**
 * Inspect migration filenames without touching the filesystem.
 *
 * @param {Iterable<string>} filenames
 * @returns {{ ok: boolean, numbers: number[], duplicateNumbers: number[], malformedFiles: string[], missingNumbers: number[] }}
 */
export function inspectMigrationNumbering(filenames) {
  const sqlFiles = [...filenames]
    .filter((filename) => filename.toLowerCase().endsWith('.sql'))
    .sort();
  const malformedFiles = [];
  const occurrences = new Map();

  for (const filename of sqlFiles) {
    const match = MIGRATION_FILENAME.exec(filename);
    if (!match) {
      malformedFiles.push(filename);
      continue;
    }
    const number = Number.parseInt(match[1], 10);
    const names = occurrences.get(number) ?? [];
    names.push(filename);
    occurrences.set(number, names);
  }

  const numbers = [...occurrences.keys()].sort((left, right) => left - right);
  const duplicateNumbers = numbers.filter((number) => occurrences.get(number).length > 1);
  const missingNumbers = [];
  const highestNumber = numbers.at(-1) ?? -1;

  for (let number = 0; number <= highestNumber; number += 1) {
    if (number !== DOCUMENTED_GAP && !occurrences.has(number)) missingNumbers.push(number);
  }

  return {
    ok: sqlFiles.length > 0 && duplicateNumbers.length === 0 && malformedFiles.length === 0 && missingNumbers.length === 0,
    numbers,
    duplicateNumbers,
    malformedFiles,
    missingNumbers,
  };
}

/**
 * Throw a concise, actionable error when migration numbering is unsafe.
 *
 * @param {Iterable<string>} filenames
 * @returns {ReturnType<typeof inspectMigrationNumbering>}
 */
export function assertMigrationNumbering(filenames) {
  const report = inspectMigrationNumbering(filenames);
  if (!report.ok) {
    const problems = [];
    if (report.duplicateNumbers.length > 0) {
      problems.push(`duplicate migration number(s): ${report.duplicateNumbers.map(formatNumber).join(', ')}`);
    }
    if (report.missingNumbers.length > 0) {
      problems.push(`missing migration number(s): ${report.missingNumbers.map(formatNumber).join(', ')}`);
    }
    if (report.malformedFiles.length > 0) {
      problems.push(`malformed migration filename(s): ${report.malformedFiles.join(', ')}`);
    }
    if (report.numbers.length === 0) problems.push('no SQL migration files found');
    throw new Error(problems.join('; '));
  }
  return report;
}

function formatNumber(number) {
  return String(number).padStart(4, '0');
}

export async function checkMigrationNumbering(directory = MIGRATIONS_DIRECTORY) {
  const entries = await readdir(directory, { withFileTypes: true });
  return assertMigrationNumbering(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  checkMigrationNumbering()
    .then(({ numbers }) => {
      console.log(`Migration numbering OK: ${numbers.map(formatNumber).join(', ')}`);
    })
    .catch((error) => {
      console.error(`MIGRATION_NUMBERING_FAILED: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
