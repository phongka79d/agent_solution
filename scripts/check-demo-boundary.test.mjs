import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { scanDemoBoundary } from './check-demo-boundary.mjs';

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'demo-boundary-'));
  temporaryRoots.push(root);
  await mkdir(join(root, 'packages/database/migrations'), { recursive: true });
  await mkdir(join(root, 'apps/api/src/runtime'), { recursive: true });
  return root;
}

describe('demo boundary checker', () => {
  it('scans canonical migration and runtime roots while excluding test files', async () => {
    const root = await fixture();
    await writeFile(join(root, 'packages/database/migrations/0000_schema.sql'), 'CREATE TABLE safe (id uuid);');
    await writeFile(join(root, 'apps/api/src/runtime/clean.ts'), 'export const tenant = input.tenant_id;');
    await writeFile(join(root, 'apps/api/src/runtime/clean.test.ts'), "const fixture = 'NovaMart';");

    const report = await scanDemoBoundary({
      rootDir: root,
      roots: ['packages/database/migrations', 'apps/api/src/runtime'],
    });
    assert.equal(report.status, 'pass');
    assert.equal(report.violations.length, 0);
    assert.equal(report.scanned_files.some((path) => path.endsWith('.test.ts')), false);
  });

  it('fails on a known tenant or brand literal in production roots', async () => {
    const root = await fixture();
    await writeFile(
      join(root, 'packages/database/migrations/0000_schema.sql'),
      "INSERT INTO tenants (tenant_id, display_name) VALUES ('99999999-9999-4999-8999-999999999999', 'NovaMart');",
    );
    await writeFile(join(root, 'apps/api/src/runtime/clean.ts'), 'export const tenant = input.tenant_id;');

    const report = await scanDemoBoundary({
      rootDir: root,
      roots: ['packages/database/migrations', 'apps/api/src/runtime'],
    });
    assert.equal(report.status, 'fail');
    assert.equal(report.violations.some((finding) => finding.path.endsWith('0000_schema.sql') && finding.identifier === 'tenant_uuid'), true);
    assert.equal(report.violations.some((finding) => finding.path.endsWith('0000_schema.sql') && finding.identifier === 'novamart_token'), true);
  });
});
