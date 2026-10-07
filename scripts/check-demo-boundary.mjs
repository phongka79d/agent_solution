#!/usr/bin/env node
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Production-owned source roots: tests, fixtures and UI copy are intentionally outside this set. */
export const CANONICAL_ROOTS = Object.freeze([
  'packages/database/migrations',
  'apps/api/src/runtime',
  'apps/api/src/gateway',
  'apps/api/src/routes',
  'apps/worker/src/runtime',
  'packages/core-engine/src',
]);

const SOURCE_EXTENSIONS = new Set(['.js', '.mjs', '.sql', '.ts', '.tsx']);
const NOVAMART_IDENTIFIERS = Object.freeze([
  { name: 'tenant_uuid', expression: /99999999-9999-4999-8999-999999999999/gi },
  { name: 'novamart_token', expression: /\bnovamart(?:[-_][a-z0-9][a-z0-9._-]*)?\b/gi },
]);

function displayPath(path) {
  return path.split('\\').join('/');
}

function isTestPath(path) {
  return /(?:^|\/)(?:__tests__|test|tests)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$/i.test(path);
}

async function sourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(path));
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(path);
    }
  }
  return files;
}

/**
 * These literals are intentionally tied to the demo boundary. They are reported as classifications,
 * not silently ignored, so a reviewer can distinguish an approved demo seam from an accidental
 * platform/migration leak. New occurrences in the same files still fail unless they match the exact
 * source shape recorded here.
 */
function allowedReason(path, line, identifier) {
  if (
    path === 'apps/api/src/routes/v1/demo-widget.ts' &&
    identifier === 'novamart_token' &&
    /^C0[56]: 'sess-novamart-c0[56]'/.test(line.trim())
  ) {
    return 'demo widget persona session identifiers';
  }
  if (path === 'packages/database/migrations/0008_demo_novamart_bootstrap.sql') {
    return 'intentional demo tenant bootstrap migration';
  }
  if (path === 'apps/api/src/runtime/demo-auth.ts' && identifier === 'tenant_uuid' && line.includes('DEMO_TENANT_ID')) {
    return 'demo authentication tenant admission constant';
  }
  if (
    path === 'apps/worker/src/runtime/marketing/factory.ts' &&
    identifier === 'novamart_token' &&
    line.includes('NovaMart ${min_days_inactive}-day customer reactivation')
  ) {
    return 'demo marketing default instruction retained by the worker contract';
  }
  if (
    path === 'apps/worker/src/runtime/sales/revenue-evidence-adapter.ts' &&
    identifier === 'novamart_token' &&
    line.includes('novamart-demo-orders-v1')
  ) {
    return 'demo revenue evidence model identifier retained by the adapter contract';
  }
  return null;
}

function matchesInLine(line) {
  const matches = [];
  for (const descriptor of NOVAMART_IDENTIFIERS) {
    descriptor.expression.lastIndex = 0;
    let match;
    while ((match = descriptor.expression.exec(line)) !== null) {
      matches.push({
        identifier: descriptor.name,
        column: match.index + 1,
        value: match[0],
      });
      if (match[0].length === 0) descriptor.expression.lastIndex += 1;
    }
  }
  return matches.sort((left, right) => left.column - right.column || left.identifier.localeCompare(right.identifier));
}

/** Scan only canonical production roots and classify the known unavoidable demo literals. */
export async function scanDemoBoundary({ rootDir = REPO_ROOT, roots = CANONICAL_ROOTS } = {}) {
  const resolvedRoot = resolve(rootDir);
  const missingRoots = [];
  const scannedFiles = [];
  const allowedLiterals = [];
  const violations = [];

  for (const root of roots) {
    const absoluteRoot = resolve(resolvedRoot, root);
    let files;
    try {
      files = await sourceFiles(absoluteRoot);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        missingRoots.push(displayPath(root));
        continue;
      }
      throw error;
    }
    for (const file of files) {
      const relativePath = displayPath(relative(resolvedRoot, file));
      if (isTestPath(relativePath)) continue;
      scannedFiles.push(relativePath);
      const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        for (const match of matchesInLine(line)) {
          const occurrence = {
            path: relativePath,
            line: lineIndex + 1,
            column: match.column,
            identifier: match.identifier,
            value: match.value,
            source: line.trim().slice(0, 240),
          };
          const reason = allowedReason(relativePath, line, match.identifier);
          if (reason === null) {
            violations.push(occurrence);
          } else {
            allowedLiterals.push({ ...occurrence, classification: reason });
          }
        }
      }
    }
  }

  scannedFiles.sort();
  const report = {
    schema_version: 1,
    status: missingRoots.length === 0 && violations.length === 0 ? 'pass' : 'fail',
    scanned_roots: roots.map(displayPath),
    scanned_files: scannedFiles,
    missing_roots: missingRoots.sort(),
    allowed_literals: allowedLiterals,
    violations,
  };
  return report;
}

export function assertDemoBoundary(report) {
  if (report.status !== 'pass') {
    const error = new Error(`DEMO_BOUNDARY_FAILED: ${report.violations.length} unexpected literal(s), ${report.missing_roots.length} missing root(s)`);
    error.report = report;
    throw error;
  }
  return report;
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/scripts/check-demo-boundary.mjs')) {
  const json = process.argv.includes('--json');
  scanDemoBoundary().then((report) => {
    assertDemoBoundary(report);
    if (json) {
      console.log(JSON.stringify(report));
    } else {
      console.log(`Demo boundary check passed: ${JSON.stringify({
        scanned_files: report.scanned_files.length,
        allowed_literals: report.allowed_literals.length,
        violations: report.violations.length,
      })}`);
    }
  }).catch((error) => {
    if (json && error?.report) {
      console.error(JSON.stringify(error.report));
    } else {
      console.error(error instanceof Error ? error.message : 'DEMO_BOUNDARY_FAILED');
    }
    process.exitCode = 1;
  });
}
